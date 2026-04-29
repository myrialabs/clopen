/**
 * Codex Session Fork (workaround)
 *
 * The Codex SDK does not yet expose a native `forkSession()` API. To support
 * Clopen's multi-branch checkpoints feature — which lets the user replay an
 * earlier point in the conversation as a sibling branch — we copy the
 * on-disk session state directory to a fresh ID and patch any embedded
 * thread identifiers we can find.
 *
 * On-disk layout (`~/.codex/sessions/<thread_id>/`):
 *
 *   The exact file layout used by the Codex CLI is not documented in the
 *   SDK's public surface. From observation it includes JSONL rollout files
 *   and the thread id is referenced inside the directory's contents. We
 *   copy the entire directory tree, then walk every file and best-effort
 *   replace the source thread id with the fork id. This mirrors how the
 *   Copilot adapter handles its own undocumented session-state layout.
 *
 * TODO: when @openai/codex-sdk gains a native `forkSession()` (or
 * `Codex.forkThread()`), delete this helper and switch
 * `CodexEngine.streamQuery` to use the SDK API directly. The migration is
 * one line — the same pattern Claude (`forkSession: true`) and OpenCode
 * (`client.session.fork()`) already use.
 *
 * Cross-account note: `~/.codex/sessions/` is shared across ChatGPT
 * accounts. A session forked under account A is readable by account B if
 * accounts swap. That matches running the Codex CLI manually with two
 * ChatGPT accounts; we don't add isolation on top.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getCodexHomeDir } from './auth';
import { debug } from '$shared/utils/logger';

const SESSION_DIR_NAME = 'sessions';

function getSessionsRoot(): string {
	return path.join(getCodexHomeDir(), SESSION_DIR_NAME);
}

export function getSessionStatePath(threadId: string): string {
	return path.join(getSessionsRoot(), threadId);
}

export function sessionStateExists(threadId: string): boolean {
	return fs.existsSync(getSessionStatePath(threadId));
}

/**
 * Copy `sourceThreadId`'s state directory to `forkThreadId` and patch the
 * thread identifiers stored inside. Returns true on success, false if the
 * source directory is missing (caller should fall back to a fresh thread).
 *
 * The destination is removed first if it already exists so a re-fork from
 * the same source produces a clean copy.
 */
export function forkCodexSessionState(sourceThreadId: string, forkThreadId: string): boolean {
	const srcDir = getSessionStatePath(sourceThreadId);
	const dstDir = getSessionStatePath(forkThreadId);

	if (!fs.existsSync(srcDir)) {
		debug.warn('engine', `Codex fork: source session ${sourceThreadId} not found on disk`);
		return false;
	}

	if (fs.existsSync(dstDir)) {
		fs.rmSync(dstDir, { recursive: true, force: true });
	}

	fs.cpSync(srcDir, dstDir, { recursive: true });
	patchEmbeddedIds(dstDir, sourceThreadId, forkThreadId);

	debug.log('engine', `Codex fork: ${sourceThreadId} → ${forkThreadId}`);
	return true;
}

/**
 * Best-effort patch of embedded thread ids inside the forked directory.
 * Walks every regular file and replaces the source id with the fork id.
 *
 * We don't try to be surgical (specific JSON keys, specific lines) because
 * the on-disk schema is undocumented and likely to change. A blanket
 * search-and-replace on the source UUID is safe — UUIDs don't appear in
 * unrelated content.
 */
function patchEmbeddedIds(dstDir: string, sourceId: string, forkId: string): void {
	const stack = [dstDir];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			debug.warn('engine', `Codex fork: failed to read ${dir}:`, err);
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (!entry.isFile()) continue;

			try {
				const stat = fs.statSync(full);
				// Skip very large binary blobs — unlikely to contain the thread id.
				if (stat.size > 5 * 1024 * 1024) continue;

				const content = fs.readFileSync(full, 'utf-8');
				if (!content.includes(sourceId)) continue;
				const patched = content.split(sourceId).join(forkId);
				fs.writeFileSync(full, patched);
			} catch {
				// Probably a binary or unreadable file — skip.
			}
		}
	}
}
