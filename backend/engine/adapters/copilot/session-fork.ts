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
import { debug } from '$shared/utils/logger';

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

	if (!fs.existsSync(srcDir)) {
		debug.warn('engine', `Copilot fork: source session ${sourceSessionId} not found on disk`);
		return false;
	}

	if (fs.existsSync(dstDir)) {
		fs.rmSync(dstDir, { recursive: true, force: true });
	}

	fs.cpSync(srcDir, dstDir, { recursive: true });
	patchWorkspaceYaml(dstDir, forkSessionId);
	patchEventsJsonl(dstDir, forkSessionId);

	debug.log('engine', `Copilot fork: ${sourceSessionId} → ${forkSessionId}`);
	return true;
}

/**
 * Replace the `id:` field at the top of workspace.yaml with the fork ID.
 * The file is a small YAML map written by the SDK with one key per line, so
 * a targeted regex replace is safer than parsing & re-serialising YAML
 * (which would lose comments / formatting).
 */
function patchWorkspaceYaml(dstDir: string, forkSessionId: string): void {
	const wsPath = path.join(dstDir, 'workspace.yaml');
	if (!fs.existsSync(wsPath)) return;

	const original = fs.readFileSync(wsPath, 'utf-8');
	const patched = original.replace(/^id:\s*.*$/m, `id: ${forkSessionId}`);
	fs.writeFileSync(wsPath, patched);
}

/**
 * Rewrite `data.sessionId` on the first line of events.jsonl (the
 * `session.start` event) so the SDK's resume path treats this directory
 * as the fork's own history.
 */
function patchEventsJsonl(dstDir: string, forkSessionId: string): void {
	const evPath = path.join(dstDir, 'events.jsonl');
	if (!fs.existsSync(evPath)) return;

	const raw = fs.readFileSync(evPath, 'utf-8');
	const newlineIdx = raw.indexOf('\n');
	const firstLine = newlineIdx === -1 ? raw : raw.slice(0, newlineIdx);
	const rest = newlineIdx === -1 ? '' : raw.slice(newlineIdx);

	try {
		const parsed = JSON.parse(firstLine) as { data?: { sessionId?: string } };
		if (parsed?.data) {
			parsed.data.sessionId = forkSessionId;
			fs.writeFileSync(evPath, JSON.stringify(parsed) + rest);
		}
	} catch (err) {
		debug.warn('engine', `Copilot fork: failed to patch events.jsonl session.start (non-fatal):`, err);
	}
}
