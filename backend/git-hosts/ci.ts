/**
 * Rolling many CI signals on one commit into the single state a row can show.
 */

import type { CommitCiState, CommitCiStatus } from '$shared/types/git-hosting';

/** One state for a commit from every signal on it: any failure fails, any pending is pending. */
export function rollUp(sha: string, states: CommitCiState[], url: string | null): CommitCiStatus {
	if (states.length === 0) return { sha, state: 'none', url: null, summary: 'No checks' };
	const passed = states.filter((state) => state === 'success').length;
	const failed = states.filter((state) => state === 'failure').length;
	const pending = states.filter((state) => state === 'pending').length;
	const state: CommitCiState = failed > 0 ? 'failure' : pending > 0 ? 'pending' : 'success';
	const parts = [`${passed} of ${states.length} checks passed`];
	if (failed > 0) parts.push(`${failed} failed`);
	if (pending > 0) parts.push(`${pending} running`);
	return { sha, state, url, summary: parts.join(', ') };
}
