/**
 * Codex rollout-file file-change extraction (workaround).
 *
 * The Codex SDK's typed `FileChangeItem` event only exposes `path` + `kind`
 * for each change — it does NOT carry the actual file contents the model
 * produced. So when we map an `update` change to a unified `Edit` tool block
 * and an `add` change to a `Write` block in `message-converter.ts`, the
 * `oldString` / `newString` / `content` fields would always be empty.
 *
 * The Codex CLI does write the real contents to the rollout JSONL at
 * `<codex-home>/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl` as a
 * `patch_apply_end` event, emitted just before the SDK's `file_change` item:
 *
 *   {"type":"event_msg","payload":{"type":"patch_apply_end","success":true,
 *     "changes":{
 *       "/abs/path.css": {"type":"update","unified_diff":"@@ -1,3 +1,3 @@\n …"},
 *       "/abs/new.md":   {"type":"add","content":"# New file\n…"}
 *     }}}
 *
 * We read the rollout, collect every `patch_apply_end`, and look up the
 * latest one whose change-paths match the live `FileChangeItem` so the Edit
 * and Write blocks can be filled with the real content.
 *
 * TODO(codex-sdk): once `@openai/codex-sdk` exposes per-change content on
 * `FileUpdateChange` natively (e.g. `unifiedDiff`/`content`), delete this
 * file and read directly from the SDK event in `buildFileChangePair`.
 *
 * Until then, this helper depends on an undocumented internal CLI file
 * format. If the format shifts between releases, the adapter degrades
 * gracefully to empty content (no worse than before).
 */
import fs from 'node:fs';
import { debug } from '$shared/utils/logger';
import { findRolloutFile } from './usage-rollout';

/** Content recovered from the rollout for a single changed file. */
export interface FileChangeContent {
	kind: 'add' | 'update' | 'delete';
	/** `update` only: the pre-edit text (context + removed lines). */
	oldString: string;
	/** `update` only: the post-edit text (context + added lines). */
	newString: string;
	/** `add` only: the full contents of the newly created file. */
	content: string;
}

/** One `patch_apply_end` event: absolute file path → recovered content. */
export type FileChangeSet = Map<string, FileChangeContent>;

/**
 * Shape of `payload.changes[path]` in a `patch_apply_end` rollout event.
 * Undocumented CLI-internal format — every field is treated as optional.
 */
interface RolloutFileChange {
	type?: string;
	unified_diff?: string;
	content?: string;
	move_path?: string | null;
}

/**
 * Reconstruct before/after text from a unified diff.
 *
 * Multiple hunks are concatenated (all `-`/context lines into `oldString`,
 * all `+`/context lines into `newString`) so the rendered Edit block shows
 * every change the model made in that file — even though the unified `Edit`
 * type only carries a single before/after pair. Non-adjacent hunks therefore
 * render as if they were contiguous; that is a deliberate trade-off of the
 * single-pair `Edit` shape, not a parsing bug.
 */
export function parseUnifiedDiff(unifiedDiff: string): { oldString: string; newString: string } {
	const oldLines: string[] = [];
	const newLines: string[] = [];
	let insideHunk = false;

	for (const line of unifiedDiff.split('\n')) {
		if (line.startsWith('@@')) {
			insideHunk = true;
			continue;
		}
		// `---` / `+++` / `diff --git` only count as file headers before the
		// first hunk. Inside a hunk they are real content (a removed line whose
		// text is `--`, for instance), so they must not be filtered there.
		if (!insideHunk) continue;
		// "\ No newline at end of file" is a diff annotation, not content.
		if (line.startsWith('\\')) continue;

		if (line.startsWith('-')) {
			oldLines.push(line.slice(1));
		} else if (line.startsWith('+')) {
			newLines.push(line.slice(1));
		} else {
			// Context line — carried by both sides. The CLI prefixes it with a
			// single space; blank context lines arrive as an empty string.
			const contextLine = line.startsWith(' ') ? line.slice(1) : line;
			oldLines.push(contextLine);
			newLines.push(contextLine);
		}
	}

	return { oldString: oldLines.join('\n'), newString: newLines.join('\n') };
}

/** Normalize one `payload.changes` entry into our recovered-content shape. */
function toFileChangeContent(change: RolloutFileChange): FileChangeContent | null {
	if (change.type === 'add') {
		return { kind: 'add', oldString: '', newString: '', content: change.content ?? '' };
	}
	if (change.type === 'delete') {
		return { kind: 'delete', oldString: '', newString: '', content: '' };
	}
	if (change.type === 'update') {
		const { oldString, newString } = parseUnifiedDiff(change.unified_diff ?? '');
		return { kind: 'update', oldString, newString, content: '' };
	}
	return null;
}

/**
 * Read every `patch_apply_end` event from the rollout file in chronological
 * (file) order. Each entry maps an absolute path → recovered content.
 *
 * Returns an empty array if the rollout file isn't found or the read fails —
 * callers should fall back to leaving the content fields empty.
 */
export function readFileChangeSetsFromRollout(threadId: string): FileChangeSet[] {
	const file = findRolloutFile(threadId);
	if (!file) return [];

	const changeSets: FileChangeSet[] = [];
	try {
		const content = fs.readFileSync(file, 'utf-8');
		for (const line of content.split('\n')) {
			if (!line || !line.includes('"patch_apply_end"')) continue;
			try {
				const payload = JSON.parse(line)?.payload;
				if (payload?.type !== 'patch_apply_end' || !payload.changes) continue;
				const changeSet: FileChangeSet = new Map();
				for (const [path, raw] of Object.entries(payload.changes as Record<string, RolloutFileChange>)) {
					const recovered = toFileChangeContent(raw ?? {});
					if (recovered) changeSet.set(path, recovered);
				}
				if (changeSet.size > 0) changeSets.push(changeSet);
			} catch { /* malformed line — skip */ }
		}
	} catch (err) {
		debug.warn('engine', `Codex patch-rollout: failed to read ${file}:`, err);
		return [];
	}
	return changeSets;
}

/**
 * Pick the change set that best matches the paths in the current
 * `FileChangeItem`. Walks from the end of the list (most recent first) so the
 * newest matching `patch_apply_end` wins — that's the one whose SDK
 * `file_change` event we just received.
 *
 * Reading the rollout fresh on every `file_change` keeps this correct when a
 * turn patches the same paths twice: at the time the first item arrives the
 * second patch has not been written yet, so "newest" is still the first one.
 *
 * A resumed thread replays the previous rollout history into the same file,
 * so older matches for the same paths are expected and deliberately skipped.
 *
 * "Match" = the change set covers every path in `wantedPaths`.
 * Returns `null` if nothing matches.
 */
export function findMatchingFileChangeSet(
	changeSets: FileChangeSet[],
	wantedPaths: string[],
): FileChangeSet | null {
	if (wantedPaths.length === 0) return null;
	for (let index = changeSets.length - 1; index >= 0; index--) {
		const candidate = changeSets[index];
		if (!candidate) continue;
		if (wantedPaths.every(path => candidate.has(path))) return candidate;
	}
	return null;
}
