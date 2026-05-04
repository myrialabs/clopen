/**
 * Copilot Session Fork (workaround)
 *
 * The Copilot SDK does not yet expose a native `forkSession()` API
 * (tracking issues: github/copilot-cli#1313, #1697, #2058). To support our
 * multi-branch checkpoints feature — which lets the user replay an earlier
 * point in the conversation as a sibling branch — we replicate the SDK's
 * own recommended workaround: copy the on-disk session state directory to
 * a fresh ID and patch the embedded session identifiers.
 *
 * On-disk layout (`~/.copilot/session-state/<sessionId>/`):
 *   ├── workspace.yaml      — first line is `id: <sessionId>`
 *   ├── events.jsonl        — first event is `session.start { data.sessionId }`
 *   ├── checkpoints/
 *   ├── files/
 *   └── research/
 *
 * Both `workspace.yaml#id` and the first `events.jsonl` line's
 * `data.sessionId` must be rewritten to the new ID so that resume picks the
 * fork up as an independent session.
 *
 * TODO: When @github/copilot-sdk gains a native `forkSession()` (or an
 * equivalent like `client.session.fork()`), delete this helper and switch
 * `CopilotEngine.streamQuery` to use the SDK API directly — the same way
 * the Claude adapter passes `forkSession: true` and the OpenCode adapter
 * calls `client.session.fork({ path: { id } })`.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { copyDirectory, patchFileRegex, patchJsonlFirstLine, logForkResult } from '../shared/session-fork';

const SESSION_STATE_DIR = path.join(os.homedir(), '.copilot', 'session-state');

export function getSessionStatePath(sessionId: string): string {
	return path.join(SESSION_STATE_DIR, sessionId);
}

export function sessionStateExists(sessionId: string): boolean {
	return fs.existsSync(getSessionStatePath(sessionId));
}

/**
 * Copy `sourceSessionId`'s state directory to `forkSessionId` and patch the
 * session identifiers stored inside. Returns true on success, false if the
 * source directory is missing (caller should fall back to a fresh session).
 *
 * The destination is removed first if it already exists so a re-fork from
 * the same source produces a clean copy.
 */
export function forkCopilotSessionState(sourceSessionId: string, forkSessionId: string): boolean {
	const srcDir = getSessionStatePath(sourceSessionId);
	const dstDir = getSessionStatePath(forkSessionId);

	if (!copyDirectory(srcDir, dstDir)) {
		return logForkResult('Copilot', sourceSessionId, forkSessionId, false);
	}

	// Replace the `id:` field at the top of workspace.yaml with the fork ID.
	// Targeted regex replace is safer than parsing & re-serialising YAML
	// (which would lose comments / formatting).
	patchFileRegex(
		path.join(dstDir, 'workspace.yaml'),
		/^id:\s*.*$/m,
		`id: ${forkSessionId}`,
	);

	// Rewrite `data.sessionId` on the first line of events.jsonl (the
	// `session.start` event) so the SDK's resume path treats this directory
	// as the fork's own history.
	patchJsonlFirstLine(
		path.join(dstDir, 'events.jsonl'),
		(parsed) => {
			const data = parsed.data as Record<string, unknown> | undefined;
			if (data) data.sessionId = forkSessionId;
		},
		'Copilot fork',
	);

	return logForkResult('Copilot', sourceSessionId, forkSessionId, true);
}
