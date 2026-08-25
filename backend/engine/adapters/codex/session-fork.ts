/**
 * Codex Session Fork (workaround)
 *
 * The Codex SDK does not yet expose a native `forkSession()` API. To support
 * Clopen's multi-branch checkpoints feature — which lets the user replay an
 * earlier point in the conversation as a sibling branch — we copy the
 * on-disk rollout file to a fresh thread id and patch the embedded id.
 *
 * On-disk layout (`~/.codex/sessions/`):
 *
 *   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TIMESTAMP>-<thread_id>.jsonl
 *
 *   Each thread is a SINGLE JSONL file inside a date-tree, NOT a directory.
 *   The first line is `session_meta` whose `payload.id` is the thread_id.
 *   The Codex CLI's `resume <id>` walks this tree and matches the file
 *   whose name ends with `-<id>.jsonl`.
 *
 * Earlier versions of this helper assumed a directory layout
 * (`~/.codex/sessions/<thread_id>/`) and so `sessionStateExists()` always
 * returned false — the fork block was silently skipped and resume reused
 * the source thread id, breaking multi-branch checkpoints (README §10.10
 * sharp edge: "reusing the same id across turns is the symptom that
 * forking is gated or skipped").
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
import { getCodexHomeDir } from './credential';
import { debug } from '$shared/utils/logger';

const SESSION_DIR_NAME = 'sessions';

function getSessionsRoot(): string {
	return path.join(getCodexHomeDir(), SESSION_DIR_NAME);
}

/**
 * Walk the date-tree under `~/.codex/sessions/` and return the rollout
 * file whose name ends with `-<threadId>.jsonl`. Returns null when no
 * matching file is found (likely a thread that was deleted, never
 * persisted, or belongs to a different `CODEX_HOME`).
 *
 * The walk is bounded: Codex organises rollouts by date so the search
 * space is at most O(years × months × days) directories. We don't index
 * because thread ids are UUIDs — collisions are not a concern.
 */
function findRolloutFile(threadId: string): string | null {
	const root = getSessionsRoot();
	if (!fs.existsSync(root)) return null;

	const suffix = `-${threadId}.jsonl`;
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith(suffix)) {
				return full;
			}
		}
	}
	return null;
}

/**
 * Format `Date` as `YYYY-MM-DDTHH-MM-SS` (matches Codex's filename
 * timestamp — colons in ISO are replaced with dashes so the path is
 * filesystem-safe on every OS).
 */
function formatRolloutTimestamp(date: Date): string {
	const iso = date.toISOString(); // 2026-05-03T22:46:00.000Z
	return iso.slice(0, 19).replace(/:/g, '-'); // 2026-05-03T22-46-00
}

/**
 * Build the destination path for a fork: place it in the *current* day's
 * dated subdirectory, NOT the source's day. Codex's CLI doesn't care
 * which dated dir holds the rollout — it walks the whole tree on resume —
 * and stamping forks with the current date keeps "recent activity"
 * semantics intact for any tooling that orders by directory mtime.
 */
function buildForkPath(forkThreadId: string, now: Date = new Date()): string {
	const yyyy = now.getUTCFullYear().toString().padStart(4, '0');
	const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0');
	const dd = now.getUTCDate().toString().padStart(2, '0');
	const dir = path.join(getSessionsRoot(), yyyy, mm, dd);
	const filename = `rollout-${formatRolloutTimestamp(now)}-${forkThreadId}.jsonl`;
	return path.join(dir, filename);
}

export function sessionStateExists(threadId: string): boolean {
	return findRolloutFile(threadId) !== null;
}

/**
 * Copy `sourceThreadId`'s rollout file to a new file keyed by
 * `forkThreadId` and patch the embedded thread id. Returns true on
 * success, false if the source file is missing (caller falls back to a
 * fresh thread).
 *
 * The destination is removed first if it already exists so a re-fork
 * from the same source produces a clean copy.
 */
export function forkCodexSessionState(sourceThreadId: string, forkThreadId: string): boolean {
	const srcPath = findRolloutFile(sourceThreadId);
	if (!srcPath) {
		debug.warn('engine', `Codex fork: rollout for thread ${sourceThreadId} not found under ${getSessionsRoot()}`);
		return false;
	}

	const dstPath = buildForkPath(forkThreadId);
	const dstDir = path.dirname(dstPath);
	fs.mkdirSync(dstDir, { recursive: true });

	if (fs.existsSync(dstPath)) {
		fs.rmSync(dstPath, { force: true });
	}

	// UUIDs don't collide with unrelated content, so a blanket
	// search-and-replace on the source thread id is safe and avoids
	// parsing the (undocumented) JSONL schema line-by-line.
	const content = fs.readFileSync(srcPath, 'utf-8');
	const patched = content.split(sourceThreadId).join(forkThreadId);
	fs.writeFileSync(dstPath, patched);

	debug.log('engine', `Codex fork: ${sourceThreadId} → ${forkThreadId} (${dstPath})`);
	return true;
}
