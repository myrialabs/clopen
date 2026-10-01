<script lang="ts">
	import type { FileNode } from '$shared/types/filesystem';
	import LoadingSpinner from '../common/feedback/LoadingSpinner.svelte';
	import MonacoCodeEditor from '../common/editor/MonacoCodeEditor.svelte';
	import { initMonaco } from '../common/editor/monaco-loader';
	import MediaPreview from '../common/media/MediaPreview.svelte';
	import MarkdownPreview from '../common/media/MarkdownPreview.svelte';
	import ImageEditor from './ImageEditor.svelte';
	import { themeStore } from '$frontend/stores/ui/theme.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { getFolderIcon } from '$frontend/utils/folder-icon-mappings';
	import { isImageFile, isSvgFile, isPdfFile, isAudioFile, isVideoFile, isBinaryFile, isBinaryContent, isPreviewableFile, isEditableImageFile } from '$frontend/utils/file-type';
	import { formatFileSize } from '$frontend/utils/format';
	import { fetchFileBlob, isAbortError, saveBlob } from '$frontend/utils/file-download';
	import { onMount } from 'svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import type { editor } from 'monaco-editor';
	import { debug } from '$shared/utils/logger';
	import ws from '$frontend/utils/ws';
	import { computeLineDiff, type GutterChange } from '$frontend/utils/line-diff';
	import { buildLineMap, remapHunks } from '$frontend/utils/line-map';
	import { gitStatusState } from '$frontend/stores/features/git-status.svelte';
	import { revealFile } from '$frontend/stores/ui/file-peek.svelte';
	import { aiChangesState, turnsForPath, turnId, onAiReveal, consumeAiReveal } from '$frontend/stores/features/ai-changes.svelte';
	import type { TurnChanges } from '$frontend/stores/features/ai-changes.svelte';
	import { gutterModeState, setGutterViewMode } from '$frontend/stores/ui/gutter-mode.svelte';
	import { saveShortcut } from '$frontend/utils/save-shortcut';
	import { showError } from '$frontend/stores/ui/notification.svelte';
	import { editorFontMetrics } from '$frontend/components/common/editor/editor-options';
	import { isMac } from '$frontend/utils/platform';
	import EditorHeader from '$frontend/components/common/editor/EditorHeader.svelte';
	import { saveAction, type HeaderAction, type HeaderChoice } from '$frontend/components/common/editor/header-actions';
	import {
		ChangeNavigator,
		changeOverviewRuler,
		editorHistory,
		redoIn,
		undoIn,
		NO_CHANGES,
		type ChangeControls,
		type ChangeState
	} from '$frontend/components/common/editor/editor-changes';

	// Interface untuk MonacoCodeEditor component
	interface MonacoEditorComponent {
		getEditor: () => editor.IStandaloneCodeEditor | null;
		getValue: () => string;
		setValue: (newValue: string) => void;
		getLanguage: () => string;
		setLanguage: (newLanguage: string) => void;
		detectLanguageFromFilename: (filename: string) => string;
		focus: () => void;
		layout: () => void;
		getScrollTop: () => number;
		setScrollTop: (top: number) => void;
		onDidScrollChange: (cb: (top: number) => void) => () => void;
		hasRestoredViewState: () => boolean;
	}

	interface Props {
		file: FileNode | null;
		content?: string;
		savedContent?: string;
		isLoading?: boolean;
		error?: string;
		onSave?: (filePath: string, content: string) => Promise<void>;
		hideHeader?: boolean;
		target?: { line: number; column?: number; length?: number };
		onContentChange?: (content: string) => void;
		wordWrap?: boolean;
		onToggleWordWrap?: () => void;
		externallyChanged?: boolean;
		onForceReload?: () => void;
		isBinary?: boolean;
		projectPath?: string;
		projectId?: string;
		editorScrollTop?: number;
		onEditorScroll?: (scrollTop: number) => void;
		/**
		 * When set, the header renders a close button at the end of the action bar.
		 * Used by the file-peek modal so the viewer's own header is the *only*
		 * header — the modal no longer stacks a second one above it.
		 */
		onClose?: () => void;
		/** id applied to the header's filename, so a host modal can label itself by it. */
		titleId?: string;
	}

	const {
		file = null,
		content = '',
		savedContent: savedContentProp,
		isLoading = false,
		error = '',
		onSave,
		hideHeader = false,
		target = undefined,
		onContentChange,
		wordWrap = false,
		onToggleWordWrap,
		externallyChanged = false,
		onForceReload,
		isBinary = false,
		projectPath = '',
		projectId = '',
		editorScrollTop = 0,
		onEditorScroll,
		onClose,
		titleId
	}: Props = $props();

	// Relative path for display
	const displayPath = $derived.by(() => {
		if (!file) return '';
		if (projectPath && file.path.startsWith(projectPath)) {
			return file.path.slice(projectPath.length).replace(/^[/\\]/, '');
		}
		return file.path;
	});

	// Theme state
	const isDark = $derived(themeStore.isDark);
	const monacoTheme = $derived(isDark ? 'vs-dark' : 'vs-light');
	// Force remount Monaco Editor when theme or file changes
	const themeKey = $derived(`monaco-${monacoTheme}-${file?.path || ''}`);

	// Edit state - always in edit mode (no toggle)
	let editableContent = $state('');
	let isSaving = $state(false);
	let hasChanges = $state(false);
	let hideEnvValues = $state(true);
	let revealedEnvLines = $state(new Set<number>());

	// Image editor overlay state. `imageReloadToken` is bumped after an in-place
	// save so MediaPreview re-fetches the (now changed) file at the same path.
	let showImageEditor = $state(false);
	let imageReloadToken = $state(0);
	const canEditImage = $derived(
		!!file && file.type === 'file' && isImageFile(file.name) && isEditableImageFile(file.name)
	);

	// Derived state for save button
	const canSave = $derived(hasChanges && !isSaving && !!file && !!onSave);
	const saveButtonDisabled = $derived(!canSave);

	const isEnvFile = $derived(!!file && /\.env(\.\w+)?$/i.test(file.name));
	const envViewContent = $derived.by(() => {
		if (!isEnvFile || !hideEnvValues) return editableContent;
		return editableContent.split('\n').map((line, idx) => {
			const lineNum = idx + 1;
			if (revealedEnvLines.has(lineNum)) return line;
			return line.replace(/^([\w.[\]]+\s*=\s*)(.+)$/, (_, key: string, value: string) => {
				const trimmed = value.trim();
				if (trimmed.length === 0) return line;
				return key + '█'.repeat(Math.min(Math.max(trimmed.length, 8), 48));
			});
		}).join('\n');
	});
	let monacoEditorRef: MonacoEditorComponent | null = $state(null);

	function toggleRevealLine(lineNumber: number) {
		const newSet = new Set(revealedEnvLines);
		if (newSet.has(lineNumber)) {
			newSet.delete(lineNumber);
		} else {
			newSet.add(lineNumber);
		}
		revealedEnvLines = newSet;
	}

	// Line highlighting state. `currentDecorations` holds Monaco's decoration IDs
	// so a later deltaDecorations call can remove them — kept as a plain `let`
	// (NOT $state) because the target $effect both reads and writes it. With
	// $state, every write inside applyTargetHighlight would re-trigger the
	// effect, which cancels the just-scheduled fade timer and re-runs the whole
	// highlight pipeline in a loop.
	let currentDecorations: string[] = [];
	let targetHighlightTimer: ReturnType<typeof setTimeout> | null = null;
	let targetFadeTimer: ReturnType<typeof setTimeout> | null = null;

	// Git gutter decorations + HEAD content cache
	let gutterDecorations: string[] = [];
	let aiChangeDecorations: string[] = [];
	let envDecorations: string[] = [];
	let envDecoEditor: editor.IStandaloneCodeEditor | null = null;
	let gutterChanges: GutterChange[] = [];
	let aiGutterChanges: GutterChange[] = [];
	/**
	 * Which turn's work the gutter paints:
	 * - 'latest'  → the chat's most recent turn, whether or not it touched this
	 *               file. A turn that changed nothing here paints nothing, which
	 *               is the truth; showing an older turn's work under the label
	 *               "latest" was not.
	 * - 'all'     → everything this chat did to the file, from before its first
	 *               turn to after its last
	 * - a turn id → that one turn, and only that one
	 *
	 * Scoping by turn rather than by individual tool call is what makes the
	 * gutter honest for every engine: a turn's before and after come from the
	 * checkpoint snapshot, so a file rewritten by Bash or apply_patch paints the
	 * same as one rewritten by Edit.
	 */
	let aiScope = $state<'all' | 'latest' | string>('latest');
	/**
	 * The scoped turn's own before and after, straight from the snapshot.
	 *
	 * Both sides, not just the base: diffing the base against the BUFFER would
	 * fold every later turn into this turn's answer, so turn 2 would paint turn
	 * 3 and 4's work as its own. The pair is diffed against itself and the
	 * result is then carried onto the buffer (see utils/line-map.ts).
	 *
	 * `touched: false` is a real answer — this turn left the file alone.
	 */
	let aiPair = $state<{ before: string; after: string; touched: boolean } | null>(null);
	/** What `aiPair` holds, so it is re-read only when the scope moves. */
	let aiPairKey = '';
	/** Per-turn versions already fetched for the open file, keyed path::turn. */
	const aiPairCache = new Map<string, { before: string; after: string; touched: boolean }>();
	/**
	 * A reveal request taken off the store but not yet scrolled to. It is claimed
	 * the moment it is seen because it flips the view into AI mode — but the pass
	 * that sees it is often a clearing pass, so it parks here until a pass that
	 * actually paints can scroll to it.
	 */
	let pendingAiReveal = false;
	/** Whether this chat touched the open file at all — gates the gutter toggle. */
	let hasAiChanges = $state(false);
	/** True when the scoped turn left this file alone, which the UI says out loud. */
	let aiScopeEmpty = $state(false);
	const gutterMode = $derived(gutterModeState.mode);
	let headContent = $state<string | null>(null);
	let headContentForPath = '';
	let pendingScrollRestore: number | null = null;
	let scrollListenerDispose: (() => void) | null = null;
	let gutterUpdateTimer: ReturnType<typeof setTimeout> | null = null;
	let gutterClickDispose: (() => void) | null = null;
	let activeDiffZone: {
		id: string;
		line: number;
		isAi: boolean;
		escHandler: (e: KeyboardEvent) => void;
		domNode: HTMLElement;
		scrollDispose: () => void;
		layoutDispose: () => void;
		detachSwallow: () => void;
	} | null = null;

	// Monaco MouseTargetType.GUTTER_LINE_DECORATIONS — clicks on the colored bar
	// land in the line-decorations strip (between line-numbers and content).
	const GUTTER_LINE_DECORATIONS = 4;
	const GUTTER_GLYPH_MARGIN = 5;

	// Monaco OverviewRulerLane.Right — places the marker in the scrollbar lane.
	const OVERVIEW_RULER_RIGHT = 4;

	// SVG view mode
	let svgViewMode = $state<'visual' | 'code'>('visual');

	// Markdown view mode
	let mdViewMode = $state<'visual' | 'code'>('code');
	let mdScroll = $state<{ path: string; percent: number }>({ path: '', percent: 0 });
	let pendingMdScrollPercent: number | null = null;

	function isMarkdownFile(name: string): boolean {
		const ext = name.split('.').pop()?.toLowerCase();
		return ext === 'md' || ext === 'markdown' || ext === 'mdx';
	}

	const isMarkdown = $derived(!!file && file.type === 'file' && isMarkdownFile(file.name));
	const currentMdScrollPercent = $derived(
		mdScroll.path === (file?.path || '') ? mdScroll.percent : 0
	);

	function recordMdScroll(percent: number) {
		const p = file?.path || '';
		if (!p) return;
		mdScroll = { path: p, percent };
	}

	function getMonacoScrollPercent(): number {
		const ed = monacoEditorRef?.getEditor();
		if (!ed) return currentMdScrollPercent;
		const scrollTop = ed.getScrollTop();
		const scrollHeight = ed.getScrollHeight();
		const layoutInfo = ed.getLayoutInfo();
		const max = scrollHeight - layoutInfo.height;
		if (max <= 0) return 0;
		return Math.max(0, Math.min(1, scrollTop / max));
	}

	function resolveRelativeFilePath(href: string): string | null {
		if (!file?.path) return null;
		// Strip fragment/query — only the path resolves to a file.
		const hashIdx = href.indexOf('#');
		const queryIdx = href.indexOf('?');
		let cut = href.length;
		if (hashIdx >= 0) cut = Math.min(cut, hashIdx);
		if (queryIdx >= 0) cut = Math.min(cut, queryIdx);
		const pathPart = href.slice(0, cut);
		if (!pathPart) return null;

		const sep = file.path.includes('\\') ? '\\' : '/';
		// Absolute path within the same fs style — use as-is.
		if (pathPart.startsWith('/') || /^[A-Za-z]:[\\/]/.test(pathPart)) {
			return pathPart;
		}

		const baseDir = file.path.substring(0, file.path.lastIndexOf(sep));
		const normalizedRel = pathPart.replace(/\\/g, '/');
		const combined = baseDir.replace(/\\/g, '/') + '/' + normalizedRel;
		const parts = combined.split('/');
		const resolved: string[] = [];
		for (const p of parts) {
			if (p === '..') resolved.pop();
			else if (p !== '.' && p !== '') resolved.push(p);
		}
		const isUnix = file.path.startsWith('/');
		return (isUnix ? '/' : '') + resolved.join(sep);
	}

	function handleMdFileLink(href: string) {
		const resolved = resolveRelativeFilePath(href);
		if (!resolved) return;
		revealFile(resolved);
	}

	function switchMdMode(next: 'visual' | 'code') {
		if (!isMarkdown || mdViewMode === next) return;
		if (mdViewMode === 'code') {
			recordMdScroll(getMonacoScrollPercent());
		}
		mdViewMode = next;
		if (next === 'code') {
			pendingMdScrollPercent = currentMdScrollPercent;
		}
	}

	// Ctrl/Cmd+S goes through the shared save shortcut on the root element (see
	// the template): a window listener of our own never fired inside a dialog,
	// and fired for every open viewer at once outside one.
	function saveFromShortcut() {
		if (canSave) saveChanges();
	}

	onMount(() => {
		return () => {
			changeNav?.dispose();
			changeNav = null;
			if (gutterUpdateTimer) clearTimeout(gutterUpdateTimer);
			clearTargetTimers();
			scrollListenerDispose?.();
			scrollListenerDispose = null;
			gutterClickDispose?.();
			gutterClickDispose = null;
			if (activeDiffZone) {
				window.removeEventListener('keydown', activeDiffZone.escHandler, true);
				activeDiffZone.scrollDispose();
				activeDiffZone.layoutDispose();
				activeDiffZone.detachSwallow();
				activeDiffZone = null;
			}
		};
	});

	// Reference content for change detection (use savedContent if provided)
	const referenceContent = $derived(savedContentProp !== undefined ? savedContentProp : content);

	// Sync editable content when file or content changes (not when user types)
	let lastSyncedContent = '';
	let lastSyncedFilePath = '';
	let scrollRestoredForPath = '';
	$effect(() => {
		const currentFilePath = file?.path || '';
		// Force sync when file changes OR when content changes
		if (content !== lastSyncedContent || currentFilePath !== lastSyncedFilePath) {
			const isFileSwitch = currentFilePath !== lastSyncedFilePath;
			lastSyncedContent = content;
			lastSyncedFilePath = currentFilePath;
			editableContent = content;
			hasChanges = content !== referenceContent;

			// Directly update Monaco editor to ensure content syncs
			// (bypasses reactive bind:value chain which may not flush in async contexts)
			const editor = monacoEditorRef?.getEditor();
			if (editor && editor.getValue() !== content) {
				editor.setValue(content);
			}

			// On file switch, mark this file's scroll position as needing restore.
			if (isFileSwitch) {
				scrollRestoredForPath = '';
			}

			// Apply scroll restore once content is non-empty and we haven't
			// applied yet for this file. Restoring on an empty editor is a no-op
			// because Monaco's scrollHeight is zero before lines render.
			if (
				currentFilePath &&
				currentFilePath !== scrollRestoredForPath &&
				content &&
				editorScrollTop > 0 &&
				// Don't fight a search-result jump: when a target line is set, the
				// target effect reveals it. Restoring the saved scroll here (which
				// can fire AFTER the reveal once content loads late) is exactly what
				// snapped the editor back to the top.
				target === undefined &&
				// Don't fight the editor's own (richer) view-state restore.
				!monacoEditorRef?.hasRestoredViewState?.()
			) {
				scrollRestoredForPath = currentFilePath;
				const restoreTo = editorScrollTop;
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						monacoEditorRef?.setScrollTop(restoreTo);
					});
				});
			} else if (currentFilePath && currentFilePath !== scrollRestoredForPath && content) {
				// Nothing to restore (or a target reveal owns positioning) — mark as
				// resolved so subsequent typing doesn't re-trigger the check.
				scrollRestoredForPath = currentFilePath;
			}

			// Refresh gutter on content sync (debounced)
			scheduleGutterUpdate();
		}
	});

	// Fetch HEAD content for the active file (used by the git gutter diff)
	$effect(() => {
		const path = file?.path || '';
		if (!path || !projectId) {
			headContent = null;
			headContentForPath = '';
			resetAiScope();
			setGutterViewMode('git');
			closeDiffPeek();
			return;
		}
		if (path === headContentForPath) return;
		headContentForPath = path;
		headContent = null;
		resetAiScope();
		setGutterViewMode('git');
		closeDiffPeek();

		// Only fetch when git is tracking this file
		if (!gitStatusState.isRepo) return;

		ws.http('files:read-file-at', { projectId, rootPath: projectPath, filePath: path, ref: 'HEAD' })
			.then((res) => {
				if (file?.path !== path) return; // file changed mid-flight
				headContent = res.content;
				scheduleGutterUpdate();
			})
			.catch(() => {
				if (file?.path !== path) return;
				headContent = null;
			});
	});

	// Recompute gutter when git status (i.e. HEAD reference) changes — this
	// triggers when the user commits, stages, or otherwise mutates the working tree
	$effect(() => {
		// Track gitStatusState identity so the effect re-runs on refresh
		void gitStatusState.map;
		void gitStatusState.isRepo;
		// Force re-fetch of HEAD next render cycle by clearing the cache key
		const path = file?.path || '';
		if (path && headContentForPath === path && projectId) {
			ws.http('files:read-file-at', { projectId, rootPath: projectPath, filePath: path, ref: 'HEAD' })
				.then((res) => {
					if (file?.path !== path) return;
					headContent = res.content;
					scheduleGutterUpdate();
				})
				.catch(() => {});
		}
	});

	// React to gutter view mode changes (AI vs Git)
	$effect(() => {
		const mode = gutterMode;
		const editor = monacoEditorRef?.getEditor();
		if (!editor) return;
		if (mode === 'ai') {
			applyAiChangeDecorations();  // re-apply AI gutter
			updateGutterDecorations(true); // clear git gutter
		} else {
			applyAiChangeDecorations(true); // clear AI gutter
			scheduleGutterUpdate();
			if (activeDiffZone && activeDiffZone.isAi) {
				closeDiffPeek();
			}
		}
	});


	function selectAiScope(next: 'all' | 'latest' | string) {
		setGutterViewMode('ai');
		aiScope = next;
		void ensureAiPair().then(() => {
			applyAiChangeDecorations();
			// Move an open peek onto the new scope's first hunk (or close it if the
			// new scope has none) so the peek never outlives what it describes.
			refreshActiveDiffPeek();
		});
	}

	/** Reset the AI view to its default scope. */
	function resetAiScope() {
		aiScope = 'latest';
		aiPair = null;
		aiPairKey = '';
		aiPairCache.clear();
		aiScopeEmpty = false;
		pendingAiReveal = false;
	}

	/**
	 * Take a pending reveal, if one is aimed at this file.
	 *
	 * Claimed here rather than at paint time because it moves the scope, and the
	 * content is fetched from the scope — resolving them in the wrong order
	 * fetched the previous scope's versions and the reveal landed on the wrong
	 * turn.
	 */
	function claimAiReveal() {
		const path = file?.path || '';
		if (!path) return;
		const revealTurn = consumeAiReveal(path);
		if (revealTurn === null) return;

		aiScope = chatTurns.some((turn) => turnId(turn) === revealTurn) ? revealTurn : 'latest';
		pendingAiReveal = true;
		setGutterViewMode('ai');
	}

	/**
	 * Every turn of this chat, newest first — not only the ones that touched this
	 * file.
	 *
	 * The menu lists all of them on purpose. A file whose turns were filtered out
	 * offered a different menu from the file next to it, and "Latest turn" on
	 * such a file quietly meant "latest turn that happened to touch this one".
	 */
	const chatTurns = $derived.by(() => {
		void aiChangesState.byPath;
		return aiChangesState.turns;
	});

	/** Turns that actually changed the open file, newest first. */
	const fileTurns = $derived.by(() => {
		void aiChangesState.byPath;
		const path = file?.path || '';
		return path ? turnsForPath(path) : [];
	});

	/** Which turns a menu row is offered for — all of them, marked or not. */
	function turnTouchedFile(turn: TurnChanges): boolean {
		return fileTurns.some((candidate) => turnId(candidate) === turnId(turn));
	}

	/** How the current scope is named in prose. */
	const aiScopeLabel = $derived.by(() => {
		if (aiScope === 'all') return 'This chat';
		const turn = chatTurns.find((candidate) => turnId(candidate) === aiScope);
		if (aiScope === 'latest' || !turn) {
			const latest = chatTurns[0];
			if (!latest) return 'This turn';
			return latest.turnIndex === null ? 'The running turn' : `Turn ${latest.turnIndex}`;
		}
		return turn.turnIndex === null ? 'The running turn' : `Turn ${turn.turnIndex}`;
	});

	/** The turn a non-'all' scope points at, or null when there is none. */
	function scopedTurn(): TurnChanges | null {
		if (chatTurns.length === 0) return null;
		if (aiScope === 'latest') return chatTurns[0];
		if (aiScope === 'all') return null;
		return chatTurns.find((turn) => turnId(turn) === aiScope) ?? chatTurns[0];
	}

	/**
	 * One turn's before/after for the open file, fetched once and remembered.
	 *
	 * A turn that left the file alone answers `touched: false` rather than an
	 * error — it is a fact about the turn, and the gutter says so.
	 */
	async function fetchTurnVersions(
		path: string,
		turn: TurnChanges
	): Promise<{ before: string; after: string; touched: boolean } | null> {
		// A settled turn's versions are fixed forever; the running turn's are not,
		// so it is never cached — it is the one thing on screen that is still moving.
		const settled = turn.checkpointMessageId !== null;
		const cacheKey = `${path}::${turnId(turn)}`;
		const cached = settled ? aiPairCache.get(cacheKey) : undefined;
		if (cached) return cached;

		try {
			const response = await ws.http('snapshot:read-turn-file', {
				filePath: path,
				...(turn.checkpointMessageId
					? { messageId: turn.checkpointMessageId }
					: { sessionId: aiChangesState.sessionId ?? '' })
			});
			const versions =
				response.status === 'unchanged' || response.before === null || response.after === null
					? { before: '', after: '', touched: false }
					: { before: response.before, after: response.after, touched: true };
			if (settled) aiPairCache.set(cacheKey, versions);
			return versions;
		} catch {
			return null;
		}
	}

	/**
	 * The running turn's stamp, when the current scope looks at it — otherwise ''.
	 * Settled turns never change, so they contribute nothing and stay cached.
	 */
	function runningTurnStamp(): string {
		const running = chatTurns.find((turn) => turn.checkpointMessageId === null);
		if (!running) return '';
		const inScope =
			aiScope === 'latest'
				? chatTurns[0] === running
				: aiScope === 'all'
					? fileTurns[0] === running
					: aiScope === turnId(running);
		return inScope ? running.timestamp : '';
	}

	/** Resolve the current scope to a before/after pair, once per scope. */
	async function ensureAiPair(): Promise<void> {
		claimAiReveal();

		const path = file?.path || '';
		// The running turn's timestamp moves every time the store re-reads it, so
		// including it is what lets a scope pointing at that turn refresh while
		// every settled scope stays resolved once.
		const key = `${path}::${aiScope}::${runningTurnStamp()}`;
		// The key is claimed before the request so a repeat pass does not fire a
		// second one. "This turn changed nothing" is an answer too, and asking
		// again every pass would be a request loop.
		if (aiPairKey === key) return;
		aiPairKey = key;

		if (!path || chatTurns.length === 0) {
			aiPair = null;
			return;
		}

		try {
			if (aiScope === 'all') {
				// Everything this chat did to the file: from before the first turn
				// that touched it, to after the last one that did.
				if (fileTurns.length === 0) {
					aiPair = { before: '', after: '', touched: false };
					return;
				}
				const newest = fileTurns[0];
				const oldest = fileTurns[fileTurns.length - 1];
				const first = await fetchTurnVersions(path, oldest);
				const last = newest === oldest ? first : await fetchTurnVersions(path, newest);
				if (aiPairKey !== key) return;
				aiPair =
					first && last && first.touched && last.touched
						? { before: first.before, after: last.after, touched: true }
						: null;
				return;
			}

			const turn = scopedTurn();
			if (!turn) {
				aiPair = null;
				return;
			}
			const versions = await fetchTurnVersions(path, turn);
			if (aiPairKey !== key) return;
			aiPair = versions;
		} finally {
			// Release the key on failure so a later pass can retry: a failed request
			// says nothing about the file, unlike a "changed nothing" answer.
			if (aiPairKey === key && aiPair === null) aiPairKey = '';
		}
	}

	/**
	 * Paint the gutter with what the scoped turn did to this file.
	 *
	 * Two diffs, not one. The turn's own before against its own after says what
	 * that turn changed — diffing against the buffer instead would hand turn 2
	 * credit for turn 3 and 4's work. The result is then carried onto the buffer
	 * through the diff between the turn's after and what is on screen now, so a
	 * hunk lands where its lines actually live and disappears if they are gone.
	 */
	function applyAiChangeDecorations(forceClear = false) {
		const editor = monacoEditorRef?.getEditor();
		if (!editor) return;

		const clear = () => {
			aiChangeDecorations = editor.deltaDecorations(aiChangeDecorations, []);
			setAiChanges([]);
		};

		const path = file?.path || '';
		if (!path) {
			clear();
			hasAiChanges = false;
			aiScopeEmpty = false;
			return;
		}

		hasAiChanges = fileTurns.length > 0;

		// The pinned turn can disappear when a restore moves the active path —
		// fall back rather than painting an empty gutter forever.
		if (
			aiScope !== 'all' &&
			aiScope !== 'latest' &&
			!chatTurns.some((turn) => turnId(turn) === aiScope)
		) {
			aiScope = 'latest';
			aiPairKey = '';
		}

		if (forceClear || gutterMode === 'git') {
			clear();
			aiScopeEmpty = false;
			return;
		}

		// "This turn changed nothing here" is a result worth stating; a failed or
		// pending read is not, and stays silent.
		aiScopeEmpty = hasAiChanges && aiPair !== null && !aiPair.touched;

		if (!aiPair || !aiPair.touched) {
			clear();
			return;
		}

		const changes = remapHunks(
			computeLineDiff(aiPair.before, aiPair.after),
			buildLineMap(computeLineDiff(aiPair.after, editableContent))
		);

		const newDecorations = changes.map((change) => ({
			range: {
				startLineNumber: change.startLine,
				startColumn: 1,
				endLineNumber: change.endLine,
				endColumn: 1
			},
			options: {
				isWholeLine: false,
				linesDecorationsClassName: `ai-gutter-${change.type}`,
				overviewRuler: changeOverviewRuler(change.type, isDark)
			}
		}));

		setAiChanges(changes);
		aiChangeDecorations = editor.deltaDecorations(aiChangeDecorations, newDecorations);

		if (pendingAiReveal) {
			pendingAiReveal = false;
			if (aiGutterChanges.length > 0) {
				const targetChange = aiGutterChanges[0];
				requestAnimationFrame(() => {
					editor.revealLineInCenter(targetChange.startLine);
					editor.setPosition({ lineNumber: targetChange.startLine, column: 1 });
					editor.focus();
					showDiffPeek(targetChange, true);
				});
			}
		}
	}

	// Repaint whenever the store re-reads the conversation's turns — a stream
	// event, a captured snapshot, or a checkpoint restore.
	$effect(() => {
		void aiChangesState.byPath;
		void file?.path;
		void ensureAiPair().then(() => applyAiChangeDecorations());
	});

	onMount(() => {
		return onAiReveal((request) => {
			if (request.absolutePath !== (file?.path || '')) return;
			void ensureAiPair().then(() => applyAiChangeDecorations());
		});
	});

	function scheduleGutterUpdate() {
		if (gutterUpdateTimer) clearTimeout(gutterUpdateTimer);
		gutterUpdateTimer = setTimeout(() => {
			gutterUpdateTimer = null;
			updateGutterDecorations();
		}, 200);
	}

	function updateGutterDecorations(forceClear = false) {
		const editor = monacoEditorRef?.getEditor();
		if (!editor) return;

		if (forceClear || gutterMode === 'ai') {
			setGitChanges([]);
			gutterDecorations = editor.deltaDecorations(gutterDecorations, []);
			if (activeDiffZone && !activeDiffZone.isAi) {
				closeDiffPeek();
			}
			return;
		}

		// No HEAD content (untracked, missing repo) — clear any existing gutter
		if (headContent === null || headContent === undefined) {
			setGitChanges([]);
			gutterDecorations = editor.deltaDecorations(gutterDecorations, []);
			if (activeDiffZone && !activeDiffZone.isAi) {
				closeDiffPeek();
			}
			return;
		}

		const changes = computeLineDiff(headContent, editableContent);
		setGitChanges(changes);

		// Close any open peek whose anchor line is no longer marked as changed
		if (activeDiffZone && !activeDiffZone.isAi) {
			const stillExists = changes.some(
				(c) => activeDiffZone!.line >= c.startLine && activeDiffZone!.line <= c.endLine
			);
			if (!stillExists) closeDiffPeek();
		}

		const newDecorations = changes.map((change) => {
			return {
				range: {
					startLineNumber: change.startLine,
					startColumn: 1,
					endLineNumber: change.endLine,
					endColumn: 1
				},
				options: {
					isWholeLine: false,
					linesDecorationsClassName:
						change.type === 'added'
							? 'git-gutter-added'
							: change.type === 'modified'
								? 'git-gutter-modified'
								: 'git-gutter-deleted',
					overviewRuler: changeOverviewRuler(change.type, isDark)
				}
			};
		});
		gutterDecorations = editor.deltaDecorations(gutterDecorations, newDecorations);
	}

	function findChangeAtLine(line: number): { change: GutterChange; isAi: boolean } | null {
		for (const change of gutterChanges) {
			if (line >= change.startLine && line <= change.endLine) return { change, isAi: false };
		}
		for (const change of aiGutterChanges) {
			if (line >= change.startLine && line <= change.endLine) return { change, isAi: true };
		}
		return null;
	}

	function updateEnvDecorations() {
		const editor = envDecoEditor;
		if (!editor) return;

		if (!isEnvFile || !hideEnvValues) {
			envDecorations = editor.deltaDecorations(envDecorations, []);
			return;
		}

		const lines = editableContent.split('\n');
		const newDecorations: {
			range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
			options: { linesDecorationsClassName: string };
		}[] = [];

		lines.forEach((line, idx) => {
			if (/^[\w.[\]]+\s*=\s*\S/.test(line)) {
				const lineNum = idx + 1;
				newDecorations.push({
					range: {
						startLineNumber: lineNum,
						startColumn: 1,
						endLineNumber: lineNum,
						endColumn: 1
					},
					options: {
						linesDecorationsClassName: 'env-gutter-dot'
					}
				});
			}
		});

		envDecorations = editor.deltaDecorations(envDecorations, newDecorations);
	}

	$effect(() => {
		if (envDecoEditor && isEnvFile && hideEnvValues) {
			void revealedEnvLines;
			editableContent;
			updateEnvDecorations();
		} else if (envDecoEditor) {
			envDecoEditor.deltaDecorations(envDecorations, []);
			envDecorations = [];
		}
	});

	/**
	 * Rows rendered per side before the peek truncates. A whole-file Write hunk can
	 * carry thousands of lines and every row is a DOM node built synchronously —
	 * the overflow is announced rather than silently dropped.
	 */
	const PEEK_MAX_ROWS = 400;

	function appendPeekRows(target: HTMLElement, lines: string[], side: 'old' | 'new') {
		const shown = Math.min(lines.length, PEEK_MAX_ROWS);
		const rows: HTMLElement[] = [];
		for (let i = 0; i < shown; i++) {
			const row = document.createElement('div');
			row.className = `git-diff-peek-row git-diff-peek-row-${side}`;
			row.textContent = lines[i].length > 0 ? lines[i] : '\u00A0';
			target.appendChild(row);
			rows.push(row);
		}
		if (lines.length > shown) {
			const more = document.createElement('div');
			more.className = `git-diff-peek-row git-diff-peek-row-${side}`;
			more.textContent = `… ${lines.length - shown} more lines`;
			target.appendChild(more);
		}
		colorizePeekRows(rows, lines.slice(0, shown));
	}

	/**
	 * Tokenize the peek's rows with the editor's own colorizer so a hunk is
	 * syntax-highlighted exactly like the code above and below it — same theme,
	 * same `.mtk*` classes, no second palette to keep in sync. Rows are rendered
	 * as plain text first and upgraded here, so a language with no tokenizer (or
	 * a failed load) keeps the readable fallback.
	 */
	function colorizePeekRows(rows: HTMLElement[], lines: string[]) {
		if (rows.length === 0) return;
		const model = monacoEditorRef?.getEditor()?.getModel();
		const languageId = model?.getLanguageId();
		if (!model || !languageId || languageId === 'plaintext') return;
		const tabSize = model.getOptions().tabSize;

		void initMonaco()
			.then((monaco) => monaco.editor.colorize(lines.join('\n'), languageId, { tabSize }))
			.then((html) => {
				// The peek can be closed or replaced while the tokenizer loads.
				if (!rows[0].isConnected) return;
				// colorize() emits one chunk per line, separated by <br/>.
				const chunks = html.split('<br/>');
				for (let i = 0; i < rows.length; i++) {
					const chunk = chunks[i];
					if (chunk === undefined) break;
					rows[i].innerHTML = chunk.length > 0 ? chunk : '&nbsp;';
				}
			})
			.catch(() => {
				/* keep the plain-text rows — the hunk stays readable */
			});
	}

	function buildPeekDom(change: GutterChange, isAi = false): HTMLElement {
		const root = document.createElement('div');
		root.className = `git-diff-peek git-diff-peek-${change.type}`;

		const inner = document.createElement('div');
		inner.className = 'git-diff-peek-inner';
		root.appendChild(inner);



		// Old (HEAD) lines — red background, shown for deletions and modifications
		if (change.oldLines.length > 0) {
			const body = document.createElement('div');
			body.className = 'git-diff-peek-body git-diff-peek-body-old';
			const bodyContent = document.createElement('div');
			bodyContent.className = 'git-diff-peek-body-content';
			body.appendChild(bodyContent);
			appendPeekRows(bodyContent, change.oldLines, 'old');
			inner.appendChild(body);
		}

		// New (current) lines — green background, shown for additions and modifications
		if (change.newLines.length > 0) {
			const body = document.createElement('div');
			body.className = 'git-diff-peek-body git-diff-peek-body-new';
			const bodyContent = document.createElement('div');
			bodyContent.className = 'git-diff-peek-body-content';
			body.appendChild(bodyContent);
			appendPeekRows(bodyContent, change.newLines, 'new');
			inner.appendChild(body);
		}

		// Pure addition with no old lines — the new lines already render above,
		// so only show the empty hint when there are truly no lines at all
		// (shouldn't happen in practice, but guards against empty hunks).
		if (change.oldLines.length === 0 && change.newLines.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'git-diff-peek-empty';
			empty.textContent = 'No previous content — these lines are new since the last commit.';
			inner.appendChild(empty);
		}

		return root;
	}

	function buildPeekMargin(change: GutterChange): HTMLElement {
		const margin = document.createElement('div');
		margin.className = 'git-diff-peek-margin';

		// Row counts must match buildPeekDom exactly — the margin and the body live
		// in separate scroll containers kept in lockstep by row index.
		const appendNumbers = (count: number, firstLine: number, side: 'old' | 'new') => {
			const shown = Math.min(count, PEEK_MAX_ROWS);
			for (let idx = 0; idx < shown; idx++) {
				const row = document.createElement('div');
				row.className = `git-diff-peek-margin-row git-diff-peek-margin-row-${side}`;
				row.textContent = String(firstLine + idx);
				margin.appendChild(row);
			}
			if (count > shown) {
				const row = document.createElement('div');
				row.className = `git-diff-peek-margin-row git-diff-peek-margin-row-${side}`;
				row.textContent = '⋯';
				margin.appendChild(row);
			}
		};

		// Old line numbers (HEAD) — rendered for deletions and modifications
		appendNumbers(change.oldLines.length, change.oldStartLine, 'old');

		// New line numbers (current) — rendered for additions and modifications.
		// For pure additions oldStartLine is 0, so we use startLine (1-based).
		appendNumbers(change.newLines.length, change.startLine, 'new');

		return margin;
	}

	// Discard (revert) a single hunk back to the content it replaced — HEAD for a
	// git hunk, the AI edit's own "before" text for an AI hunk (both arrive here as
	// `change.oldLines`). Uses Monaco's executeEdits so the change is undoable
	// (Ctrl+Z) and propagates through onDidChangeModelContent → bind:value →
	// handleContentChange, which closes the peek and refreshes the gutter
	// automatically. Like the git flow, this only edits the buffer — the user still
	// saves to write it to disk.
	function discardHunk(change: GutterChange) {
		const editorInstance = monacoEditorRef?.getEditor();
		if (!editorInstance) return;
		const model = editorInstance.getModel();
		if (!model) return;

		editorInstance.pushUndoStop();

		if (change.type === 'added') {
			// Remove the added lines entirely, including the trailing newline
			// so we don't leave a blank line behind. If the hunk ends on the
			// last line of the file there is no trailing newline to consume.
			const lastLine = model.getLineCount();
			const range =
				change.endLine < lastLine
					? {
						startLineNumber: change.startLine,
						startColumn: 1,
						endLineNumber: change.endLine + 1,
						endColumn: 1
					}
					: {
						startLineNumber: change.startLine,
						startColumn: 1,
						endLineNumber: change.endLine,
						endColumn: model.getLineMaxColumn(change.endLine)
					};
			editorInstance.executeEdits('discard-hunk', [{ range, text: '' }]);
		} else if (change.type === 'modified') {
			// Replace current lines with HEAD's original lines
			const range = {
				startLineNumber: change.startLine,
				startColumn: 1,
				endLineNumber: change.endLine,
				endColumn: model.getLineMaxColumn(change.endLine)
			};
			const text = change.oldLines.join('\n');
			editorInstance.executeEdits('discard-hunk', [{ range, text }]);
		} else if (change.type === 'deleted') {
			// Re-insert the deleted lines before the anchor line
			const range = {
				startLineNumber: change.startLine,
				startColumn: 1,
				endLineNumber: change.startLine,
				endColumn: 1
			};
			const text = change.oldLines.join('\n') + '\n';
			editorInstance.executeEdits('discard-hunk', [{ range, text }]);
		}

		editorInstance.pushUndoStop();
	}

	/**
	 * The editor is the single source of truth for the peek's typography. Monaco
	 * writes its resolved font info as inline styles on `.view-lines`, and the
	 * same values drive the line-number column — so reading them back puts the
	 * peek on the editor's exact grid, mouse-wheel zoom included (zoom never
	 * touches the settings store). Recomputing the metrics here instead is what
	 * broke the alignment: round(round(size * 0.9) * 1.5) is a pixel taller than
	 * the editor's round(size * 0.9 * 1.5) at some sizes, and that pixel compounds
	 * per row until the line numbers label the wrong lines.
	 */
	function readEditorFont(editorInstance: editor.IStandaloneCodeEditor) {
		const viewLines = editorInstance.getDomNode()?.querySelector<HTMLElement>('.view-lines');
		if (viewLines) {
			const style = getComputedStyle(viewLines);
			const fontSize = parseFloat(style.fontSize);
			const lineHeight = parseFloat(style.lineHeight);
			if (fontSize > 0 && lineHeight > 0) {
				return {
					fontFamily: style.fontFamily,
					fontSize,
					lineHeight,
					letterSpacing: style.letterSpacing === 'normal' ? '' : style.letterSpacing
				};
			}
		}
		// Editor not laid out yet — mirror MonacoCodeEditor's construction options.
		return {
			fontFamily: '',
			...editorFontMetrics(),
			letterSpacing: ''
		};
	}

	function applyPeekSizing(editorInstance: editor.IStandaloneCodeEditor, nodes: HTMLElement[]) {
		const layoutInfo = editorInstance.getLayoutInfo();
		const font = readEditorFont(editorInstance);
		// Match the editor's tab width so leading tabs in the peek body align
		// 1:1 with the editor's content above/below.
		const tabSize = editorInstance.getModel()?.getOptions().tabSize ?? 2;
		// Monaco right-aligns each line number at lineNumbersLeft + lineNumbersWidth
		// while the margin view zone spans the whole gutter (contentLeft), so this
		// padding lands the peek's numbers on the editor's own right edge.
		const numbersPadRight = Math.max(
			0,
			layoutInfo.contentLeft - (layoutInfo.lineNumbersLeft + layoutInfo.lineNumbersWidth)
		);
		for (const node of nodes) {
			// Constrain peek width to the visible content viewport so the action
			// buttons stay reachable when the source has long lines.
			node.style.setProperty('--peek-viewport-width', `${layoutInfo.contentWidth}px`);
			// An empty value drops the property, which falls back to the CSS default.
			node.style.setProperty('--peek-font-family', font.fontFamily);
			node.style.setProperty('--peek-font-size', `${font.fontSize}px`);
			node.style.setProperty('--peek-line-height', `${font.lineHeight}px`);
			node.style.setProperty('--peek-letter-spacing', font.letterSpacing);
			node.style.setProperty('--peek-tab-size', String(tabSize));
			node.style.setProperty('--peek-numbers-pad-right', `${numbersPadRight}px`);
		}
	}

	/**
	 * Can `el` still absorb this wheel delta, or is it against the end already?
	 * Sub-pixel scroll positions (zoom, fractional line heights) never land
	 * exactly on the maximum, so the ends are compared with a 1px tolerance —
	 * without it the last pixel of slack would keep eating gestures that belong
	 * to the editor.
	 */
	function canScrollBy(el: HTMLElement, deltaX: number, deltaY: number): boolean {
		const EDGE_TOLERANCE = 1;
		const maxTop = el.scrollHeight - el.clientHeight;
		const maxLeft = el.scrollWidth - el.clientWidth;
		const canVertical =
			(deltaY < 0 && el.scrollTop > EDGE_TOLERANCE) ||
			(deltaY > 0 && el.scrollTop < maxTop - EDGE_TOLERANCE);
		const canHorizontal =
			(deltaX < 0 && el.scrollLeft > EDGE_TOLERANCE) ||
			(deltaX > 0 && el.scrollLeft < maxLeft - EDGE_TOLERANCE);
		return canVertical || canHorizontal;
	}

	function applyPeekScroll(domNode: HTMLElement, scrollLeft: number) {
		// Cancel out the parent view-zone container's horizontal scroll so the
		// peek stays anchored to the editor's visible left edge.
		domNode.style.transform = `translateX(${scrollLeft}px)`;
	}

	function showDiffPeek(change: GutterChange, isAi = false) {
		const editorInstance = monacoEditorRef?.getEditor();
		if (!editorInstance) return;

		closeDiffPeek();

		const changes = getActiveChanges(isAi);
		const foundIdx = changes.findIndex(c => c.startLine === change.startLine && c.type === change.type);
		if (foundIdx >= 0) changeNav?.select(foundIdx);
		peekOpen = true;
		const domNode = buildPeekDom(change, isAi);
		const marginDomNode = buildPeekMargin(change);
		applyPeekSizing(editorInstance, [domNode, marginDomNode]);
		applyPeekScroll(domNode, editorInstance.getScrollLeft());

		// Monaco attaches mouse/pointer listeners on its view container in
		// capture phase, so a bubble-phase stopPropagation on the peek root
		// fires *after* Monaco already received the event. Listen on document
		// in capture phase instead — we run before any ancestor handler and
		// only stop events whose target lies inside the peek. Click and
		// dblclick are left alone: cursor positioning happens on
		// mouse/pointer-down, and text selection in the peek needs the rest.
		const swallowIfInside = (e: Event) => {
			const target = e.target as Node | null;
			if (
				target &&
				(domNode.contains(target) || marginDomNode.contains(target))
			) {
				e.stopPropagation();
			}
		};
		const captureEvents = ['pointerdown', 'pointerup', 'mousedown', 'mouseup'] as const;
		for (const evt of captureEvents) {
			document.addEventListener(evt, swallowIfInside, true);
		}

		// Wheel scrolling needs preventDefault too — stopPropagation alone
		// blocks Monaco's listener, but the browser still natively bubbles
		// the wheel up to Monaco's scrollable element, which scrolls the
		// editor. Trap the event with preventDefault and drive the peek's
		// own scroll programmatically so the body scrolls under the cursor
		// instead of the editor below.
		const innerEl = domNode.querySelector<HTMLElement>('.git-diff-peek-inner');
		// One continuous wheel stream — a trackpad glide plus the momentum tail the
		// OS keeps sending after the fingers lift, or a wheel spun without letting
		// up — fires far faster than a person can decide to scroll again, so a gap
		// this size is what separates two inputs. Nothing here is a delay: the
		// stream is only used to tell "still the same push" from "pushed again".
		const STREAM_GAP_MS = 60;
		let lastWheelAt = 0;
		/**
		 * Did this stream actually move the peek? If it did, running into the end
		 * stops it dead for the rest of the stream — momentum included — so the
		 * editor never lurches out from under someone who was only reading the hunk.
		 * If it didn't (nothing to scroll, or the input arrived already at the end),
		 * the wheel chains to Monaco right away. There is no timer either way.
		 */
		let scrolledInStream = false;
		const wheelHandler = (e: WheelEvent) => {
			const target = e.target as Node | null;
			if (!target) return;
			if (!domNode.contains(target) && !marginDomNode.contains(target)) return;
			if (!innerEl) return;

			if (e.timeStamp - lastWheelAt >= STREAM_GAP_MS) scrolledInStream = false;
			lastWheelAt = e.timeStamp;

			if (!canScrollBy(innerEl, e.deltaX, e.deltaY)) {
				if (!scrolledInStream) return;
				e.stopPropagation();
				e.preventDefault();
				return;
			}

			scrolledInStream = true;
			e.stopPropagation();
			e.preventDefault();
			innerEl.scrollTop += e.deltaY;
			innerEl.scrollLeft += e.deltaX;
			// Sync the margin (line numbers) so it scrolls in lockstep
			// with the body. They live in separate clipped DOM trees
			// (Monaco splits view-zone content and margin), so a single
			// overflow container can't span both.
			marginDomNode.scrollTop = innerEl.scrollTop;
		};
		document.addEventListener('wheel', wheelHandler, { capture: true, passive: false });

		const detachSwallow = () => {
			for (const evt of captureEvents) {
				document.removeEventListener(evt, swallowIfInside, true);
			}
			document.removeEventListener('wheel', wheelHandler, true);
		};

		const afterLineNumber = Math.max(0, change.startLine - 1);
		// Same row height the peek renders with, so the zone reserves exactly the
		// space its rows occupy instead of a rounded-up guess.
		const editorLineHeight = readEditorFont(editorInstance).lineHeight;
		// Cap each section independently at 40% of the editor viewport so a
		// massive hunk on one side doesn't bury the other side or the editor.
		// Each body is scrollable (overflow:auto) so long hunks are still
		// reachable — just capped in height. Short sections stay auto (their
		// natural height), so a 2-line change renders at 2 lines, not 40%.
		const layout = editorInstance.getLayoutInfo();
		const sectionMaxPx = Math.floor(layout.height * 0.4);
		const oldPx = Math.min(change.oldLines.length * editorLineHeight, sectionMaxPx);
		const newPx = Math.min(change.newLines.length * editorLineHeight, sectionMaxPx);
		const contentPx = (oldPx + newPx) || editorLineHeight;
		const heightInPx = Math.ceil(contentPx + 6);

		let zoneId = '';
		editorInstance.changeViewZones((accessor) => {
			zoneId = accessor.addZone({
				afterLineNumber,
				heightInPx,
				domNode,
				marginDomNode,
				suppressMouseDown: true
			});
		});

		// Capture phase, so Escape closes the peek and stops there. A dialog
		// hosting this viewer listens on window too; in the bubble phase both
		// fired, and one Escape closed the peek and the whole dialog with it.
		const escHandler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				closeDiffPeek();
			}
		};
		window.addEventListener('keydown', escHandler, true);

		const scrollDisposable = editorInstance.onDidScrollChange((e) => {
			if (e.scrollLeftChanged) applyPeekScroll(domNode, e.scrollLeft);
		});
		const layoutDisposable = editorInstance.onDidLayoutChange(() => {
			applyPeekSizing(editorInstance, [domNode, marginDomNode]);
		});

		activeDiffZone = {
			id: zoneId,
			line: change.startLine,
			isAi,
			escHandler,
			domNode,
			scrollDispose: () => scrollDisposable.dispose(),
			layoutDispose: () => layoutDisposable.dispose(),
			detachSwallow
		};
	}

	function getActiveChanges(isAi: boolean): GutterChange[] {
		return isAi ? aiGutterChanges : gutterChanges;
	}

	// ── The header's change controls ─────────────────────────────────────────
	//
	// The same navigator the diff editors use, fed with whichever gutter is
	// showing. Stepping to a change opens the peek on it; Discard, Undo and
	// Redo act on the buffer, so nothing reaches disk until a save.

	let changeNav: ChangeNavigator | null = null;
	let changeState = $state<ChangeState>(NO_CHANGES);
	let peekOpen = $state(false);

	function setGitChanges(changes: GutterChange[]) {
		gutterChanges = changes;
		syncNavigatorChanges();
	}

	function setAiChanges(changes: GutterChange[]) {
		aiGutterChanges = changes;
		syncNavigatorChanges();
	}

	function syncNavigatorChanges() {
		changeNav?.setChanges(
			getActiveChanges(gutterMode === 'ai').map((change) => ({
				type: change.type,
				start: change.startLine,
				end: Math.max(change.startLine, change.endLine)
			}))
		);
	}

	function currentGutterChange(): GutterChange | undefined {
		const index = changeNav?.index ?? -1;
		return index >= 0 ? getActiveChanges(gutterMode === 'ai')[index] : undefined;
	}

	function syncChangeState() {
		if (!changeNav) {
			changeState = NO_CHANGES;
			return;
		}
		const current = currentGutterChange();
		changeState = {
			count: changeNav.count,
			index: changeNav.index,
			canDiscard: canEdit && !!current && current.exact !== false,
			...(canEdit ? editorHistory(monacoEditorRef?.getEditor()) : { canUndo: false, canRedo: false })
		};
	}

	/** The file is shown as code in the editor (not a preview, an image or a binary). */
	const hasCodeEditor = $derived(
		!!file &&
			file.type === 'file' &&
			!isBinary &&
			!isBinaryContent(content) &&
			!isImageFile(file.name) &&
			!isBinaryFile(file.name) &&
			!isPdfFile(file.name) &&
			!isAudioFile(file.name) &&
			!isVideoFile(file.name) &&
			!(isSvgFile(file.name) && svgViewMode === 'visual') &&
			!(isMarkdown && mdViewMode === 'visual')
	);

	/** The buffer can be edited and saved here (a review modal only reads). */
	const canEdit = $derived(!!onSave);

	const changeControls = $derived<ChangeControls>(
		canEdit
			? {
				previous: () => changeNav?.step(-1),
				next: () => changeNav?.step(1),
				discard: () => {
					const change = currentGutterChange();
					if (change && change.exact !== false) discardHunk(change);
				},
				undo: () => undoIn(monacoEditorRef?.getEditor()),
				redo: () => redoIn(monacoEditorRef?.getEditor())
			}
			: {
				previous: () => changeNav?.step(-1),
				next: () => changeNav?.step(1)
			}
	);

	function refreshActiveDiffPeek() {
		if (!activeDiffZone) return;
		const isAi = activeDiffZone.isAi;
		const changes = getActiveChanges(isAi);
		if (changes.length === 0) {
			closeDiffPeek();
			return;
		}
		const targetChange = changes[0];
		showDiffPeek(targetChange, isAi);
		const editor = monacoEditorRef?.getEditor();
		if (editor) {
			editor.revealLineInCenterIfOutsideViewport(targetChange.startLine);
		}
	}

	function closeDiffPeek() {
		if (!activeDiffZone) return;
		const editorInstance = monacoEditorRef?.getEditor();
		const { id, escHandler, scrollDispose, layoutDispose, detachSwallow } = activeDiffZone;
		activeDiffZone = null;
		peekOpen = false;
		window.removeEventListener('keydown', escHandler, true);
		scrollDispose();
		layoutDispose();
		detachSwallow();
		if (editorInstance) {
			editorInstance.changeViewZones((accessor) => {
				accessor.removeZone(id);
			});
		}
	}

	function attachGutterClickHandler(editorInstance: editor.IStandaloneCodeEditor) {
		gutterClickDispose?.();
		const disposable = editorInstance.onMouseDown((e) => {
			if (e.target.type !== GUTTER_LINE_DECORATIONS) return;
			const line = e.target.position?.lineNumber;
			if (!line) return;
			const found = findChangeAtLine(line);
			if (!found) return;
			const { change, isAi } = found;
			if (activeDiffZone && activeDiffZone.line === change.startLine) {
				closeDiffPeek();
			} else {
				showDiffPeek(change, isAi);
			}
		});
		gutterClickDispose = () => disposable.dispose();
	}

	function attachEnvClickHandler(editorInstance: editor.IStandaloneCodeEditor) {
		editorInstance.onMouseDown((e) => {
			if (!isEnvFile || !hideEnvValues) return;
			if (e.target.type !== GUTTER_LINE_DECORATIONS) return;
			const el = e.target.element as HTMLElement | null;
			if (!el || !el.classList.contains('env-gutter-dot')) return;
			const line = e.target.position?.lineNumber;
			if (!line) return;
			const contentLine = editableContent.split('\n')[line - 1];
			if (!contentLine || !/^[\w.[\]]+\s*=\s*\S/.test(contentLine)) return;
			toggleRevealLine(line);
		});
	}

	// Called by MonacoCodeEditor once the editor instance is fully constructed.
	// Re-runs after every theme remount, so re-attach the scroll listener and
	// re-apply gutter decorations + pending scroll restore each time.
	function handleEditorMount(editorInstance: editor.IStandaloneCodeEditor) {
		envDecoEditor = editorInstance;
		changeNav?.dispose();
		changeNav = new ChangeNavigator(editorInstance, {
			onUpdate: syncChangeState,
			onReveal: (_span, index) => {
				const isAi = gutterMode === 'ai';
				const change = getActiveChanges(isAi)[index];
				if (change) showDiffPeek(change, isAi);
			},
			// An open peek holds the current change while the reader scrolls it.
			isPinned: () => peekOpen
		});
		scrollListenerDispose?.();
		const disposable = editorInstance.onDidScrollChange((e) => {
			if (e.scrollTopChanged) {
				onEditorScroll?.(e.scrollTop);
				if (isMarkdown && mdViewMode === 'code') {
					const scrollHeight = editorInstance.getScrollHeight();
					const layoutInfo = editorInstance.getLayoutInfo();
					const max = scrollHeight - layoutInfo.height;
					if (max > 0) {
						recordMdScroll(Math.max(0, Math.min(1, e.scrollTop / max)));
					}
				}
			}
		});
		scrollListenerDispose = () => disposable.dispose();

		// Reset decoration ids — the prior editor instance is gone so its ids
		// are no longer valid.
		gutterDecorations = [];
		aiChangeDecorations = [];

		// Previous editor's view zones are gone with the disposed instance
		if (activeDiffZone) {
			window.removeEventListener('keydown', activeDiffZone.escHandler, true);
			activeDiffZone.scrollDispose();
			activeDiffZone.layoutDispose();
			activeDiffZone.detachSwallow();
			activeDiffZone = null;
		}

		attachGutterClickHandler(editorInstance);

		attachEnvClickHandler(editorInstance);
		updateEnvDecorations();

		// Markdown mode-switch scroll restore takes precedence over the
		// tab-switch absolute scroll restore.
		if (pendingMdScrollPercent !== null) {
			const target = pendingMdScrollPercent;
			pendingMdScrollPercent = null;
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					const scrollHeight = editorInstance.getScrollHeight();
					const layoutInfo = editorInstance.getLayoutInfo();
					const max = scrollHeight - layoutInfo.height;
					if (max > 0) {
						editorInstance.setScrollTop(max * target);
					}
				});
			});
		} else if (pendingScrollRestore !== null) {
			const top = pendingScrollRestore;
			pendingScrollRestore = null;
			requestAnimationFrame(() => editorInstance.setScrollTop(top));
		} else if (editorScrollTop > 0 && !monacoEditorRef?.hasRestoredViewState?.()) {
			// Fallback only: if the editor already restored full view state (scroll +
			// cursor + folds), don't fight it with a coarser scroll-only restore.
			requestAnimationFrame(() => editorInstance.setScrollTop(editorScrollTop));
		}

		scheduleGutterUpdate();
		applyAiChangeDecorations();
	}

	// Handle content changes from editor
	function handleContentChange(newContent: string) {
		hasChanges = newContent !== referenceContent;
		onContentChange?.(newContent);
		// After the edit settles: an undo reports its content before the model
		// has moved it onto the redo stack.
		queueMicrotask(syncChangeState);
		// User edits invalidate the captured HEAD-side hunk in the peek; close it
		if (activeDiffZone) closeDiffPeek();
		scheduleGutterUpdate();
		// Re-diff against the turn's base. Editing never destroys the marker: the
		// base is the file as it stood before the turn, so a hunk the user reverts
		// simply stops being a difference.
		applyAiChangeDecorations();
	}

	export function getEditorScrollTop(): number {
		return monacoEditorRef?.getScrollTop?.() ?? 0;
	}

	export function resetRevealFilter() {
		resetAiScope();
		setGutterViewMode('git');
		closeDiffPeek();
	}

	// Update Monaco word wrap when prop changes
	// Read wordWrap BEFORE the if-check so it's always tracked by $effect
	$effect(() => {
		const wrapValue: 'on' | 'off' = wordWrap ? 'on' : 'off';
		const editor = monacoEditorRef?.getEditor();
		if (editor) {
			editor.updateOptions({ wordWrap: wrapValue });
		}
	});

	function clearTargetTimers() {
		if (targetHighlightTimer) {
			clearTimeout(targetHighlightTimer);
			targetHighlightTimer = null;
		}
		if (targetFadeTimer) {
			clearTimeout(targetFadeTimer);
			targetFadeTimer = null;
		}
	}

	// Apply line + column highlight for the given target. Returns false when the
	// editor model isn't ready yet (file content still loading, line out of range),
	// so the caller can retry — clicking a search result on a not-yet-open file
	// triggers `target` before `displayContent` finishes loading.
	function applyTargetHighlight(
		t: { line: number; column?: number; length?: number },
		attempt: number
	): void {
		const ed = monacoEditorRef?.getEditor();
		const model = ed?.getModel();

		if (!ed || !model || model.getLineCount() < t.line) {
			// Retry every 100ms up to ~1.5s while the file finishes loading.
			if (attempt < 15) {
				targetHighlightTimer = setTimeout(() => {
					targetHighlightTimer = null;
					applyTargetHighlight(t, attempt + 1);
				}, 100);
			}
			return;
		}

		const lineMaxColumn = model.getLineMaxColumn(t.line);
		const decos: editor.IModelDeltaDecoration[] = [
			{
				range: {
					startLineNumber: t.line,
					startColumn: 1,
					endLineNumber: t.line,
					endColumn: 1
				},
				options: {
					isWholeLine: true,
					className: 'line-highlight',
					marginClassName: 'line-highlight-margin'
				}
			}
		];

		// Clamp the match range so an out-of-bounds column never throws.
		if (t.column !== undefined && t.column > 0) {
			const startCol = Math.min(t.column, lineMaxColumn);
			const matchLen = t.length && t.length > 0 ? t.length : 1;
			const endCol = Math.min(startCol + matchLen, lineMaxColumn);
			decos.push({
				range: {
					startLineNumber: t.line,
					startColumn: startCol,
					endLineNumber: t.line,
					endColumn: endCol
				},
				options: {
					className: 'match-highlight',
					overviewRuler: {
						color: '#facc15',
						position: OVERVIEW_RULER_RIGHT
					}
				}
			});

			// revealRangeInCenter scrolls both vertically AND horizontally so the
			// match is visible even when the line is far wider than the viewport.
			ed.revealRangeInCenter({
				startLineNumber: t.line,
				startColumn: startCol,
				endLineNumber: t.line,
				endColumn: endCol
			});
		} else {
			ed.revealLineInCenter(t.line);
		}

		currentDecorations = ed.deltaDecorations(currentDecorations, decos);

		targetFadeTimer = setTimeout(() => {
			targetFadeTimer = null;
			const e = monacoEditorRef?.getEditor();
			if (e) e.deltaDecorations(currentDecorations, []);
			currentDecorations = [];
		}, 3000);
	}

	// Handle line + column highlighting when target changes
	$effect(() => {
		// Always cancel any pending highlight/fade from a prior click before
		// reacting to the new target — a stale fade timer firing later would
		// wipe the decoration the new click places, and a stale highlight
		// timer firing after a tab switch would paint the old line/column on
		// the *new* file's content.
		clearTargetTimers();

		if (target === undefined || target.line <= 0) return;
		// Snapshot before timers — `target` may change before the closure fires.
		const t = { line: target.line, column: target.column, length: target.length };

		targetHighlightTimer = setTimeout(() => {
			targetHighlightTimer = null;
			applyTargetHighlight(t, 0);
		}, 100);
	});

	// Save changes
	async function saveChanges() {
		if (!file || !onSave || !hasChanges) {
			return;
		}

		isSaving = true;
		try {
			await onSave(file.path, editableContent);
			hasChanges = false;
		} catch (error) {
			debug.error('file', 'Failed to save file:', error);
			// A failed save used to end in the log alone; in a dialog nothing else
			// would ever say the edits are still unsaved.
			const message = error instanceof Error ? error.message : String(error);
			showError(
				'Not saved',
				message.includes('FILE_CONFLICT') ? 'The file changed on disk since it was opened.' : message
			);
		} finally {
			isSaving = false;
		}
	}

	// Get detected language from filename
	function getDetectedLanguage(): string {
		if (!file) return 'plaintext';
		if (/\.env(\.\w+)?$/i.test(file.name)) return 'env';

		const ext = file.name.split('.').pop()?.toLowerCase();
		if (!ext) return 'plaintext';

		const languageMap: Record<string, string> = {
			js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
			mjs: 'javascript', cjs: 'javascript',
			html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
			py: 'python', pyx: 'python', pyi: 'python',
			java: 'java', c: 'c', cpp: 'cpp', cxx: 'cpp', cc: 'cpp',
			h: 'c', hpp: 'cpp', hxx: 'cpp',
			cs: 'csharp', csx: 'csharp', go: 'go', rs: 'rust',
			php: 'php', phtml: 'php', rb: 'ruby', rbw: 'ruby',
			swift: 'swift', kt: 'kotlin', kts: 'kotlin',
			scala: 'scala', sc: 'scala', r: 'r',
			sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
			ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat',
			sql: 'sql', xml: 'xml', xsd: 'xml', xsl: 'xml',
			json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml',
			toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini',
			md: 'markdown', markdown: 'markdown',
			dockerfile: 'dockerfile', lua: 'lua',
			pl: 'perl', pm: 'perl', hs: 'haskell',
			fs: 'fsharp', fsx: 'fsharp', clj: 'clojure', cljs: 'clojure',
			erl: 'erlang', ex: 'elixir', exs: 'elixir',
			dart: 'dart', sol: 'solidity',
			graphql: 'graphql', gql: 'graphql',
			svelte: 'html', vue: 'html',
			gitignore: 'plaintext', env: 'env', txt: 'plaintext', log: 'plaintext',
			svg: 'xml'
		};

		return languageMap[ext] || 'plaintext';
	}

	// Helper functions
	function getDisplayIcon(fileName: string, isDirectory: boolean): IconName {
		if (isDirectory) {
			return getFolderIcon(fileName, false);
		}
		return getFileIcon(fileName);
	}

	function copyToClipboard() {
		if (editableContent) {
			navigator.clipboard.writeText(editableContent);
		}
	}

	/** The header's actions; the ones that do not fit its width wait in "⋯". */
	const headerActions = $derived.by<HeaderAction[]>(() => {
		const list: HeaderAction[] = [];
		const isFile = !!file && file.type === 'file';

		if (isFile && file && isSvgFile(file.name)) {
			const visual = svgViewMode === 'visual';
			list.push({
				id: 'svg-view',
				label: visual ? 'Show code' : 'Show preview',
				icon: visual ? 'lucide:eye' : 'lucide:code',
				onclick: () => { svgViewMode = visual ? 'code' : 'visual'; },
				priority: 8
			});
		}
		if (isMarkdown) {
			const visual = mdViewMode === 'visual';
			list.push({
				id: 'markdown-view',
				label: visual ? 'Show source' : 'Show preview',
				icon: visual ? 'lucide:book-open' : 'lucide:code',
				onclick: () => switchMdMode(visual ? 'code' : 'visual'),
				priority: 8
			});
		}
		if (externallyChanged && onForceReload) {
			list.push({
				id: 'reload',
				label: 'Reload from disk',
				icon: 'lucide:refresh-cw',
				tone: 'warning',
				onclick: onForceReload,
				priority: 15
			});
		}

		if (hasCodeEditor) {
			if (isEnvFile) {
				list.push({
					id: 'env-values',
					label: hideEnvValues ? 'Show values' : 'Hide values',
					icon: hideEnvValues ? 'lucide:eye-off' : 'lucide:eye',
					active: !hideEnvValues,
					onclick: () => { hideEnvValues = !hideEnvValues; },
					priority: 6
				});
			}
			if (hasAiChanges) {
				const aiMode = gutterMode === 'ai';
				const choices: HeaderChoice[] = [
					{ label: 'Git changes', checked: !aiMode, onSelect: () => setGutterViewMode('git') },
					{ kind: 'separator' },
					{ kind: 'subheading', label: 'This chat' },
					{ label: 'Latest turn', checked: aiMode && aiScope === 'latest', onSelect: () => selectAiScope('latest') },
					{
						label: `All ${chatTurns.length} ${chatTurns.length === 1 ? 'turn' : 'turns'}`,
						checked: aiMode && aiScope === 'all',
						onSelect: () => selectAiScope('all')
					},
					{ kind: 'separator' },
					// Every turn of the chat, listed the same way whether or not it
					// touched this file — a shorter menu on one file than on the next
					// only hides which turns exist.
					...chatTurns.map((turn): HeaderChoice => {
						const touched = turnTouchedFile(turn);
						return {
							label: turn.promptText,
							prefix: turn.turnIndex === null ? 'Now' : `Turn ${turn.turnIndex}`,
							checked: aiMode && aiScope === turnId(turn),
							dim: !touched,
							title: touched ? turn.promptText : `${turn.promptText} — no changes to this file`,
							onSelect: () => selectAiScope(turnId(turn))
						};
					})
				];
				list.push({
					id: 'gutter-mode',
					label: 'Show changes from',
					icon: aiMode ? 'lucide:sparkles' : 'lucide:git-branch',
					tone: aiMode ? 'default' : 'sky',
					choices,
					priority: 10
				});
			}
			if (onToggleWordWrap) {
				list.push({ id: 'word-wrap', label: 'Word wrap', icon: 'lucide:wrap-text', active: wordWrap, onclick: onToggleWordWrap, priority: 4 });
			}
			if (canEdit) {
				list.push(saveAction({ dirty: hasChanges, saving: isSaving, onSave: () => { if (canSave) saveChanges(); } }));
			}
			if (editableContent) {
				list.push({ id: 'copy', label: 'Copy content', icon: 'lucide:copy', onclick: copyToClipboard, priority: 1 });
			}
		} else if (isFile && canEditImage) {
			list.push({ id: 'edit-image', label: 'Edit image', icon: 'lucide:pencil', tone: 'primary', onclick: () => { showImageEditor = true; }, priority: 100 });
		}
		return list;
	});

	// Progress of the one download this viewer can have in flight, so a large
	// binary reports movement instead of sitting on a dead button.
	let downloadProgress = $state<{ transferredBytes: number; totalBytes: number | null } | null>(null);
	let downloadAbort: AbortController | null = null;

	const downloadPercent = $derived(
		downloadProgress && downloadProgress.totalBytes
			? Math.min(100, Math.round((downloadProgress.transferredBytes / downloadProgress.totalBytes) * 100))
			: null
	);

	function cancelDownload() {
		downloadAbort?.abort();
	}

	async function downloadFile() {
		if (!file || file.type !== 'file') return;

		// Text/code/SVG/markdown files are held in the editor — download exactly
		// what the user sees (including any unsaved edits).
		const isTextFile = !isPreviewableFile(file.name) && !isBinaryFile(file.name) && !isBinary;
		if (isTextFile && editableContent != null) {
			saveBlob(new Blob([editableContent], { type: 'text/plain;charset=utf-8' }), file.name);
			return;
		}

		// Binary / media files: stream the original bytes from disk so the download
		// is byte-for-byte intact and reports progress on the way. `preview` is not
		// involved, so transcodable formats (TIFF/HEIC) download in their original
		// format, not a PNG copy.
		if (downloadAbort) return;
		const controller = new AbortController();
		downloadAbort = controller;
		downloadProgress = { transferredBytes: 0, totalBytes: file.size ?? null };
		try {
			const blob = await fetchFileBlob(file.path, {
				totalBytes: file.size ?? null,
				signal: controller.signal,
				onProgress: (progress) => { downloadProgress = progress; }
			});
			saveBlob(blob, file.name);
		} catch (err) {
			if (!isAbortError(err)) debug.error('file', 'Failed to download file:', err);
		} finally {
			downloadAbort = null;
			downloadProgress = null;
		}
	}
