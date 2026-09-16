/**
 * Built-in tool catalog per engine — the inventory the Permissions UI offers for
 * allow/deny rules, alongside MCP tools (from Integrations) and subagent tool
 * allowlists.
 *
 * Tool NAMES must match what each engine reports at its permission hook, or a
 * deny rule silently won't match. Only Claude's names are authoritative (the
 * Agent SDK's canonical PascalCase tool names); every other engine is
 * BEST-EFFORT — the runtime hook receives the engine's own casing/aliases, and
 * these lists are a curated starting point the admin can extend with free-text
 * patterns. See {@link ENGINE_TOOLS_BEST_EFFORT}.
 *
 * Copilot is special: its permission hook decides by operation `kind`
 * (`shell` / `write` / `read` / `url` / `memory`), not by a builtin tool name,
 * so its catalog lists those kind tokens (matched in the adapter). MCP/custom
 * tools still match by `toolName`.
 */

import type { EngineType } from '$shared/types/unified';

export const ENGINE_BUILTIN_TOOLS: Record<EngineType, string[]> = {
	// Claude Code — canonical Agent SDK tool names (authoritative).
	'claude-code': [
		'Bash',
		'Edit',
		'Write',
		'Read',
		'Glob',
		'Grep',
		'WebFetch',
		'WebSearch',
		'Task',
		'NotebookEdit',
		'TodoWrite'
	],
	// OpenCode — lowercase tool ids (best-effort).
	opencode: ['bash', 'edit', 'write', 'read', 'grep', 'glob', 'list', 'webfetch', 'task', 'todowrite', 'patch'],
	// Copilot — permission KINDS, not tool names (best-effort; matched by kind).
	copilot: ['shell', 'write', 'read', 'url', 'memory'],
	// Codex — custom-prompt / core tool ids (best-effort).
	codex: ['shell', 'apply_patch', 'update_plan', 'read_file', 'web_search'],
	// Qwen Code — snake_case tool names as passed to canUseTool (best-effort).
	qwen: ['run_shell_command', 'read_file', 'write_file', 'read_many_files', 'grep', 'glob', 'ls', 'web_fetch', 'web_search'],
	// Pi — lowercase built-in tool ids, enforced at the `tool_call` extension hook.
	pi: ['bash', 'read', 'edit', 'write', 'grep', 'find', 'ls', 'ask_question'],
	// Cline — @cline/sdk default tool names, enforced via `toolPolicies` (a denied
	// tool is set `{ enabled: false }`, hiding it from the model entirely).
	cline: ['read_files', 'search_codebase', 'run_commands', 'fetch_web_content', 'apply_patch', 'editor', 'skills', 'ask_question'],
	// Cursor — names from @cursor/sdk's public tool vocabulary (`ToolName`),
	// enforced by passing the blocked set as `disallowedTools` on Agent
	// create/resume. The SDK REJECTS unknown names with a ConfigurationError, so
	// these must stay spelled exactly as the SDK spells them (`webSearch`, not
	// `web_search`). `mcp` is deliberately absent: it is a capability group whose
	// removal would also kill Clopen's in-process custom tools (AskUserQuestion),
	// so it is not offered as a per-tool target.
	cursor: [
		'shell',
		'read',
		'edit',
		'delete',
		'ls',
		'glob',
		'grep',
		'semSearch',
		'task',
		'webSearch',
		'webFetch',
		'readLints',
		'updateTodos',
		'readTodos',
		'generateImage',
		'applyAgentDiff'
	]
};

/**
 * Engines whose permission enforcement is best-effort. Only Codex — it has no
 * per-call permission hook; every other engine enforces at runtime, either at a
 * per-call surface (Claude/Qwen/Copilot/OpenCode/Pi) or by withholding the tool
 * from the model entirely (Cline `toolPolicies`, Cursor `disallowedTools`).
 */
export const ENGINE_TOOLS_BEST_EFFORT: Record<EngineType, boolean> = {
	'claude-code': false,
	opencode: false,
	copilot: false,
	codex: true,
	qwen: false,
	// Pi enforces allow/deny at the in-process `tool_call` hook (real, not best-effort).
	pi: false,
	// Cline enforces allow/deny via `toolPolicies` (`{ enabled: false }` = real).
	cline: false,
	// Cursor enforces allow/deny through `AgentOptions.disallowedTools` (a blocked
	// tool is never offered to the model) — real, not best-effort.
	cursor: false
};
