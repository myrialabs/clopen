/**
 * Project artifacts: the coverage the scanner reports is the same rule the
 * bridge delivers by, and edits never leave `.agents/` or the managed block of
 * `AGENTS.md`. Fixtures are throwaway repos under the OS temp dir.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanProject, parseProjectMcpJson, hashContent } from './scan';
import { resolveProjectBridge, buildProjectPromptContext } from './bridge';
import {
	saveProjectSkill,
	deleteProjectSkill,
	saveProjectSubagent,
	copyToAgents,
	readAgentsMd,
	saveAgentsMd,
	saveProjectMcp,
	readProjectFile
} from './edit';

let root = '';

async function put(rel: string, content: string): Promise<void> {
	const file = join(root, rel);
	await mkdir(join(file, '..'), { recursive: true });
	await writeFile(file, content, 'utf8');
}

const skillDoc = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nDo the thing.\n`;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'clopen-project-artifacts-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('scanProject coverage', () => {
	test('.agents/skills is native where engines read it and bridged elsewhere', async () => {
		await put('.agents/skills/release/SKILL.md', skillDoc('release', 'Cut a release'));
		const { skills } = await scanProject(root);
		expect(skills).toHaveLength(1);
		const [skill] = skills;
		expect(skill.editable).toBe(true);
		expect(skill.coverage.codex).toBe('native');
		expect(skill.coverage.pi).toBe('native');
		// Claude Code does not read .agents/skills; Cursor runs with its project source off.
		expect(skill.coverage.claude).toBe('bridged');
		expect(skill.coverage.cursor).toBe('bridged');
		expect(skill.coverage.cline).toBe('bridged');
	});

	test('a slug an engine already reads natively elsewhere is not bridged twice', async () => {
		await put('.agents/skills/release/SKILL.md', skillDoc('release', 'Cut a release'));
		await put('.claude/skills/release/SKILL.md', skillDoc('release', 'Cut a release (claude copy)'));
		const { skills } = await scanProject(root);
		const agents = skills.find(s => s.sourceId === 'agents-skills')!;
		const claude = skills.find(s => s.sourceId === 'claude-skills')!;
		expect(agents.coverage.claude).toBe('none');
		expect(claude.coverage.claude).toBe('native');
		expect(claude.shadowedBy).toBe('agents-skills');
	});

	test('subagents are only bridged to engines that can delegate', async () => {
		await put('.agents/agents/reviewer.md', '---\nname: reviewer\ndescription: Reviews diffs\ntools: Read, Grep\n---\n\nReview carefully.\n');
		const [sub] = (await scanProject(root)).subagents;
		expect(sub.coverage.claude).toBe('bridged');
		expect(sub.coverage.opencode).toBe('bridged');
		expect(sub.coverage.codex).toBe('none');
		expect(sub.coverage.qwen).toBe('none');
	});

	test('CLAUDE.md importing AGENTS.md makes AGENTS.md native for Claude', async () => {
		await put('AGENTS.md', 'Use bun.\n');
		let file = (await scanProject(root)).instructions.find(f => f.sourceId === 'agents-md')!;
		expect(file.coverage.claude).toBe('bridged');
		await put('CLAUDE.md', '@AGENTS.md\n');
		file = (await scanProject(root)).instructions.find(f => f.sourceId === 'agents-md')!;
		expect(file.coverage.claude).toBe('native');
	});

	test('.agents/mcp.json is only delivered once its exact content is trusted', async () => {
		const raw = JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['server'] } } });
		await put('.agents/mcp.json', raw);
		const untrusted = (await scanProject(root)).mcp.find(f => f.sourceId === 'agents-mcp')!;
		expect(untrusted.coverage.claude).toBe('none');
		const trusted = (await scanProject(root, h => h === hashContent(raw))).mcp.find(f => f.sourceId === 'agents-mcp')!;
		expect(trusted.coverage.claude).toBe('bridged');
		expect(trusted.servers[0]).toMatchObject({ name: 'fs', transport: 'stdio', command: 'npx' });
	});
});

describe('parseProjectMcpJson', () => {
	test('infers http from a url and rejects a server with neither command nor url', () => {
		expect(parseProjectMcpJson('{"mcpServers":{"api":{"url":"https://example.com/mcp"}}}')[0].transport).toBe('http');
		expect(() => parseProjectMcpJson('{"mcpServers":{"bad":{}}}')).toThrow();
	});
});

describe('resolveProjectBridge', () => {
	test('delivers only what the engine does not read natively', async () => {
		await put('.agents/skills/release/SKILL.md', skillDoc('release', 'Cut a release'));
		await put('AGENTS.md', 'Use bun.\n');

		const codex = await resolveProjectBridge('codex', root);
		expect(codex.skills).toHaveLength(0);
		expect(codex.agentsMd).toBeNull();

		const cursor = await resolveProjectBridge('cursor', root);
		expect(cursor.skills.map(s => s.slug)).toEqual(['release']);
		expect(cursor.agentsMd).toBe('Use bun.');
		const context = buildProjectPromptContext(cursor);
		expect(context).toContain('Project Skills');
		expect(context).toContain(join(root, '.agents/skills/release/SKILL.md'));
		expect(context).toContain('Use bun.');
	});
});

describe('edit in place', () => {
	test('skills are written under .agents/skills and renames move the folder', async () => {
		const saved = await saveProjectSkill(root, { name: 'Release Notes', description: 'Draft notes', body: 'Steps' });
		expect(saved.path).toBe('.agents/skills/release-notes');
		expect(await readFile(join(root, '.agents/skills/release-notes/SKILL.md'), 'utf8')).toContain('description: Draft notes');

		await saveProjectSkill(root, { originalSlug: 'release-notes', name: 'changelog', description: 'Draft notes', body: 'Steps' });
		await expect(stat(join(root, '.agents/skills/release-notes'))).rejects.toThrow();
		expect(await readFile(join(root, '.agents/skills/changelog/SKILL.md'), 'utf8')).toContain('name: changelog');

		await deleteProjectSkill(root, 'changelog');
		await expect(stat(join(root, '.agents/skills/changelog'))).rejects.toThrow();
	});

	test('saving a subagent keeps frontmatter keys it does not edit', async () => {
		await put('.agents/agents/reviewer.md', '---\nname: reviewer\ndescription: old\ncolor: blue\n---\n\nBody\n');
		await saveProjectSubagent(root, { originalSlug: 'reviewer', name: 'reviewer', description: 'new', tools: 'Read,Grep', body: 'New body' });
		const doc = await readFile(join(root, '.agents/agents/reviewer.md'), 'utf8');
		expect(doc).toContain('color: blue');
		expect(doc).toContain('tools: Read, Grep');
		expect(doc).toContain('New body');
	});

	test('copyToAgents copies (never moves) and refuses to overwrite', async () => {
		await put('.claude/skills/lint/SKILL.md', skillDoc('lint', 'Run lint'));
		await copyToAgents(root, 'skill', '.claude/skills/lint');
		expect(await readFile(join(root, '.agents/skills/lint/SKILL.md'), 'utf8')).toContain('Run lint');
		expect(await readFile(join(root, '.claude/skills/lint/SKILL.md'), 'utf8')).toContain('Run lint');
		await expect(copyToAgents(root, 'skill', '.claude/skills/lint')).rejects.toThrow();
	});

	test('AGENTS.md is read and written verbatim', async () => {
		await put('AGENTS.md', '# Team rules\n\nBe kind.\n');
		expect((await readAgentsMd(root)).content).toBe('# Team rules\n\nBe kind.\n');
		await saveAgentsMd(root, '# Team rules\n\nRun bun test first.');
		expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('# Team rules\n\nRun bun test first.');
	});

	test('empty content never creates AGENTS.md', async () => {
		await saveAgentsMd(root, '   ');
		await expect(stat(join(root, 'AGENTS.md'))).rejects.toThrow();
	});

	test('invalid .agents/mcp.json is rejected before anything is written', async () => {
		await expect(saveProjectMcp(root, '{"mcpServers":{"x":{}}}')).rejects.toThrow();
		await expect(stat(join(root, '.agents/mcp.json'))).rejects.toThrow();
	});

	test('reads stay inside the repository and only serve artifact documents', async () => {
		await put('.agents/skills/a/SKILL.md', skillDoc('a', 'A'));
		await put('secrets.env', 'TOKEN=1');
		expect(await readProjectFile(root, '.agents/skills/a')).toContain('name: a');
		await expect(readProjectFile(root, '../etc/passwd')).rejects.toThrow();
		await expect(readProjectFile(root, 'secrets.env')).rejects.toThrow();
		await symlink(join(root, 'secrets.env'), join(root, 'link.env'));
		await expect(readProjectFile(root, 'link.env')).rejects.toThrow();
	});
});
