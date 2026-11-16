/**
 * How risky an agent's action is, and which routes an agent may never reach.
 *
 * Three levels, decided by what undoing it would take:
 *
 * - `read`: changes nothing.
 * - `write`: changes something Clopen can undo — files have restore points,
 *   work happens in branches and worktrees, settings can be set back.
 * - `irreversible`: cannot be taken back from inside Clopen — deleting data,
 *   force-pushing, wiping a database, sending something to another person.
 *   These go through the owner's Inbox unless the owner allowed them outright.
 *
 * The blocklist is separate and absolute: credentials, sign-in, wiping
 * Clopen, raw terminals and the browser's host bridge are never reachable by
 * an agent, whatever the owner allowed. An agent that could read a token or
 * change how Clopen signs people in could hand itself everything else.
 */

import type { ControlRisk } from '$shared/types/assistant';

/** Never reachable through `api.call`. Matched against the full route name. */
const BLOCKED_ROUTES: RegExp[] = [
	/^auth:/,
	/^system:(clear-data|run-update)$/,
	/^settings:update-system$/,
	/^(terminal|ssh):pty$/,
	/^chat:/,
	/^stream:/,
	/^session:/,
	/^ws:/,
	/^files:(read|copy-to)-os-clipboard$/,
	/^preview:browser-host-/,
	/^preview:browser-(interact|context-menu-input|dialog-input|native-picker-input|print-input|select-input|clipboard-set)$/,
	// Credentials: adding, replacing or reading secrets of agents and services.
	/^agents:[a-z]+-account(s)?-(add|update|save|setup|login)/,
	/^agents:[a-z]+-account(s)?-.*(credential|key|token)/,
	/^agents:opencode-account-update-credential$/,
	/^integrations:(connect|update|secrets-health)$/,
	/^mcp:(oauth-start|oauth-complete|install|update-config)$/,
	/^git:identity-(create|update|generate-key|delete)$/,
	/^chat-apps:(pair|unlink|set-enabled)$/,
	/^ssh:(create|update|delete|trust-host-key|forget-host-key|activate)$/,
	/^tunnel:local:(login-start|logout)$/,
	// Databases go through `db.*`, which enforces each connection's agent access.
	/^db-client:/,
	// The assistant's own state goes through the curated actions, which keep the audit.
	/^assistant:/
];

/** First word of a route's action that marks it as reading. */
const READ_FIRST = new Set([
	'get', 'list', 'status', 'read', 'search', 'describe', 'summary', 'log', 'logs', 'diff', 'tree', 'info', 'catalog',
	'stats', 'health', 'detect', 'available', 'inventory', 'state', 'check', 'remotes', 'branches', 'tags', 'identities',
	'preview', 'graph', 'node', 'forgotten', 'readiness', 'config', 'timeline', 'overview', 'providers', 'targets',
	'sources', 'labels', 'assignees', 'checks', 'states', 'presets', 'usage', 'reflog', 'explain', 'known', 'estimate'
]);

/** Action words that cannot be undone. */
const IRREVERSIBLE_WORDS = new Set([
	'delete', 'remove', 'drop', 'discard', 'force', 'reset', 'clean', 'purge', 'revoke', 'truncate', 'flush', 'uninstall',
	'kill', 'prune', 'gc', 'abort', 'merge', 'deploy', 'rewrite', 'undo', 'action', 'send'
]);

/** Whole actions that read even though a word in them looks like doing. */
const READ_ACTIONS = new Set([
	'commit-detail', 'file-content', 'pr-files', 'pr-commits', 'pr-context', 'deploy-info', 'project-status', 'tab-info',
	'tab-stats', 'tab-history', 'tabs-list', 'console-get', 'hit-test', 'cleanup-status', 'active-tab', 'tab-list',
	'device-info', 'get-release-notes', 'restore-state', 'get-state', 'stash-list', 'stash-diff', 'sftp-list', 'sftp-read',
	'sftp-stat', 'sftp-disk-usage', 'sftp-inspect-archive', 'prune-candidates', 'clean-preview', 'force-pull-preview',
	'op-states', 'operation-state', 'lock-status', 'conflict-files', 'ignored-paths', 'is-repo', 'diff-commit',
	'diff-staged', 'diff-unstaged', 'turn-changes', 'list-turn-changes', 'read-turn-file', 'get-pending-changes',
	'get-timeline', 'check-conflicts', 'remote-databases', 'repo-access', 'new-project-defaults', 'create-options',
	'parse-config', 'parse-import', 'engine-config', 'composer-state', 'stream-state', 'get-subagents', 'get-shared',
	'models-dev-list', 'presets-list', 'branch-orphans', 'branch-parents', 'branch-suggest', 'branching-state',
	'preview-transfer', 'estimate-image', 'generate-branch-name', 'generate-commit-message', 'npm-version', 'identity-usage',
	'identity-resolved', 'browse-path', 'search-code', 'search-files', 'list-tree', 'list-directory', 'read-content',
	'read-file', 'read-file-at', 'get-panel-state', 'list-shares', 'search-global'
]);

function actionOf(route: string): string {
	return route.slice(route.lastIndexOf(':') + 1);
}

export function isBlockedRoute(route: string): boolean {
	return BLOCKED_ROUTES.some((pattern) => pattern.test(route));
}

export function routeRisk(route: string): ControlRisk {
	const action = actionOf(route);
	if (READ_ACTIONS.has(action)) return 'read';
	const words = action.split('-');
	if (words.some((word) => IRREVERSIBLE_WORDS.has(word))) return 'irreversible';
	if (READ_FIRST.has(words[0])) return 'read';
	return 'write';
}

/**
 * Shell commands that cannot be undone from Clopen. Deliberately narrow: an
 * agent runs builds and tests all day, and treating every command as dangerous
 * would make the approval meaningless.
 */
const IRREVERSIBLE_COMMAND: RegExp[] = [
	/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b(?!\s+(node_modules|dist|build|\.next|\.cache|coverage|tmp)\b)/i,
	/\bgit\s+push\b.*(--force|-f\b|--force-with-lease)/,
	/\bgit\s+push\b.*\b(main|master|production|prod)\b/,
	/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/,
	/\b(drop|truncate)\s+(table|database|schema)\b/i,
	/\b(mkfs|dd\s+if=|shutdown|reboot|halt)\b/,
	/\b(npm|bun|pnpm|yarn)\s+publish\b/,
	/\bdocker\s+(system\s+prune|volume\s+rm|rm\s+-f)/,
	/\bkubectl\s+delete\b/,
	/\bcurl\b.*-X\s*(DELETE|POST|PUT|PATCH)\b.*\b(api\.|https:\/\/(?!localhost|127\.0\.0\.1))/i
];

export function commandRisk(command: string): ControlRisk {
	return IRREVERSIBLE_COMMAND.some((pattern) => pattern.test(command)) ? 'irreversible' : 'write';
}
