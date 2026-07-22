export type GutterViewMode = 'ai' | 'git';

export interface AiChange {
	oldContent: string;
	newContent: string;
	timestamp: number;
	/** Stable identity of the edit (the tool_use id) used to dedupe remounts. */
	key?: string;
}

/** A single AI edit extracted from the conversation, keyed by tool_use id. */
export interface AiEditEntry {
	filePath: string;
	oldContent: string;
	newContent: string;
	key: string;
}

const changes = new Map<string, AiChange[]>();
let aiChangeListeners: Array<() => void> = [];

// Listeners for the set of file paths that have AI changes
let aiFilesListeners: Array<(paths: Set<string>) => void> = [];

function buildAiFilesSet(): Set<string> {
	const set = new Set<string>();
	for (const [path, list] of changes.entries()) {
		if (list.length > 0) set.add(path);
	}
	return set;
}

function notifyAiFilesListeners() {
	const set = buildAiFilesSet();
	for (const fn of aiFilesListeners) fn(set);
}

export function onAiFilesChange(fn: (paths: Set<string>) => void): () => void {
	aiFilesListeners.push(fn);
	// Immediately emit current state so remounting consumers get existing data
	fn(buildAiFilesSet());
	return () => {
		aiFilesListeners = aiFilesListeners.filter((l) => l !== fn);
	};
}

// Scroll-reveal signal
let pendingReveal: { path: string; editIndex: number } | null = null;

let _gutterViewMode: GutterViewMode = 'ai';
let gutterModeListeners: Array<(mode: GutterViewMode) => void> = [];

export function getGutterViewMode(): GutterViewMode {
	return _gutterViewMode;
}

export function setGutterViewMode(mode: GutterViewMode) {
	_gutterViewMode = mode;
	for (const fn of gutterModeListeners) fn(mode);
}

export function onGutterViewModeChange(fn: (mode: GutterViewMode) => void): () => void {
	gutterModeListeners.push(fn);
	return () => {
		gutterModeListeners = gutterModeListeners.filter((l) => l !== fn);
	};
}

/** Push a change and return its edit index (position in the array). */
export function addAiChange(filePath: string, oldContent: string, newContent: string, key?: string): number {
	const list = changes.get(filePath) ?? [];

	// Dedupe by stable key (the tool_use id) so a component remount — e.g. the
	// chat's virtual window mounting/unmounting tool rows on scroll — returns the
	// existing index instead of appending a duplicate. A last-entry-only compare
	// misses this whenever the file has more than one AI edit.
	if (key !== undefined) {
		const existing = list.findIndex((c) => c.key === key);
		if (existing >= 0) return existing;
	} else {
		// Fallback for keyless callers: skip only if the last entry matches exactly.
		const last = list[list.length - 1];
		if (last && last.oldContent === oldContent && last.newContent === newContent) {
			return list.length - 1;
		}
	}

	const editIndex = list.length;
	list.push({ oldContent, newContent, timestamp: Date.now(), key });
	changes.set(filePath, list);
	for (const fn of aiChangeListeners) fn();
	notifyAiFilesListeners();
	return editIndex;
}

export function getAiChanges(filePath: string): AiChange[] {
	return changes.get(filePath) ?? [];
}

/**
 * Replace the entire store with edits derived from the current conversation.
 * Grouped per file in conversation order and deduped by key. This is the single
 * source of truth now that edits are derived from `sessionState.messages` rather
 * than pushed ad-hoc from chat tool rows.
 */
export function setAiChanges(entries: AiEditEntry[]) {
	changes.clear();
	for (const entry of entries) {
		const list = changes.get(entry.filePath) ?? [];
		if (list.some((c) => c.key === entry.key)) continue;
		list.push({
			oldContent: entry.oldContent,
			newContent: entry.newContent,
			timestamp: Date.now(),
			key: entry.key
		});
		changes.set(entry.filePath, list);
	}
	for (const fn of aiChangeListeners) fn();
	notifyAiFilesListeners();
}

export function clearAiChange(filePath: string) {
	changes.delete(filePath);
	notifyAiFilesListeners();
}

export function clearAllAiChanges() {
	changes.clear();
	notifyAiFilesListeners();
}

export function onAiChange(fn: () => void): () => void {
	aiChangeListeners.push(fn);
	return () => {
		aiChangeListeners = aiChangeListeners.filter((l) => l !== fn);
	};
}

let revealListeners: Array<(path: string, editIndex: number) => void> = [];

export function requestAiScrollReveal(filePath: string, editIndex: number) {
	pendingReveal = { path: filePath, editIndex };
	for (const fn of revealListeners) fn(filePath, editIndex);
}

export function onAiScrollReveal(fn: (path: string, editIndex: number) => void): () => void {
	revealListeners.push(fn);
	return () => {
		revealListeners = revealListeners.filter((l) => l !== fn);
	};
}

/** Consume if path matches. Returns editIndex to reveal, or -1 if no match. */
export function consumeAiScrollReveal(filePath: string): number {
	if (pendingReveal && pendingReveal.path === filePath) {
		const idx = pendingReveal.editIndex;
		pendingReveal = null;
		return idx;
	}
	return -1;
}

/**
 * Index of the newest change whose newContent still appears in `content`. After a
 * checkpoint restore the on-disk file reverts, so edits made after that checkpoint
 * no longer map onto the content — this resolves "latest" to the last one that
 * still does. Returns `list.length - 1` when nothing matches (so a non-empty list
 * still yields a usable index), or -1 for an empty list.
 */
export function latestPresentChangeIndex(list: AiChange[], content: string): number {
	for (let i = list.length - 1; i >= 0; i--) {
		if (content.indexOf(list[i].newContent) >= 0) return i;
	}
	return list.length - 1;
}

export function getFilesWithAiChanges(): string[] {
	const paths: string[] = [];
	for (const [path, list] of changes.entries()) {
		if (list.length > 0) paths.push(path);
	}
	return paths;
}
