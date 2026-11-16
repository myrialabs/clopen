/**
 * The workspace from an agent's side: projects, files, the shell and git.
 *
 * Files are read and written directly, but only inside a project's folder — a
 * path that resolves outside it is refused, so an agent cannot walk into the
 * owner's home directory through `../`. Shell commands run in the project's
 * folder with a time limit and bounded output; the ones that cannot be undone
 * (see `commandRisk`) wait for approval like any irreversible action.
 */

import { t } from 'elysia';
import { fillSecretRefs } from '$backend/assistant/scrub';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'path';
import { homedir } from 'os';
import { projectQueries } from '$backend/database/queries';
import { isPathInside } from '$backend/worktrees/paths';
import { streamManager } from '$backend/chat/stream-manager';
import { isAssistantProject } from '$shared/utils/assistant-project';
import type { Project } from '$shared/types/database/schema';
import { resolveProject } from '$backend/assistant/missions';
import { ensureAssistantProject } from '$backend/assistant/project';
import { commandRisk } from '../risk';
import { defineAgentAction } from '../define';
import type { ControlContext } from '../../types';

/** The project an action names, or the caller's own when it names none (a project agent). */
function projectFor(ctx: ControlContext, ref: string | undefined): Project {
	if (ref) return resolveProject(ref);
	const own = projectQueries.getById(ctx.target.projectId);
	if (!own || isAssistantProject(own)) throw new Error('Name the project (id, name or path).');
	return own;
}

function insideProject(project: Project, path: string | undefined): string {
	const root = resolve(project.path);
	const target = path ? (isAbsolute(path) ? resolve(path) : resolve(root, path)) : root;
	if (!isPathInside(root, target)) throw new Error(`${path} is outside the project folder.`);
	return target;
}

const MAX_READ = 200_000;

export const listProjects = defineAgentAction({
	id: 'assistant.projects',
	group: 'assistant',
	title: 'List projects',
	description: 'Every project: id, name, folder, and whether an agent is working in it right now.',
	args: t.Object({}),
	risk: 'read',
	scope: 'assistant',
	async run() {
		const projects = projectQueries
			.getListed()
			.filter((project) => !isAssistantProject(project))
			.sort((a, b) => (b.last_opened_at ?? '').localeCompare(a.last_opened_at ?? ''))
			.map((project) => ({ id: project.id, name: project.name, path: project.path, busy: streamManager.hasActiveStreams(project.id) }));
		return {
			text: projects.length ? projects.map((project) => `- ${project.id} · ${project.name} · ${project.path}${project.busy ? ' · working' : ''}`).join('\n') : 'No projects yet.',
			data: { projects }
		};
	}
});

export const addProject = defineAgentAction({
	id: 'assistant.add-project',
	group: 'assistant',
	title: 'Add a project',
	description:
		'Add a folder as a project, creating the folder first when create is true. A relative path is placed under ~/Projects. Use this to start something new for the owner.',
	args: t.Object({ path: t.String({ minLength: 1 }), name: t.Optional(t.String()), create: t.Optional(t.Boolean()) }),
	risk: 'write',
	scope: 'assistant',
	example: { path: 'cafe-web', create: true },
	async run(ctx, args) {
		const raw = args.path.trim().replace(/^~(?=\/|$)/, homedir());
		const path = isAbsolute(raw) ? resolve(raw) : resolve(homedir(), 'Projects', raw);
		if (!existsSync(path)) {
			if (!args.create) throw new Error(`There is no folder at ${path}. Pass create: true to make it.`);
			mkdirSync(path, { recursive: true });
		} else if (!statSync(path).isDirectory()) {
			throw new Error(`${path} is a file, not a folder.`);
		}
		const existing = projectQueries.getAll().find((project) => resolve(project.path) === path);
		if (existing && projectQueries.isListed(existing.id)) {
			return { text: `${path} is already the project ${existing.name} (${existing.id}).`, data: { projectId: existing.id, path } };
		}
		const project = await ctx.call<Project>('projects:create', { name: args.name?.trim() || basename(path), path });
		return { text: `Added project ${project.name} (${project.id}) at ${path}.`, data: { projectId: project.id, path } };
	}
});

export const readFile = defineAgentAction({
	id: 'files.read',
	group: 'files',
	title: 'Read a file',
	description: 'Read a text file inside a project.',
	args: t.Object({ project: t.Optional(t.String()), path: t.String({ minLength: 1 }) }),
	risk: 'read',
	scope: 'assistant',
	async run(ctx, args) {
		const project = projectFor(ctx, args.project);
		const file = insideProject(project, args.path);
		if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`There is no file ${args.path}.`);
		const content = readFileSync(file, 'utf8');
		const clipped = content.length > MAX_READ ? `${content.slice(0, MAX_READ)}\n…(truncated, ${content.length} chars)` : content;
		return { text: clipped, data: { path: relative(project.path, file), size: content.length } };
	}
});

