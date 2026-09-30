/**
 * Project artifact sources — the single table of WHERE a repository keeps its
 * engine artifacts and WHICH engines read each location on their own.
 *
 * Settings shows a project's artifacts from this table, and the per-stream
 * bridge (`./bridge.ts`) uses the same `native` lists to decide what Clopen has
 * to deliver itself: an engine gets an artifact bridged only when none of the
 * locations it reads natively already carries it. One table for both keeps the
 * UI badge and the runtime behaviour from disagreeing.
 *
 * `native` describes the engine AS CLOPEN RUNS IT, not the engine's CLI in the
 * abstract. Cursor is the clearest case: its SDK scans `.agents/skills`,
 * `.cursor/rules` and friends only when `settingSources` enables the project
 * source, and Clopen leaves that unset — so Cursor reads nothing here and every
 * project artifact reaches it through Clopen. Cline is in the same position
 * because Clopen drives its stateless `Agent`, not the rule-loading core.
 *
 * Verified against the installed engines (2026-09): Claude Code 0.3.284 reads
 * `.claude/*`, `CLAUDE.md` and `.mcp.json` but NOT `.agents/skills` (the string
 * only appears in its config importer); Codex 0.147, OpenCode 1.18, Copilot and
 * Pi read `.agents/skills`; Copilot also reads `.github/skills`/`.claude/skills`.
 * Re-check these lists when an engine is upgraded.
 *
 * `.agents/` is where Clopen WRITES (`editable`). Everything else is read and
 * shown, never modified.
 */

import type { ArtifactEngine } from '../types';

export type ProjectArtifactKind = 'skill' | 'subagent' | 'instruction' | 'mcp';

/**
 * How a source is laid out on disk.
 *   - `skill-dirs`: one folder per skill, each with a `SKILL.md`.
 *   - `md-files`  : one Markdown file per artifact.
 *   - `file`      : a single file (instructions, MCP config).
 *   - `md-dir`    : a directory of rule files read as one instruction source.
 */
export type ProjectSourceLayout = 'skill-dirs' | 'md-files' | 'file' | 'md-dir';

export interface ProjectSource {
	id: string;
	kind: ProjectArtifactKind;
	/** Path relative to the repository root, `/`-separated. */
	path: string;
	layout: ProjectSourceLayout;
	/** Engines that read this location without Clopen's help. */
	native: readonly ArtifactEngine[];
	/** True for the locations Clopen writes to (`.agents/…`, the managed block of `AGENTS.md`). */
	editable?: boolean;
}

export const PROJECT_SOURCES: readonly ProjectSource[] = [
	// ── Skills ── `.agents/skills` first: it wins a slug collision everywhere.
	{ id: 'agents-skills', kind: 'skill', path: '.agents/skills', layout: 'skill-dirs', native: ['codex', 'opencode', 'copilot', 'pi'], editable: true },
	{ id: 'claude-skills', kind: 'skill', path: '.claude/skills', layout: 'skill-dirs', native: ['claude', 'opencode', 'copilot'] },
	{ id: 'opencode-skills', kind: 'skill', path: '.opencode/skills', layout: 'skill-dirs', native: ['opencode'] },
	{ id: 'opencode-skill', kind: 'skill', path: '.opencode/skill', layout: 'skill-dirs', native: ['opencode'] },
	{ id: 'github-skills', kind: 'skill', path: '.github/skills', layout: 'skill-dirs', native: ['copilot'] },
	{ id: 'pi-skills', kind: 'skill', path: '.pi/skills', layout: 'skill-dirs', native: ['pi'] },
	{ id: 'qwen-skills', kind: 'skill', path: '.qwen/skills', layout: 'skill-dirs', native: ['qwen'] },
	{ id: 'cursor-skills', kind: 'skill', path: '.cursor/skills', layout: 'skill-dirs', native: [] },

	// ── Subagents ── `.agents/agents` is Clopen's convention; no engine reads it natively.
	{ id: 'agents-agents', kind: 'subagent', path: '.agents/agents', layout: 'md-files', native: [], editable: true },
	{ id: 'claude-agents', kind: 'subagent', path: '.claude/agents', layout: 'md-files', native: ['claude'] },
	{ id: 'opencode-agents', kind: 'subagent', path: '.opencode/agents', layout: 'md-files', native: ['opencode'] },
	{ id: 'opencode-agent', kind: 'subagent', path: '.opencode/agent', layout: 'md-files', native: ['opencode'] },
	{ id: 'github-agents', kind: 'subagent', path: '.github/agents', layout: 'md-files', native: ['copilot'] },
	{ id: 'qwen-agents', kind: 'subagent', path: '.qwen/agents', layout: 'md-files', native: ['qwen'] },

	// ── Instructions ── `AGENTS.md` is the cross-engine file; Clopen edits only its managed block.
	{ id: 'agents-md', kind: 'instruction', path: 'AGENTS.md', layout: 'file', native: ['codex', 'opencode', 'copilot', 'qwen', 'pi'], editable: true },
	{ id: 'claude-md', kind: 'instruction', path: 'CLAUDE.md', layout: 'file', native: ['claude'] },
	{ id: 'qwen-md', kind: 'instruction', path: 'QWEN.md', layout: 'file', native: ['qwen'] },
	{ id: 'gemini-md', kind: 'instruction', path: 'GEMINI.md', layout: 'file', native: [] },
	{ id: 'copilot-instructions', kind: 'instruction', path: '.github/copilot-instructions.md', layout: 'file', native: ['copilot'] },
	{ id: 'cursor-rules', kind: 'instruction', path: '.cursor/rules', layout: 'md-dir', native: [] },
	{ id: 'clinerules', kind: 'instruction', path: '.clinerules', layout: 'file', native: [] },

	// ── MCP ── `.agents/mcp.json` is Clopen's convention, delivered after an admin trusts it.
	{ id: 'agents-mcp', kind: 'mcp', path: '.agents/mcp.json', layout: 'file', native: [], editable: true },
	{ id: 'root-mcp', kind: 'mcp', path: '.mcp.json', layout: 'file', native: ['claude'] }
];

/** Where Clopen writes each editable kind. */
export const PROJECT_WRITE_PATHS = {
	skills: '.agents/skills',
	subagents: '.agents/agents',
	instructions: 'AGENTS.md',
	mcp: '.agents/mcp.json'
} as const;

export function sourcesOf(kind: ProjectArtifactKind): ProjectSource[] {
	return PROJECT_SOURCES.filter(s => s.kind === kind);
}

export function sourceById(id: string): ProjectSource | undefined {
	return PROJECT_SOURCES.find(s => s.id === id);
}