</script>

{#if file}
	<div class="w-full h-full flex flex-col" use:saveShortcut={saveFromShortcut}>
		<!-- Header -->
		{#if !hideHeader}
		<EditorHeader
			icon={getDisplayIcon(file.name, file.type === 'directory')}
			title={file.name}
			subtitle={`${displayPath} • ${formatFileSize(file.size || 0)}`}
			{titleId}
			changes={hasCodeEditor ? { state: changeState, controls: changeControls, onHide: peekOpen ? closeDiffPeek : undefined } : undefined}
			actions={headerActions}
			{onClose}
		>
			{#snippet meta()}
				{#if externallyChanged && onForceReload}
					<span class="text-3xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-400 font-medium whitespace-nowrap">
						Changed externally
					</span>
				{/if}
			{/snippet}
		</EditorHeader>
		{/if}

		<!-- A turn that left this file alone. Said out loud, because an empty
		     gutter on its own reads as "nothing to see" rather than as an answer. -->
		{#if gutterMode === 'ai' && aiScopeEmpty}
			<div class="flex-shrink-0 flex items-center gap-2 px-4 py-1.5 text-2xs bg-slate-50 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-700/60 text-slate-600 dark:text-slate-400">
				<Icon name="lucide:info" class="w-3.5 h-3.5 shrink-0" />
				<span class="min-w-0 truncate">{aiScopeLabel} changed nothing in this file.</span>
			</div>
		{/if}

		<!-- Content -->
		<div class="flex-1 overflow-hidden">
			{#if isLoading}
				<div class="flex items-center justify-center h-full">
					<LoadingSpinner size="lg" />
				</div>
			{:else if error}
				<div class="flex flex-col items-center justify-center h-full p-8">
					<Icon name="lucide:triangle-alert" class="w-16 h-16 text-red-400 mb-4" />
					<h3 class="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">
						Unable to load file
					</h3>
					<p class="text-sm text-slate-500 dark:text-slate-400 text-center">
						{error}
					</p>
				</div>
			{:else if file.type === 'directory'}
				<div class="flex flex-col items-center justify-center h-full p-8">
					<Icon name="lucide:folder" class="w-16 h-16 text-slate-400 mb-4" />
					<h3 class="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">
						Directory Selected
					</h3>
					<p class="text-sm text-slate-500 dark:text-slate-400 text-center">
						This is a directory. Select a file to view its content.
					</p>
				</div>
			{:else if isSvgFile(file.name)}
				{#if svgViewMode === 'visual'}
					<MediaPreview fileName={file.name} filePath={file.path} svgContent={content} />
				{:else}
					<!-- SVG code view (editable) -->
					<div class="h-full flex flex-col bg-slate-50 dark:bg-slate-950">
						<div class="flex-1 relative overflow-hidden">
							<div class="absolute inset-0">
								{#key themeKey}
								<MonacoCodeEditor
									bind:this={monacoEditorRef}
									bind:value={editableContent}
									language="xml"
									path={file.path}
									readonly={false}
									onChange={handleContentChange}
									onEditorMount={handleEditorMount}
									options={{
										wordWrap: 'off',
										renderWhitespace: 'none',
										mouseWheelZoom: false
									}}
								/>
								{/key}
							</div>
						</div>

						{#if hasChanges}
							<div class="flex-shrink-0 p-4 bg-amber-50 dark:bg-amber-900/30 border-t border-amber-200 dark:border-amber-800">
								<div class="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
									<Icon name="lucide:circle-alert" class="w-3 h-3" />
									Unsaved changes
								</div>
							</div>
						{/if}
					</div>
				{/if}
			{:else if isMarkdown && mdViewMode === 'visual'}
				{#key file.path}
					<MarkdownPreview
						content={editableContent || content}
						initialScrollPercent={currentMdScrollPercent}
						onScrollPercent={recordMdScroll}
						onFileLink={handleMdFileLink}
					/>
				{/key}
			{:else if isPreviewableFile(file.name)}
				<MediaPreview fileName={file.name} filePath={file.path} reloadToken={imageReloadToken} />
				{#if showImageEditor && canEditImage}
					<ImageEditor
						{file}
						onClose={() => { showImageEditor = false; }}
						onSaved={() => { imageReloadToken += 1; }}
					/>
				{/if}
			{:else if isBinary || isBinaryFile(file.name) || isBinaryContent(content)}
				<div class="flex flex-col items-center justify-center h-full p-8">
					<Icon name="lucide:file-text" class="w-16 h-16 text-slate-400 mb-4" />
					<h3 class="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">
						Binary File
					</h3>
					<p class="text-sm text-slate-500 dark:text-slate-400 text-center mb-4">
						This file cannot be previewed in the browser.
					</p>
					{#if downloadProgress}
						<div class="w-full max-w-xs flex flex-col items-center gap-2">
							<div class="h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
								{#if downloadPercent !== null}
									<div
										class="h-full bg-violet-600 transition-all duration-150"
										style="width: {downloadPercent}%"
									></div>
								{:else}
									<div class="h-full w-1/3 bg-violet-600 animate-pulse"></div>
								{/if}
							</div>
							<div class="text-xs text-slate-500 dark:text-slate-400">
								{formatFileSize(downloadProgress.transferredBytes)}{downloadProgress.totalBytes
									? ` / ${formatFileSize(downloadProgress.totalBytes)}`
									: ''}
							</div>
							<button
								class="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
								onclick={cancelDownload}
							>
								Cancel
							</button>
						</div>
					{:else}
						<button
							class="px-6 py-2.5 bg-violet-600 text-white rounded-xl hover:bg-violet-700 transition-all duration-200"
							onclick={downloadFile}
						>
							Download File
						</button>
					{/if}
				</div>
			{:else}
				<!-- Code content (always in edit mode) -->
				<div class="h-full relative bg-slate-50 dark:bg-slate-950">
					<div class="absolute inset-0">
						{#key themeKey + (isEnvFile ? String(hideEnvValues) + '-' + revealedEnvLines.size : '')}
						{#if hideEnvValues && isEnvFile}
							<MonacoCodeEditor
								bind:this={monacoEditorRef}
								value={envViewContent}
								language={getDetectedLanguage()}
								path={file.path}
								readonly={true}
								onEditorMount={handleEditorMount}
								options={{
									wordWrap: wordWrap ? 'on' : 'off',
									renderWhitespace: 'none',
									mouseWheelZoom: false
								}}
							/>
						{:else}
							<MonacoCodeEditor
								bind:this={monacoEditorRef}
								bind:value={editableContent}
								language={getDetectedLanguage()}
								path={file.path}
								readonly={false}
								onChange={handleContentChange}
								onEditorMount={handleEditorMount}
								options={{
									wordWrap: wordWrap ? 'on' : 'off',
									renderWhitespace: 'none',
									mouseWheelZoom: false
								}}
							/>
						{/if}
						{/key}
					</div>
				</div>
			{/if}
		</div>
	</div>
{:else}
	<div class="h-full flex items-center justify-center">
		<div class="text-center p-12">
			<div class="bg-slate-100 dark:bg-slate-800 rounded-full w-20 h-20 flex items-center justify-center mx-auto mb-6">
				<Icon name="lucide:file-text" class="w-10 h-10 text-slate-400" />
			</div>
			<h3 class="text-lg font-bold text-slate-900 dark:text-slate-100 mb-2">
				No File Selected
			</h3>
			<p class="text-sm text-slate-600 dark:text-slate-400">
				Select a file from the explorer to view its content.
			</p>
		</div>
	</div>
{/if}

<style>
	/* Git gutter decorations — thin colored bars in the line-numbers margin */
	:global(.git-gutter-added),
	:global(.git-gutter-modified),
	:global(.git-gutter-deleted) {
		cursor: pointer;
		transition: width 80ms ease, margin-left 80ms ease, filter 80ms ease;
	}

	:global(.git-gutter-added) {
		background-color: #10b981;
		width: 3px !important;
		margin-left: 3px;
	}
	:global(.git-gutter-modified) {
		background-color: #3b82f6;
		width: 3px !important;
		margin-left: 3px;
	}
	:global(.git-gutter-deleted) {
		width: 0 !important;
		margin-left: 3px;
		border-top: 4px solid #ef4444;
		border-right: 4px solid transparent;
		height: 0 !important;
	}

	/* Dark mode — slightly darker so it doesn't glare against the editor bg */
	:global(.dark .git-gutter-added) {
		background-color: #059669;
	}
	:global(.dark .git-gutter-modified) {
		background-color: #2563eb;
	}
	:global(.dark .git-gutter-deleted) {
		border-top-color: #dc2626;
	}

	/* Hover — widen the bar and brighten it slightly to signal clickability */
	:global(.git-gutter-added:hover),
	:global(.git-gutter-modified:hover) {
		width: 6px !important;
		margin-left: 1px;
		filter: brightness(1.15);
	}
	:global(.git-gutter-deleted:hover) {
		margin-left: 1px;
		border-top-width: 6px;
		border-right-width: 6px;
		filter: brightness(1.15);
	}

	/* AI gutter decorations — same colors as Git changes (green/blue/red) */
	:global(.ai-gutter-added) {
		background-color: #10b981;
		width: 3px !important;
		margin-left: 3px;
	}
	:global(.ai-gutter-modified) {
		background-color: #3b82f6;
		width: 3px !important;
		margin-left: 3px;
	}
	:global(.ai-gutter-deleted) {
		width: 0 !important;
		margin-left: 3px;
		border-top: 4px solid #ef4444;
		border-right: 4px solid transparent;
		height: 0 !important;
	}
	:global(.dark .ai-gutter-added) {
		background-color: #059669;
	}
	:global(.dark .ai-gutter-modified) {
		background-color: #2563eb;
	}
	:global(.dark .ai-gutter-deleted) {
		border-top-color: #dc2626;
	}
	:global(.ai-gutter-added:hover),
	:global(.ai-gutter-modified:hover) {
		width: 6px !important;
		margin-left: 1px;
		filter: brightness(1.15);
	}
	:global(.ai-gutter-deleted:hover) {
		margin-left: 1px;
		border-top-width: 6px;
		border-right-width: 6px;
		filter: brightness(1.15);
	}

	/* Narrow the overview ruler so the change markers align visually with the
	   3px gutter bars. The canvas content scales to fit the CSS width. */
	:global(.monaco-editor .decorationsOverviewRuler) {
		width: 5px !important;
	}

	/* Monaco renders .view-zones, .view-overlays and .view-lines as siblings
	   inside .lines-content. By default they all have z-index:auto and stack
	   purely in DOM order — .view-zones is first, so its sibling layers paint
	   above it and can swallow clicks before they reach the peek. Lifting
	   .view-zones to z-index:1 (only when it actually contains a peek) puts
	   the peek above those overlays without affecting editors with no peek. */
	:global(.monaco-editor .view-zones:has(.git-diff-peek)) {
		z-index: 1;
	}

	/* Inline diff peek view — VS Code-like presentation of the HEAD-side hunk.
	   .git-diff-peek matches the full view-zone width (which can equal the
	   source scrollWidth); .git-diff-peek-inner scrolls horizontally so long
	   lines are reachable. Its controls (steps, Discard, hide) live in the
	   editor header, not in the peek. */
	:global(.git-diff-peek) {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
		pointer-events: auto;
		-moz-tab-size: var(--peek-tab-size, 2);
		tab-size: var(--peek-tab-size, 2);
	}

	:global(.git-diff-peek-inner) {
		display: flex;
		flex-direction: column;
		width: var(--peek-viewport-width, 100%);
		height: 100%;
		/* Typography comes from the editor itself (see applyPeekSizing) — the
		   literals are only a pre-layout fallback. */
		font-family: var(
			--peek-font-family,
			'SF Mono',
			Monaco,
			Inconsolata,
			'Roboto Mono',
			Consolas,
			'Courier New',
			monospace
		);
		font-size: var(--peek-font-size, 12px);
		letter-spacing: var(--peek-letter-spacing, normal);
		background-color: var(--vscode-editor-background, #ffffff);
		border-top: 1px solid #d4d4d4;
		border-bottom: 1px solid #d4d4d4;
		overflow-y: auto;
		overflow-x: auto;
		box-sizing: border-box;
		pointer-events: auto;
	}
	:global(.dark .git-diff-peek-inner) {
		background-color: var(--vscode-editor-background, #0d1117);
		border-top-color: #30363d;
		border-bottom-color: #30363d;
	}

	/* Type-tinted headers — green for added, red for deleted, blue for
	   modified. The gutter bar already uses the same hues; mirroring them
	   on the header makes the peek's type identifiable at a glance. */
	:global(.git-diff-peek-added .git-diff-peek-inner) {
		border-top-color: #10b981;
		border-bottom-color: #10b981;
	}
	:global(.dark .git-diff-peek-added .git-diff-peek-inner) {
		border-top-color: #059669;
		border-bottom-color: #059669;
	}
	:global(.git-diff-peek-added .git-diff-peek-margin) {
		border-top-color: #10b981;
		border-bottom-color: #10b981;
	}
	:global(.dark .git-diff-peek-added .git-diff-peek-margin) {
		border-top-color: #059669;
		border-bottom-color: #059669;
	}
	:global(.git-diff-peek-deleted .git-diff-peek-inner) {
		border-top-color: #ef4444;
		border-bottom-color: #ef4444;
	}
	:global(.dark .git-diff-peek-deleted .git-diff-peek-inner) {
		border-top-color: #dc2626;
		border-bottom-color: #dc2626;
	}
	:global(.git-diff-peek-deleted .git-diff-peek-margin) {
		border-top-color: #ef4444;
		border-bottom-color: #ef4444;
	}
	:global(.dark .git-diff-peek-deleted .git-diff-peek-margin) {
		border-top-color: #dc2626;
		border-bottom-color: #dc2626;
	}

	:global(.git-diff-peek-body) {
		flex: none;
		min-width: 0;
		overflow: visible;
		/* Base colour for untokenized text; syntax spans paint over it. */
		color: var(--vscode-editor-foreground, #333);
		-webkit-user-select: text;
		user-select: text;
		cursor: text;
	}
	:global(.git-diff-peek-body-old .git-diff-peek-body-content) {
		background-color: rgba(239, 68, 68, 0.10);
	}
	:global(.git-diff-peek-body-new .git-diff-peek-body-content) {
		background-color: rgba(16, 185, 129, 0.10);
	}
	:global(.dark .git-diff-peek-body-old),
	:global(.dark .git-diff-peek-body-new) {
		color: var(--vscode-editor-foreground, #e6edf3);
	}
	:global(.dark .git-diff-peek-body-old .git-diff-peek-body-content) {
		background-color: rgba(239, 68, 68, 0.16);
	}
	:global(.dark .git-diff-peek-body-new .git-diff-peek-body-content) {
		background-color: rgba(16, 185, 129, 0.16);
	}

	/* Modified peek — blue tint on the inner frame to signal that both
	   additions and deletions are present in this hunk. */
	:global(.git-diff-peek-modified .git-diff-peek-inner) {
		border-top-color: #3b82f6;
		border-bottom-color: #3b82f6;
	}
	:global(.dark .git-diff-peek-modified .git-diff-peek-inner) {
		border-top-color: #2563eb;
		border-bottom-color: #2563eb;
	}
	:global(.git-diff-peek-modified .git-diff-peek-margin) {
		border-top-color: #3b82f6;
		border-bottom-color: #3b82f6;
	}
	:global(.dark .git-diff-peek-modified .git-diff-peek-margin) {
		border-top-color: #2563eb;
		border-bottom-color: #2563eb;
	}

	/* Content track inside the scroll viewport. width:max-content shrink-wraps
	   to the widest row, min-width:100% keeps it at least as wide as the body
	   so short rows still span full width for row hover/selection. */
	:global(.git-diff-peek-body-content) {
		display: block;
		width: max-content;
		min-width: 100%;
	}

	:global(.git-diff-peek-row) {
		display: block;
		white-space: pre;
		line-height: var(--peek-line-height, 18px);
		min-height: var(--peek-line-height, 18px);
		/* No horizontal padding — the text must line up with the editor's
		   content column above and below the peek. */
	}

	/* Margin area — Monaco places this in the gutter, so line numbers
	   visually align with the editor's own line-number column above/below.
	   Top/bottom borders match .git-diff-peek-inner so the peek's
	   frame is continuous across the gutter and content columns. */
	:global(.git-diff-peek-margin) {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		font-family: var(
			--peek-font-family,
			'SF Mono',
			Monaco,
			Inconsolata,
			'Roboto Mono',
			Consolas,
			'Courier New',
			monospace
		);
		font-size: var(--peek-font-size, 12px);
		letter-spacing: var(--peek-letter-spacing, normal);
		/* Same digits and the same colour Monaco paints its own gutter with. */
		font-variant-numeric: tabular-nums;
		color: var(--vscode-editorLineNumber-foreground, rgba(0, 0, 0, 0.4));
		user-select: none;
		overflow: hidden;
		box-sizing: border-box;
		pointer-events: auto;
		border-top: 1px solid #d4d4d4;
		border-bottom: 1px solid #d4d4d4;
	}
	:global(.git-diff-peek-margin-row-old) {
		background-color: rgba(239, 68, 68, 0.10);
	}
	:global(.git-diff-peek-margin-row-new) {
		background-color: rgba(16, 185, 129, 0.10);
	}
	:global(.dark .git-diff-peek-margin-row-old) {
		background-color: rgba(239, 68, 68, 0.16);
	}
	:global(.dark .git-diff-peek-margin-row-new) {
		background-color: rgba(16, 185, 129, 0.16);
	}
	:global(.dark .git-diff-peek-margin) {
		color: var(--vscode-editorLineNumber-foreground, rgba(255, 255, 255, 0.35));
		border-top-color: #30363d;
		border-bottom-color: #30363d;
	}

	/* padding-right lands the digits on the same right edge as the editor's own
	   line-number column (see applyPeekSizing), so the peek's numbers sit in a
	   straight line with the ones above and below it. */
	:global(.git-diff-peek-margin-row) {
		flex-shrink: 0;
		box-sizing: border-box;
		line-height: var(--peek-line-height, 18px);
		min-height: var(--peek-line-height, 18px);
		padding-right: var(--peek-numbers-pad-right, 10px);
		text-align: right;
	}

	:global(.git-diff-peek-empty) {
		flex: 1;
		display: flex;
		align-items: center;
		padding: 0 16px;
		font-size: var(--peek-font-size, 12px);
		font-style: italic;
		color: rgba(0, 0, 0, 0.5);
	}
	:global(.dark .git-diff-peek-empty) {
		color: rgba(255, 255, 255, 0.5);
	}

	:global(.line-highlight) {
		background-color: rgba(255, 235, 59, 0.3) !important;
		animation: fade-out 3s ease-out forwards;
	}

	:global(.line-highlight-margin) {
		background-color: rgba(255, 235, 59, 0.5) !important;
	}

	/* Inline range highlight for the specific match within a line — sits on top
	   of .line-highlight so a single line with several matches still calls out
	   the one the user actually clicked. */
	:global(.match-highlight) {
		background-color: rgba(250, 204, 21, 0.55) !important;
		border-radius: 2px;
		box-shadow: 0 0 0 1px rgba(202, 138, 4, 0.6);
		animation: match-fade-out 3s ease-out forwards;
	}

	:global(.monaco-editor.vs-dark .line-highlight) {
		background-color: rgba(255, 235, 59, 0.15) !important;
	}

	:global(.monaco-editor.vs-dark .line-highlight-margin) {
		background-color: rgba(255, 235, 59, 0.25) !important;
	}

	:global(.monaco-editor.vs-dark .match-highlight) {
		background-color: rgba(250, 204, 21, 0.35) !important;
		box-shadow: 0 0 0 1px rgba(250, 204, 21, 0.55);
	}

	@keyframes fade-out {
		0% {
			background-color: rgba(255, 235, 59, 0.5);
		}
		100% {
			background-color: transparent;
		}
	}

	@keyframes match-fade-out {
		0% {
			background-color: rgba(250, 204, 21, 0.55);
		}
		100% {
			background-color: transparent;
			box-shadow: 0 0 0 1px transparent;
		}
	}

	:global(.monaco-editor.vs-dark) {
		@keyframes fade-out {
			0% {
				background-color: rgba(255, 235, 59, 0.15);
			}
			100% {
				background-color: transparent;
			}
		}
		@keyframes match-fade-out {
			0% {
				background-color: rgba(250, 204, 21, 0.35);
			}
			100% {
				background-color: transparent;
				box-shadow: 0 0 0 1px transparent;
			}
		}
	}

	:global(.env-gutter-dot) {
		background: #64748b !important;
		width: 6px !important;
		height: 6px !important;
		margin: 5px 0 0 5px !important;
		border-radius: 9999px !important;
		cursor: pointer !important;
	}
	:global(.env-gutter-dot:hover) {
		background: #475569 !important;
	}
	:global(.monaco-editor.vs-dark .env-gutter-dot) {
		background: #94a3b8 !important;
	}
	:global(.monaco-editor.vs-dark .env-gutter-dot:hover) {
		background: #cbd5e1 !important;
	}
</style>