export const listFiles = defineAgentAction({
	id: 'files.list',
	group: 'files',
	title: 'List a folder',
	description: 'The entries of a folder inside a project (hidden files and node_modules left out).',
	args: t.Object({ project: t.Optional(t.String()), path: t.Optional(t.String()) }),
	risk: 'read',
	scope: 'assistant',
	async run(ctx, args) {
		const project = projectFor(ctx, args.project);
		const dir = insideProject(project, args.path);
		const entries = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules')
			.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }))
			.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
		return { text: entries.map((entry) => `${entry.type === 'directory' ? '📁' : '📄'} ${entry.name}`).join('\n') || '(empty)', data: { entries } };
	}
});

export const writeFile = defineAgentAction({
	id: 'files.write',
	group: 'files',
	title: 'Write a file',
	description: 'Create or overwrite a text file inside a project. Prefer having the project’s agent change code; use this for small files (notes, configs, briefs).',
	args: t.Object({ project: t.Optional(t.String()), path: t.String({ minLength: 1 }), content: t.String() }),
	risk: 'write',
	scope: 'assistant',
	async run(ctx, args) {
		const project = projectFor(ctx, args.project);
		const file = insideProject(project, args.path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, args.content, 'utf8');
		return { text: `Wrote ${relative(project.path, file)} (${args.content.length} chars).`, data: { path: relative(project.path, file) } };
	}
});

export const searchFiles = defineAgentAction({
	id: 'files.search',
	group: 'files',
	title: 'Search code',
	description: 'Search the text of a project’s files.',
	args: t.Object({ project: t.Optional(t.String()), query: t.String({ minLength: 1 }), regex: t.Optional(t.Boolean()) }),
	risk: 'read',
	scope: 'assistant',
	async run(ctx, args) {
		const project = projectFor(ctx, args.project);
		const results = await ctx.call<Array<{ relativePath: string; matches: Array<{ line: number; content: string }> }>>(
			'files:search-code',
			{ project_path: project.path, query: args.query, use_regex: args.regex ?? false },
			{ projectId: project.id }
		);
		const lines = results
			.slice(0, 50)
			.flatMap((result) => result.matches.slice(0, 5).map((match) => `${result.relativePath}:${match.line}: ${String(match.content).trim().slice(0, 200)}`));
		return { text: lines.join('\n') || 'No matches.', data: { files: results.length } };
	}
});

// ── Shell ──────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 1800;
const MAX_OUTPUT = 20_000;

