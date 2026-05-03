/**
 * Codex rollout-file apply_patch extraction (workaround).
 *
 * The Codex SDK's typed `FileChangeItem` event only exposes `path` + `kind`
 * for each change — it does NOT carry the actual old/new file contents that
 * the model produced. So when we map an `update` change to a unified `Edit`
 * tool block in `message-converter.ts`, the `oldString` and `newString`
 * fields would always be empty.
 *
 * The Codex CLI does write the full unified-diff patch to the rollout JSONL
 * at `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl` as a
 * `custom_tool_call` with `name: "apply_patch"`. Each `apply_patch.input`
 * contains an envelope-format patch like:
 *
 *   *** Begin Patch
 *   *** Update File: <abs path>
 *   @@
 *   -old line
 *   +new line
 *   *** End Patch
 *
 * We read the rollout, parse every `apply_patch` envelope, and look up the
 * latest one whose update-paths match the live `FileChangeItem` so the Edit
 * block can be filled with real diff content.
 *
 * TODO(codex-sdk): once `@openai/codex-sdk` exposes per-change content on
 * `FileUpdateChange` natively (e.g. `oldText`/`newText`), delete this file
 * and read directly from the SDK event in `buildFileChangePair`.
 *
 * Until then, this helper depends on an undocumented internal CLI file
 * format. If the format shifts between releases, the adapter degrades
 * gracefully to empty `oldString`/`newString` (no worse than before).
 */
import fs from 'node:fs';
import { debug } from '$shared/utils/logger';
import { findRolloutFile } from './usage-rollout';

export interface FilePatch {
	oldString: string;
	newString: string;
}

/**
 * Parse one `apply_patch` envelope into a per-file map of old/new strings.
 *
 * Multiple hunks per file are concatenated (all `-`/context lines into
 * `oldString`, all `+`/context lines into `newString`) so the rendered Edit
 * block shows every change the model made — even though the unified `Edit`
 * type only carries a single before/after pair.
 *
 * Only `*** Update File:` sections are returned. `Add` and `Delete`
 * sections are ignored — those map to `Write`/`Bash` blocks elsewhere and
 * don't need diff content.
 */
export function parseApplyPatch(input: string): Map<string, FilePatch> {
	const result = new Map<string, FilePatch>();
	const lines = input.split('\n');

	let currentPath: string | null = null;
	let isUpdate = false;
	const oldBuf: string[] = [];
	const newBuf: string[] = [];

	const flush = () => {
		if (currentPath && isUpdate && (oldBuf.length || newBuf.length)) {
			result.set(currentPath, {
				oldString: oldBuf.join('\n'),
				newString: newBuf.join('\n'),
			});
		}
		currentPath = null;
		isUpdate = false;
		oldBuf.length = 0;
		newBuf.length = 0;
	};

	for (const line of lines) {
		if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) {
			if (line.startsWith('*** End Patch')) flush();
			continue;
		}
		if (line.startsWith('*** Update File: ')) {
			flush();
			currentPath = line.slice('*** Update File: '.length).trim();
			isUpdate = true;
			continue;
		}
		if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ')) {
			flush();
			continue;
		}
		if (!isUpdate) continue;
		if (line.startsWith('@@')) continue;
		if (line.startsWith('-')) {
			oldBuf.push(line.slice(1));
		} else if (line.startsWith('+')) {
			newBuf.push(line.slice(1));
		} else {
			// Context line. The CLI sometimes prefixes with a leading space,
			// sometimes leaves it bare — strip one leading space if present.
			const ctx = line.startsWith(' ') ? line.slice(1) : line;
			oldBuf.push(ctx);
			newBuf.push(ctx);
		}
	}
	flush();
	return result;
}

/**
 * Read every `apply_patch` `custom_tool_call` from the rollout file in
 * chronological (file) order. Each entry maps update-path → diff content.
 *
 * Returns an empty array if the rollout file isn't found or the read
 * fails — callers should fall back to leaving `oldString`/`newString`
 * empty.
 */
export function readApplyPatchesFromRollout(threadId: string): Array<Map<string, FilePatch>> {
	const file = findRolloutFile(threadId);
	if (!file) return [];

	const patches: Array<Map<string, FilePatch>> = [];
	try {
		const content = fs.readFileSync(file, 'utf-8');
		const lines = content.split('\n');
		for (const line of lines) {
			if (!line || !line.includes('"apply_patch"')) continue;
			try {
				const parsed = JSON.parse(line);
				const payload = parsed?.payload;
				if (
					payload?.type === 'custom_tool_call'
					&& payload.name === 'apply_patch'
					&& typeof payload.input === 'string'
				) {
					patches.push(parseApplyPatch(payload.input));
				}
			} catch { /* malformed line — skip */ }
		}
	} catch (err) {
		debug.warn('engine', `Codex patch-rollout: failed to read ${file}:`, err);
		return [];
	}
	return patches;
}

/**
 * Pick the patch from `patches` (rollout-order) that best matches the set
 * of update-paths in the current `FileChangeItem`. Walks from the end of
 * the list (most recent first) so the newest matching `apply_patch`
 * always wins — that's the one whose SDK `file_change` event we just
 * received.
 *
 * "Match" = the patch's update-path set is a superset of `wantedPaths`.
 * Returns `null` if no patch matches.
 */
export function findMatchingPatch(
	patches: Array<Map<string, FilePatch>>,
	wantedPaths: string[],
): Map<string, FilePatch> | null {
	if (wantedPaths.length === 0) return null;
	for (let i = patches.length - 1; i >= 0; i--) {
		const candidate = patches[i];
		if (!candidate) continue;
		const ok = wantedPaths.every(p => candidate.has(p));
		if (ok) return candidate;
	}
	return null;
}
