/**
 * Workspace scope keys.
 *
 * Terminal sessions and preview tabs are keyed per workspace, not per project:
 * a worktree exists so its work stays separate, and sharing those keys with the
 * main tree would leak one task's shells and tabs into another's.
 *
 * Access is always decided on the project id, so the key stays parseable back
 * to it rather than becoming an opaque identifier of its own.
 */

/** Separator that cannot appear in a UUID, so parsing is unambiguous. */
const SCOPE_SEPARATOR = '~';

/** Key for a workspace: the project itself, or one of its worktrees. */
export function makeScopeKey(projectId: string, worktreeId?: string | null): string {
	return worktreeId ? `${projectId}${SCOPE_SEPARATOR}${worktreeId}` : projectId;
}

export function parseScopeKey(scopeKey: string): { projectId: string; worktreeId: string | null } {
	const index = scopeKey.indexOf(SCOPE_SEPARATOR);
	if (index === -1) return { projectId: scopeKey, worktreeId: null };

	return {
		projectId: scopeKey.slice(0, index),
		worktreeId: scopeKey.slice(index + SCOPE_SEPARATOR.length) || null
	};
}

/** The project a scope key belongs to — what every access check runs against. */
export function scopeProjectId(scopeKey: string): string {
	return parseScopeKey(scopeKey).projectId;
}

/** Whether `scopeKey` is any workspace of `projectId` (the project or a worktree). */
export function isScopeOfProject(scopeKey: string, projectId: string): boolean {
	return parseScopeKey(scopeKey).projectId === projectId;
}

/**
 * Short id-safe token that distinguishes one workspace from another.
 *
 * Ids generated per workspace (terminal sessions, preview tabs) are numbered
 * from 1 inside their own scope, so two scopes of the same project mint the
 * same id. Embedding this token is what keeps those numbers from colliding —
 * a collision is not cosmetic: PtyKit refuses a session id held by another
 * namespace, and the preview client matches events on tab id alone.
 */
export function scopeSlug(scopeKey: string): string {
	const { projectId, worktreeId } = parseScopeKey(scopeKey);
	const alphanumeric = (value: string) => value.replace(/[^a-zA-Z0-9]/g, '');

	const head = alphanumeric(projectId).slice(0, 8);
	if (!worktreeId) return head;
	// `w` keeps the token alphanumeric, so it survives id sanitisation.
	return `${head}w${alphanumeric(worktreeId).slice(0, 6)}`;
}