export const runCommand = defineAgentAction({
	id: 'terminal.run',
	group: 'terminal',
	title: 'Run a command',
	description:
		'Run a shell command for a one-off job — fetch data from an API, convert or inspect a file, a quick calculation — in Clopen’s own scratch folder, and get its exit code and output. Never for project work: building, testing or changing a project is delegated. A saved secret goes in as {{secret:name}} (filled in on this machine; you never see it). Commands that cannot be undone wait for the owner’s approval.',
	args: t.Object({
		command: t.String({ minLength: 1 }),
		timeoutSeconds: t.Optional(t.Number({ minimum: 1, maximum: MAX_TIMEOUT_S }))
	}),
	risk: (args) => commandRisk(args.command),
	scope: 'assistant',
	example: { command: 'curl -s "https://api.coingecko.com/api/v3/ping"' },
	async run(_ctx, args) {
		const project = ensureAssistantProject();
		// `{{secret:name}}` becomes the saved value only here, on its way to the shell.
		const command = fillSecretRefs(args.command);
		const shell = process.platform === 'win32' ? ['cmd', '/c', command] : ['bash', '-lc', command];
		const started = Date.now();
		const proc = Bun.spawn(shell, { cwd: project.path, env: process.env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, (args.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000);
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;
		clearTimeout(timer);
		const output = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.slice(-MAX_OUTPUT);
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		return {
			text: `$ ${args.command}\n(exit ${timedOut ? 'timeout' : exitCode} · ${seconds}s · ${project.name})\n${output || '(no output)'}`,
			data: { exitCode: timedOut ? 124 : exitCode, timedOut, output }
		};
	}
});

// ── Git ────────────────────────────────────────────────────────────────────

export const gitStatus = defineAgentAction({
	id: 'git.status',
	group: 'git',
	title: 'Git status',
	description: 'Branch, staged and unstaged files of a project.',
	args: t.Object({ project: t.Optional(t.String()) }),
	risk: 'read',
	scope: 'assistant',
	async run(ctx, args) {
		const project = projectFor(ctx, args.project);
		const status = await ctx.call<Record<string, unknown>>('git:status', { projectId: project.id }, { projectId: project.id });
		const pick = (key: string) => (Array.isArray(status[key]) ? (status[key] as Array<{ path: string }>).map((file) => file.path) : []);
		return {
			text: status.isRepo
				? `Branch: ${status.branch ?? '?'}\nStaged: ${pick('staged').join(', ') || 'none'}\nUnstaged: ${pick('unstaged').join(', ') || 'none'}\nUntracked: ${pick('untracked').join(', ') || 'none'}`
				: `${project.name} is not a git repository.`,
			data: status
		};
	}
});

export const gitCommit = defineAgentAction({
	id: 'git.commit',
	group: 'git',
	title: 'Commit',
	description: 'Stage everything and commit with the given message. Follow the project’s commit conventions and the owner’s rules.',
	args: t.Object({ project: t.Optional(t.String()), message: t.String({ minLength: 1 }) }),
	risk: 'write',
	scope: 'assistant',
	async run(ctx, args) {
		const project = projectFor(ctx, args.project);
		await ctx.call('git:stage-all', { projectId: project.id }, { projectId: project.id });
		const result = await ctx.call<{ hash: string }>('git:commit', { projectId: project.id, message: args.message }, { projectId: project.id });
		return { text: `Committed ${result.hash.slice(0, 8)} in ${project.name}.`, data: result };
	}
});

export const gitBranch = defineAgentAction({
	id: 'git.branch',
	group: 'git',
	title: 'Create or switch branch',
	description: 'Switch to a branch, creating it from the current HEAD when it does not exist.',
	args: t.Object({ project: t.Optional(t.String()), name: t.String({ minLength: 1 }), create: t.Optional(t.Boolean()) }),
	risk: 'write',
	scope: 'assistant',
	async run(ctx, args) {
		const project = projectFor(ctx, args.project);
		if (args.create) await ctx.call('git:create-branch', { projectId: project.id, name: args.name }, { projectId: project.id });
		await ctx.call('git:switch-branch', { projectId: project.id, name: args.name }, { projectId: project.id });
		return { text: `${project.name} is on ${args.name}.`, data: { branch: args.name } };
	}
});

export const gitPush = defineAgentAction({
	id: 'git.push',
	group: 'git',
	title: 'Push',
	description: 'Push the current branch. Force-pushing, or pushing a main/production branch, waits for the owner’s approval.',
	args: t.Object({ project: t.Optional(t.String()), branch: t.Optional(t.String()), force: t.Optional(t.Boolean()) }),
	risk: (args) => (args.force || /^(main|master|production|prod)$/.test(args.branch ?? '') ? 'irreversible' : 'write'),
	scope: 'assistant',
	async run(ctx, args) {
		const project = projectFor(ctx, args.project);
		const result = await ctx.call<{ success: boolean; message?: string }>(
			'git:push',
			{ projectId: project.id, branch: args.branch, force: args.force ?? false, useUpstream: true },
			{ projectId: project.id }
		);
		return { text: result.success ? `Pushed ${project.name}.` : `Push failed: ${result.message ?? 'unknown reason'}`, data: result };
	}
});

export const gitLog = defineAgentAction({
	id: 'git.log',
	group: 'git',
	title: 'Recent commits',
	description: 'The latest commits of a project.',
	args: t.Object({ project: t.Optional(t.String()), limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })) }),
	risk: 'read',
	scope: 'assistant',
	async run(ctx, args) {
		const project = projectFor(ctx, args.project);
		const result = await ctx.call<{ commits: Array<{ hashShort: string; message: string; author: string; date: string }> }>(
			'git:log',
			{ projectId: project.id, limit: args.limit ?? 15 },
			{ projectId: project.id }
		);
		return { text: result.commits.map((commit) => `${commit.hashShort} ${commit.message.split('\n')[0]} (${commit.author})`).join('\n') || 'No commits.', data: result };
	}
});

/**
 * Clopen reads projects to answer questions about them, but never changes
 * one: writing files, committing, branching and pushing are project work and
 * belong to the project's agents (delegate). The actions stay defined for the
 * tests and for a future project-scoped surface; they are not registered.
 */
export const WORKSPACE_ACTIONS = [listProjects, addProject, readFile, listFiles, searchFiles, runCommand, gitStatus, gitLog];
export const UNREGISTERED_PROJECT_WRITES = [writeFile, gitCommit, gitBranch, gitPush];

/** So tests can check the folder guard without a database. */
export const __test = { insideProject: (root: string, path: string) => insideProject({ path: root } as Project, path) };
