<script lang="ts">
	import type { FileNode } from '$shared/types/filesystem';
	import LoadingSpinner from '../common/feedback/LoadingSpinner.svelte';
	import MonacoCodeEditor from '../common/editor/MonacoCodeEditor.svelte';
	import MediaPreview from '../common/media/MediaPreview.svelte';
	import MarkdownPreview from '../common/media/MarkdownPreview.svelte';
	import ImageEditor from './ImageEditor.svelte';
	import { themeStore } from '$frontend/stores/ui/theme.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { getFolderIcon } from '$frontend/utils/folder-icon-mappings';
	import { isImageFile, isSvgFile, isPdfFile, isAudioFile, isVideoFile, isBinaryFile, isBinaryContent, isPreviewableFile, isEditableImageFile } from '$frontend/utils/file-type';
	import { formatFileSize } from '$frontend/utils/format';
	import { onMount } from 'svelte';
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { clickOutside } from '$frontend/utils/click-outside';
	import type { IconName } from '$shared/types/ui/icons';
	import type { editor } from 'monaco-editor';
	import { debug } from '$shared/utils/logger';
	import ws from '$frontend/utils/ws';
	import { computeLineDiff, type GutterChange } from '$frontend/utils/line-diff';
	import { gitStatusState } from '$frontend/stores/features/git-status.svelte';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import { revealFile } from '$frontend/stores/ui/file-peek.svelte';
	import { getAiChanges, onAiChange, onAiScrollReveal, consumeAiScrollReveal, getGutterViewMode, setGutterViewMode, onGutterViewModeChange, latestTurnIndex } from '$frontend/utils/ai-changes';
	import type { GutterViewMode, AiChange } from '$frontend/utils/ai-changes';

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
	 * Which AI edits the gutter paints:
	 * - 'all'      → every edit in the loaded conversation
	 * - 'turn'     → every edit from the most recent turn ("Latest AI turn"). Not
	 *                the last tool call — one turn often edits a file repeatedly,
	 *                and showing only the final call hides the rest of the work.
	 * - 'selected' → only `aiSelectedKey`, the edit whose tool row was clicked
	 * The mode is re-resolved on every pass, so it keeps pointing at the right
	 * edits as the conversation grows or a checkpoint restore truncates it.
	 */
	let aiFilter = $state<'all' | 'turn' | 'selected'>('turn');
	/** tool_use id of the edit focused from chat; kept so the user can switch back to it. */
	let aiSelectedKey = $state<string | null>(null);
	/** True when the selected edit's text is no longer anywhere in the file. */
	let aiSelectedMissing = $state(false);
	/** 1-based position of the selected edit among the file's edits (0 = none). */
	let aiSelectedOrdinal = $state(0);
	/**
	 * A reveal request that has been taken off the store but not yet scrolled to.
	 * The request must be claimed the moment we see it because it flips the view to
	 * AI mode — but the pass that sees it is often a *clearing* pass (the view was
	 * still in git mode), so it parks here until a pass that actually paints can
	 * scroll to it. Dropping it there is what made a chat file click land on the
	 * file with no diff shown.
	 */
	let pendingAiRevealKey: string | null = null;
	let hasAiChanges = $state(false);
	let aiChangeCount = $state(0);
	/** Edit indices whose "before" text is known — only those hunks can be discarded. */
	let aiDiscardableEdits = new Set<number>();
	/**
	 * Content of a Write-edited file as it stood immediately before the Write,
	 * keyed by tool_use id. The Write tool records no "before" text, so this is
	 * fetched from the turn's checkpoint snapshot (and then replayed forward past
	 * any earlier edits in the same turn). Without it a Write can only be painted
	 * as "the whole file is new", and has nothing to discard back to.
	 */
	const aiWriteBases = new Map<string, string>();
	/** Write keys whose base is unavailable — don't ask the server twice. */
	const aiWriteBaseMisses = new Set<string>();
	const aiWriteBasePending = new Set<string>();
	let aiMenuOpen = $state(false);
	let gutterMode = $state<GutterViewMode>(getGutterViewMode());
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
		overlayWidget: editor.IOverlayWidget;
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

	// Keyboard shortcut for save
	onMount(() => {
		function handleKeyDown(e: KeyboardEvent) {
			if ((e.ctrlKey || e.metaKey) && e.key === 's') {
				e.preventDefault();
				if (canSave) {
					saveChanges();
				}
			}
		}

		window.addEventListener('keydown', handleKeyDown);

		return () => {
			window.removeEventListener('keydown', handleKeyDown);
			if (gutterUpdateTimer) clearTimeout(gutterUpdateTimer);
			clearTargetTimers();
			scrollListenerDispose?.();
			scrollListenerDispose = null;
			gutterClickDispose?.();
			gutterClickDispose = null;
			if (activeDiffZone) {
				window.removeEventListener('keydown', activeDiffZone.escHandler);
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
			resetAiFilter();
			setGutterViewMode('git');
			closeDiffPeek();
			return;
		}
		if (path === headContentForPath) return;
		headContentForPath = path;
		headContent = null;
		resetAiFilter();
		setGutterViewMode('git');
		closeDiffPeek();

		// Only fetch when git is tracking this file
		if (!gitStatusState.isRepo) return;

		ws.http('files:read-file-at', { projectId, filePath: path, ref: 'HEAD' })
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
			ws.http('files:read-file-at', { projectId, filePath: path, ref: 'HEAD' })
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

	// Sync with external preference changes
	onMount(() => {
		const unsub = onGutterViewModeChange((mode) => {
			gutterMode = mode;
		});
		return unsub;
	});

	const selectedEditLabel = $derived(
		aiSelectedOrdinal > 0 && aiChangeCount > 1 ? ` · ${aiSelectedOrdinal} of ${aiChangeCount}` : ''
	);

	function selectAiFilter(next: 'all' | 'turn' | 'selected') {
		if (next === 'selected' && !aiSelectedKey) return;
		setGutterViewMode('ai');
		aiFilter = next;
		aiMenuOpen = false;
		applyAiChangeDecorations();
		// Move an open peek onto the new scope's first hunk (or close it if the new
		// scope has none) so the peek never outlives the changes it describes.
		refreshActiveDiffPeek();
	}

	/** Reset the AI view to its default (latest turn, nothing pinned). */
	function resetAiFilter() {
		aiFilter = 'turn';
		aiSelectedKey = null;
		aiSelectedMissing = false;
		aiSelectedOrdinal = 0;
		pendingAiRevealKey = null;
		aiWriteBases.clear();
		aiWriteBaseMisses.clear();
		aiWriteBasePending.clear();
	}

	/** Does this edit belong to the current view mode? */
	function isEditInFilter(list: AiChange[], editIdx: number, latestTurn: number): boolean {
		if (aiFilter === 'selected') {
			return aiSelectedKey !== null && list[editIdx].key === aiSelectedKey;
		}
		if (aiFilter === 'turn') return list[editIdx].turnIndex === latestTurn;
		return true;
	}

	/**
	 * Content of the file immediately before `editIdx` ran, or null when unknown.
	 * Edits carry their own "before" text; Writes don't, so they lean on the
	 * checkpoint snapshot fetched by `ensureWriteBase`.
	 */
	function aiBaseContent(list: AiChange[], editIdx: number): string | null {
		const change = list[editIdx];
		if (!change.wholeFile) return change.oldContent;
		return change.key ? aiWriteBases.get(change.key) ?? null : null;
	}

	/**
	 * Walk the file's earlier edits from the same turn onto `preTurnContent`.
	 * Snapshots are captured once per turn, so when a turn touched this file more
	 * than once the snapshot alone lands us at the start of the turn, not at the
	 * moment just before the Write we care about.
	 */
	function replayTurnEdits(list: AiChange[], targetIdx: number, preTurnContent: string): string {
		const turn = list[targetIdx].turnIndex;
		let content = preTurnContent;
		for (let i = 0; i < targetIdx; i++) {
			const earlier = list[i];
			if (earlier.turnIndex !== turn) continue;
			if (earlier.wholeFile) {
				content = earlier.newContent;
				continue;
			}
			const at = content.indexOf(earlier.oldContent);
			if (at < 0) continue;
			content =
				content.slice(0, at) + earlier.newContent + content.slice(at + earlier.oldContent.length);
		}
		return content;
	}

	/** Fetch (once) the pre-write content backing a Write edit's diff and discard. */
	function ensureWriteBase(list: AiChange[], editIdx: number, path: string) {
		const change = list[editIdx];
		const key = change.key;
		if (!change.wholeFile || !key) return;
		if (aiWriteBases.has(key) || aiWriteBaseMisses.has(key) || aiWriteBasePending.has(key)) return;
		if (!change.checkpointMessageId) {
			aiWriteBaseMisses.add(key);
			return;
		}

		aiWriteBasePending.add(key);
		ws.http('snapshot:read-file-before-checkpoint', {
			messageId: change.checkpointMessageId,
			filePath: path
		})
			.then((res) => {
				aiWriteBasePending.delete(key);
				if (res.content === null) {
					aiWriteBaseMisses.add(key);
					return;
				}
				aiWriteBases.set(key, replayTurnEdits(list, editIdx, res.content));
				if (file?.path === path) applyAiChangeDecorations();
			})
			.catch(() => {
				aiWriteBasePending.delete(key);
				aiWriteBaseMisses.add(key);
			});
	}

	/**
	 * Place an edit's hunks onto the file as it stands now. Fast path: the edit's
	 * text is still present verbatim, so every hunk shifts by the same offset.
	 * Otherwise a later edit rewrote part of it — fall back to anchoring each hunk
	 * on its own text, so the surviving parts of the edit still show up instead of
	 * the whole edit silently vanishing.
	 */
	function anchorHunks(
		hunks: GutterChange[],
		editedText: string,
		content: string
	): GutterChange[] {
		const at = content.indexOf(editedText);
		if (at >= 0) {
			const offset = content.substring(0, at).split('\n').length - 1;
			return hunks.map((c) => ({
				...c,
				startLine: c.startLine + offset,
				endLine: c.endLine + offset
			}));
		}

		const anchored: GutterChange[] = [];
		for (const hunk of hunks) {
			// A pure deletion has no surviving text to search for.
			if (hunk.newLines.length === 0) continue;
			const text = hunk.newLines.join('\n');
			const idx = content.indexOf(text);
			if (idx < 0) continue;
			const startLine = content.substring(0, idx).split('\n').length;
			anchored.push({
				...hunk,
				startLine,
				endLine: startLine + hunk.newLines.length - 1
			});
		}
		return anchored;
	}

	// AI change decorations — highlight lines modified by AI (Write/Edit tools)
	function applyAiChangeDecorations(forceClear = false) {
		const editor = monacoEditorRef?.getEditor();
		if (!editor) return;

		const path = file?.path || '';
		if (!path) {
			aiChangeDecorations = editor.deltaDecorations(aiChangeDecorations, []);
			hasAiChanges = false;
			aiChangeCount = 0;
			aiSelectedMissing = false;
			return;
		}

		const allChanges = getAiChanges(path);
		hasAiChanges = allChanges.length > 0;
		aiChangeCount = allChanges.length;

		// A click on a chat tool row pins that exact edit — it's the only way to see
		// what one tool call did to a file that later edits have moved on from.
		const revealKey = consumeAiScrollReveal(path);
		if (revealKey !== null) {
			aiSelectedKey = revealKey;
			aiFilter = 'selected';
			pendingAiRevealKey = revealKey;
			setGutterViewMode('ai');
		}

		// The pinned edit may be gone after a checkpoint restore truncated the
		// conversation — fall back rather than showing an empty gutter forever.
		if (aiFilter === 'selected' && !allChanges.some((c) => c.key === aiSelectedKey)) {
			aiSelectedKey = null;
			aiFilter = 'turn';
		}
		aiSelectedOrdinal = aiSelectedKey
			? allChanges.findIndex((c) => c.key === aiSelectedKey) + 1
			: 0;

		if (forceClear || gutterMode === 'git') {
			aiChangeDecorations = editor.deltaDecorations(aiChangeDecorations, []);
			aiGutterChanges = [];
			aiSelectedMissing = false;
			return;
		}

		if (allChanges.length === 0) {
			aiChangeDecorations = editor.deltaDecorations(aiChangeDecorations, []);
			aiSelectedMissing = false;
			return;
		}

		const merged: Array<GutterChange & { _editIdx: number; _timestamp: number }> = [];
		const latestTurn = latestTurnIndex(allChanges);
		const discardable = new Set<number>();

		for (let editIdx = 0; editIdx < allChanges.length; editIdx++) {
			if (!isEditInFilter(allChanges, editIdx, latestTurn)) continue;

			const change = allChanges[editIdx];
			ensureWriteBase(allChanges, editIdx, path);
			const base = aiBaseContent(allChanges, editIdx);

			let local: GutterChange[];
			if (base === null) {
				// A Write whose "before" text we couldn't recover — all we can honestly
				// say is that the AI produced this content, so mark it whole and leave
				// Discard off (there is nothing to revert to).
				local = computeLineDiff('', change.newContent);
			} else {
				discardable.add(editIdx);
				local = anchorHunks(
					computeLineDiff(base, change.newContent),
					change.newContent,
					editableContent
				);
			}

			for (const gc of local) {
				merged.push({ ...gc, _editIdx: editIdx, _timestamp: change.timestamp });
			}
		}

		aiDiscardableEdits = discardable;
		aiSelectedMissing = aiFilter === 'selected' && merged.length === 0;

		const newDecorations = merged.map((entry) => {
			const { _editIdx, _timestamp, ...change } = entry;

			const options: any = {
				isWholeLine: false,
				linesDecorationsClassName: `ai-gutter-${change.type}`,
				overviewRuler: {
					color: colorForChangeType(change.type),
					position: OVERVIEW_RULER_RIGHT
				}
			};

			return {
				range: {
					startLineNumber: change.startLine,
					startColumn: 1,
					endLineNumber: change.endLine,
					endColumn: 1
				},
				options
			};
		});

		// Store tagged changes for peek
		aiGutterChanges = merged.map(({ _editIdx, _timestamp, ...change }) => ({
			...change,
			editIndex: _editIdx,
			timestamp: _timestamp,
		}));
		aiChangeDecorations = editor.deltaDecorations(aiChangeDecorations, newDecorations);

		// Scroll-reveal: focus the specific edit the user clicked in chat.
		if (pendingAiRevealKey !== null) {
			pendingAiRevealKey = null;
			if (aiGutterChanges.length > 0) {
				const targetChange = aiGutterChanges[0];
				requestAnimationFrame(() => {
					editor.revealLineInCenter(targetChange.startLine);
					editor.setPosition({ lineNumber: targetChange.startLine, column: 1 });
					editor.focus();
					showDiffPeek(targetChange, true);
				});
			} else if (aiSelectedMissing) {
				// Nothing to anchor — show what the tool call recorded instead, so the
				// click still answers "what did this tool do to this file?".
				requestAnimationFrame(() => showRecordedAiPeek());
			}
		}
	}

	/**
	 * Peek the selected edit's recorded before/after when its text is no longer in
	 * the file (a later edit rewrote it, or a checkpoint restore rolled it back).
	 * Read-only: there is no live region to navigate to or discard.
	 */
	function showRecordedAiPeek() {
		const path = file?.path || '';
		if (!path || !aiSelectedKey) return;
		const list = getAiChanges(path);
		const editIdx = list.findIndex((c) => c.key === aiSelectedKey);
		if (editIdx < 0) return;

		const change = list[editIdx];
		const base = aiBaseContent(list, editIdx) ?? '';
		const oldLines = base ? base.split('\n') : [];
		const newLines = change.newContent.split('\n');

		// Anchored at the top and numbered from 1: the recorded text no longer maps
		// onto the file, so borrowing the file's line numbers would be a lie.
		monacoEditorRef?.getEditor()?.revealLine(1);
		showDiffPeek(
			{
				type: oldLines.length > 0 ? 'modified' : 'added',
				startLine: 1,
				endLine: 1,
				oldStartLine: oldLines.length > 0 ? 1 : 0,
				oldEndLine: oldLines.length,
				oldLines,
				newLines,
				editIndex: editIdx,
				timestamp: change.timestamp
			},
			true,
			{ recorded: true }
		);
	}

	// Register callback for AI change notifications (fires when a new change arrives)
	onMount(() => {
		const unregister = onAiChange(() => {
			applyAiChangeDecorations();
		});
		const unregisterReveal = onAiScrollReveal((revealPath) => {
			const currentPath = file?.path || '';
			if (revealPath === currentPath) {
				applyAiChangeDecorations();
			}
		});
		return () => {
			unregister();
			unregisterReveal();
		};
	});

	function scheduleGutterUpdate() {
		if (gutterUpdateTimer) clearTimeout(gutterUpdateTimer);
		gutterUpdateTimer = setTimeout(() => {
			gutterUpdateTimer = null;
			updateGutterDecorations();
		}, 200);
	}

	function colorForChangeType(type: GutterChange['type']): string {
		if (isDark) {
			return type === 'added' ? '#047857' : type === 'modified' ? '#2563eb' : '#b91c1c';
		}
		return type === 'added' ? '#10b981' : type === 'modified' ? '#3b82f6' : '#ef4444';
	}

	function updateGutterDecorations(forceClear = false) {
		const editor = monacoEditorRef?.getEditor();
		if (!editor) return;

		if (forceClear || gutterMode === 'ai') {
			gutterChanges = [];
			gutterDecorations = editor.deltaDecorations(gutterDecorations, []);
			if (activeDiffZone && !activeDiffZone.isAi) {
				closeDiffPeek();
			}
			return;
		}

		// No HEAD content (untracked, missing repo) — clear any existing gutter
		if (headContent === null || headContent === undefined) {
			gutterChanges = [];
			gutterDecorations = editor.deltaDecorations(gutterDecorations, []);
			if (activeDiffZone && !activeDiffZone.isAi) {
				closeDiffPeek();
			}
			return;
		}

		const changes = computeLineDiff(headContent, editableContent);
		gutterChanges = changes;

		// Close any open peek whose anchor line is no longer marked as changed
		if (activeDiffZone && !activeDiffZone.isAi) {
			const stillExists = changes.some(
				(c) => activeDiffZone!.line >= c.startLine && activeDiffZone!.line <= c.endLine
			);
			if (!stillExists) closeDiffPeek();
		}

		const newDecorations = changes.map((change) => {
			const color = colorForChangeType(change.type);
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
					overviewRuler: {
						color,
						position: OVERVIEW_RULER_RIGHT
					}
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

	// Icon SVGs (inline so we can attach them to dynamically-created DOM nodes)
	const ICON_CHEVRON_UP =
		'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 10 8 5 13 10"/></svg>';
	const ICON_CHEVRON_DOWN =
		'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 8 11 13 6"/></svg>';
	const ICON_CLOSE =
		'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
	const ICON_DISCARD =
		'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8a6 6 0 1 0 1.76-4.24"/><polyline points="2 2 2 5 5 5"/></svg>';

	// Buttons inside view zones must intercept pointerdown FIRST — Monaco's
	// cursor-placement uses pointer events, which fire before mousedown, so
	// stopping only mousedown lets Monaco still steal the click.
	function attachPeekButton(btn: HTMLButtonElement, handler: () => void) {
		const stop = (e: Event) => {
			e.stopPropagation();
			e.preventDefault();
		};
		btn.addEventListener('pointerdown', stop);
		btn.addEventListener('mousedown', stop);
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			e.preventDefault();
			handler();
		});
	}

	/**
	 * Rows rendered per side before the peek truncates. A whole-file Write hunk can
	 * carry thousands of lines and every row is a DOM node built synchronously —
	 * the overflow is announced rather than silently dropped.
	 */
	const PEEK_MAX_ROWS = 400;

	function appendPeekRows(target: HTMLElement, lines: string[], side: 'old' | 'new') {
		const shown = Math.min(lines.length, PEEK_MAX_ROWS);
		for (let i = 0; i < shown; i++) {
			const row = document.createElement('div');
			row.className = `git-diff-peek-row git-diff-peek-row-${side}`;
			row.textContent = lines[i].length > 0 ? lines[i] : '\u00A0';
			target.appendChild(row);
		}
		if (lines.length > shown) {
			const more = document.createElement('div');
			more.className = `git-diff-peek-row git-diff-peek-row-${side}`;
			more.textContent = `… ${lines.length - shown} more lines`;
			target.appendChild(more);
		}
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

	// The peek's header is rendered as a Monaco overlay widget instead of
	// inside the view zone's DOM. View zones split into two clipped trees
	// (.margin and .monaco-scrollable-element) so a single in-zone header
	// cannot physically span both columns. An overlay widget sits in
	// .overlayWidgets — a sibling of those clipping containers — so it can
	// span the full editor width as one continuous bar across the gutter
	// and content.
	function buildPeekOverlayHeader(
		change: GutterChange,
		index: number,
		total: number,
		isAi = false,
		recorded = false
	): HTMLElement {
		const root = document.createElement('div');
		root.className = `git-diff-peek-overlay-header git-diff-peek-overlay-header-${change.type}`;

		const title = document.createElement('span');
		title.className = 'git-diff-peek-overlay-title';
		const fileName = file?.name ?? '';
		title.textContent = recorded
			? `${fileName} · recorded change (no longer in the file)`
			: `${fileName} · ${index} of ${total}`;
		root.appendChild(title);

		const actions = document.createElement('div');
		actions.className = 'git-diff-peek-overlay-actions';

		const prevBtn = document.createElement('button');
		prevBtn.className = 'git-diff-peek-iconbtn';
		prevBtn.type = 'button';
		prevBtn.title = 'Previous change';
		prevBtn.setAttribute('aria-label', 'Previous change');
		prevBtn.innerHTML = ICON_CHEVRON_UP;
		prevBtn.disabled = total <= 1 || recorded;
		attachPeekButton(prevBtn, () => navigatePeek(-1));
		actions.appendChild(prevBtn);

		const nextBtn = document.createElement('button');
		nextBtn.className = 'git-diff-peek-iconbtn';
		nextBtn.type = 'button';
		nextBtn.title = 'Next change';
		nextBtn.setAttribute('aria-label', 'Next change');
		nextBtn.innerHTML = ICON_CHEVRON_DOWN;
		nextBtn.disabled = total <= 1 || recorded;
		attachPeekButton(nextBtn, () => navigatePeek(1));
		actions.appendChild(nextBtn);

		// Discard reverts the hunk to whatever it replaced: HEAD for a git hunk, the
		// AI edit's own "before" text for an AI hunk. A recorded peek has no live
		// lines to act on, and a Write with no recovered base has nothing to revert to.
		const canDiscard = recorded
			? false
			: !isAi || (change.editIndex !== undefined && aiDiscardableEdits.has(change.editIndex));
		if (canDiscard) {
			const discardBtn = document.createElement('button');
			discardBtn.className = 'git-diff-peek-discard-btn';
			discardBtn.type = 'button';
			discardBtn.title = isAi
				? 'Discard this change (revert to the content before this AI edit)'
				: 'Discard this change (revert to HEAD)';
			discardBtn.setAttribute('aria-label', 'Discard this change');
			discardBtn.innerHTML = `${ICON_DISCARD}<span>Discard</span>`;
			attachPeekButton(discardBtn, () => discardHunk(change));
			actions.appendChild(discardBtn);
		}

		const closeBtn = document.createElement('button');
		closeBtn.className = 'git-diff-peek-iconbtn git-diff-peek-close';
		closeBtn.type = 'button';
		closeBtn.title = 'Close (Esc)';
		closeBtn.setAttribute('aria-label', 'Close diff preview');
		closeBtn.innerHTML = ICON_CLOSE;
		attachPeekButton(closeBtn, () => closeDiffPeek());
		actions.appendChild(closeBtn);

		root.appendChild(actions);
		return root;
	}

	function navigatePeek(direction: 1 | -1) {
		if (!activeDiffZone) return;
		const changes = getActiveChanges(activeDiffZone.isAi);
		if (changes.length === 0) return;
		const currentLine = activeDiffZone.line;
		const currentIdx = changes.findIndex(
			(c) => c.startLine === currentLine
		);
		if (currentIdx === -1) return;
		const nextIdx =
			(currentIdx + direction + changes.length) % changes.length;
		const next = changes[nextIdx];
		const editor = monacoEditorRef?.getEditor();
		if (editor) editor.revealLineInCenter(next.startLine);
		showDiffPeek(next, activeDiffZone.isAi);
	}

	function applyPeekSizing(editorInstance: editor.IStandaloneCodeEditor, domNode: HTMLElement) {
		const layoutInfo = editorInstance.getLayoutInfo();
		// Constrain peek width to the visible content viewport so the action
		// buttons stay reachable when the source has long lines.
		const fontSize = Math.round(settings.fontSize * 0.9);
		const lineHeight = Math.round(fontSize * 1.5);
		// Match the editor's tab width so leading tabs in the peek body align
		// 1:1 with the editor's content above/below.
		const tabSize = editorInstance.getModel()?.getOptions().tabSize ?? 2;
		domNode.style.setProperty('--peek-viewport-width', `${layoutInfo.contentWidth}px`);
		domNode.style.setProperty('--peek-font-size', `${fontSize}px`);
		domNode.style.setProperty('--peek-line-height', `${lineHeight}px`);
		domNode.style.setProperty('--peek-tab-size', String(tabSize));
	}

	function applyPeekScroll(domNode: HTMLElement, scrollLeft: number) {
		// Cancel out the parent view-zone container's horizontal scroll so the
		// peek stays anchored to the editor's visible left edge.
		domNode.style.transform = `translateX(${scrollLeft}px)`;
	}

	function showDiffPeek(change: GutterChange, isAi = false, opts?: { recorded?: boolean }) {
		const editorInstance = monacoEditorRef?.getEditor();
		if (!editorInstance) return;

		closeDiffPeek();

		const recorded = opts?.recorded === true;
		const changes = getActiveChanges(isAi);
		const foundIdx = changes.findIndex(c => c.startLine === change.startLine && c.type === change.type);
		const index = recorded || foundIdx < 0 ? 1 : foundIdx + 1;
		const total = recorded ? 1 : changes.length;
		const domNode = buildPeekDom(change, isAi);
		const marginDomNode = buildPeekMargin(change);
		const overlayHeader = buildPeekOverlayHeader(change, index, total, isAi, recorded);
		applyPeekSizing(editorInstance, domNode);
		applyPeekScroll(domNode, editorInstance.getScrollLeft());

		// Monaco attaches mouse/pointer listeners on its view container in
		// capture phase, so a bubble-phase stopPropagation on the peek root
		// fires *after* Monaco already received the event. Listen on document
		// in capture phase instead — we run before any ancestor handler and
		// only stop events whose target lies inside the peek. We deliberately
		// don't capture click/dblclick: cursor positioning happens on
		// mouse/pointer-down, while the peek's header buttons rely on click
		// events reaching their handlers.
		const swallowIfInside = (e: Event) => {
			const target = e.target as Node | null;
			if (
				target &&
				(domNode.contains(target) ||
					marginDomNode.contains(target) ||
					overlayHeader.contains(target))
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
		const wheelHandler = (e: WheelEvent) => {
			const target = e.target as Node | null;
			if (!target) return;
			if (
				!domNode.contains(target) &&
				!marginDomNode.contains(target) &&
				!overlayHeader.contains(target)
			)
				return;
			e.stopPropagation();
			e.preventDefault();
			if (innerEl) {
				innerEl.scrollTop += e.deltaY;
				innerEl.scrollLeft += e.deltaX;
				// Sync the margin (line numbers) so it scrolls in lockstep
				// with the body. They live in separate clipped DOM trees
				// (Monaco splits view-zone content and margin), so a single
				// overflow container can't span both.
				marginDomNode.scrollTop = innerEl.scrollTop;
			}
		};
		document.addEventListener('wheel', wheelHandler, { capture: true, passive: false });

		const detachSwallow = () => {
			for (const evt of captureEvents) {
				document.removeEventListener(evt, swallowIfInside, true);
			}
			document.removeEventListener('wheel', wheelHandler, true);
		};

		const afterLineNumber = Math.max(0, change.startLine - 1);
		const fontSize = Math.round(settings.fontSize * 0.9);
		const editorLineHeight = Math.round(fontSize * 1.5);
		const HEADER_PX = 28;
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
		const heightInPx = HEADER_PX + contentPx + 6;

		const widgetId = `git-diff-peek-overlay-${change.startLine}-${Date.now()}`;
		const overlayWidget: editor.IOverlayWidget = {
			getId: () => widgetId,
			getDomNode: () => overlayHeader,
			// Returning null lets us position the overlay manually via the
			// view zone's onDomNodeTop callback, so the header stays glued to
			// the top of the peek as the editor scrolls vertically.
			getPosition: () => null
		};
		editorInstance.addOverlayWidget(overlayWidget);
		// Hide until the view zone reports a valid top — avoids a frame of
		// the overlay rendering at top:0 before Monaco lays out the zone.
		overlayHeader.style.visibility = 'hidden';

		let zoneId = '';
		editorInstance.changeViewZones((accessor) => {
			zoneId = accessor.addZone({
				afterLineNumber,
				heightInPx,
				domNode,
				marginDomNode,
				suppressMouseDown: true,
				onDomNodeTop: (top: number) => {
					overlayHeader.style.top = `${top}px`;
					overlayHeader.style.visibility = '';
				}
			});
		});

		const escHandler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				closeDiffPeek();
			}
		};
		window.addEventListener('keydown', escHandler);

		const scrollDisposable = editorInstance.onDidScrollChange((e) => {
			if (e.scrollLeftChanged) applyPeekScroll(domNode, e.scrollLeft);
		});
		const layoutDisposable = editorInstance.onDidLayoutChange(() => {
			applyPeekSizing(editorInstance, domNode);
		});

		activeDiffZone = {
			id: zoneId,
			line: change.startLine,
			isAi,
			escHandler,
			domNode,
			overlayWidget,
			scrollDispose: () => scrollDisposable.dispose(),
			layoutDispose: () => layoutDisposable.dispose(),
			detachSwallow
		};
	}

	function getActiveChanges(isAi: boolean): GutterChange[] {
		return isAi ? aiGutterChanges : gutterChanges;
	}

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
		const { id, escHandler, scrollDispose, layoutDispose, detachSwallow, overlayWidget } =
			activeDiffZone;
		activeDiffZone = null;
		window.removeEventListener('keydown', escHandler);
		scrollDispose();
		layoutDispose();
		detachSwallow();
		if (editorInstance) {
			editorInstance.removeOverlayWidget(overlayWidget);
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
			window.removeEventListener('keydown', activeDiffZone.escHandler);
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
		// User edits invalidate the captured HEAD-side hunk in the peek; close it
		if (activeDiffZone) closeDiffPeek();
		scheduleGutterUpdate();
		// Re-apply AI decorations against the new content. The store is derived from
		// the conversation, so editing never destroys it — hunks whose text no longer
		// appears simply drop out and reappear if the user reverts.
		applyAiChangeDecorations();
	}

	export function getEditorScrollTop(): number {
		return monacoEditorRef?.getScrollTop?.() ?? 0;
	}

	export function resetRevealFilter() {
		resetAiFilter();
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

	function saveBlob(blob: Blob, name: string) {
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = name;
		a.click();
		URL.revokeObjectURL(url);
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

		// Binary / media files: fetch the original bytes from disk so the download
		// is byte-for-byte intact. `preview` is omitted so transcodable formats
		// (TIFF/HEIC) download in their original format, not a PNG copy.
		try {
			const response = await ws.http('files:read-content', { path: file.path });
			const binaryString = atob(response.content);
			const bytes = new Uint8Array(binaryString.length);
			for (let i = 0; i < binaryString.length; i++) {
				bytes[i] = binaryString.charCodeAt(i);
			}
			saveBlob(new Blob([bytes], { type: response.contentType || 'application/octet-stream' }), file.name);
		} catch (err) {
			debug.error('file', 'Failed to download file:', err);
		}
	}
</script>

{#if file}
	<div class="w-full h-full flex flex-col">
		<!-- Header -->
		{#if !hideHeader}
		<div class="flex-shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-700">
			<div class="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
				<Icon name={getDisplayIcon(file.name, file.type === 'directory')} class="w-7 h-7" />
				<div class="min-w-0 flex-1">
					<h3 id={titleId} class="text-xs sm:text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
						{file.name}
					</h3>
					<p class="text-xs text-slate-600 dark:text-slate-400 truncate mt-0.5">
						<span class="hidden sm:inline">{displayPath} • </span> {formatFileSize(file.size || 0)}
					</p>
				</div>
			</div>

			<div class="flex items-center gap-1.5 sm:gap-1 flex-shrink-0">
				<!-- SVG view mode toggle -->
				{#if file && file.type === 'file' && isSvgFile(file.name)}
					<div class="flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/60">
						<button
							class="flex items-center px-2 py-1 rounded-md text-xs font-semibold transition-all duration-200 {svgViewMode === 'visual' ? 'text-violet-700 dark:text-violet-300 bg-violet-100 dark:bg-violet-900/60 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}"
							onclick={() => { svgViewMode = 'visual'; }}
							title="Visual preview"
						>
							<Icon name="lucide:eye" class="w-3.5 h-3.5" />
						</button>
						<button
							class="flex items-center px-2 py-1 rounded-md text-xs font-semibold transition-all duration-200 {svgViewMode === 'code' ? 'text-violet-700 dark:text-violet-300 bg-violet-100 dark:bg-violet-900/60 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}"
							onclick={() => { svgViewMode = 'code'; }}
							title="Code view"
						>
							<Icon name="lucide:code" class="w-3.5 h-3.5" />
						</button>
					</div>
				{/if}

				<!-- Markdown view mode toggle -->
				{#if isMarkdown}
					<div class="flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/60">
						<button
							class="flex items-center px-2 py-1 rounded-md text-xs font-semibold transition-all duration-200 {mdViewMode === 'visual' ? 'text-violet-700 dark:text-violet-300 bg-violet-100 dark:bg-violet-900/60 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}"
							onclick={() => switchMdMode('visual')}
							title="Rendered markdown preview"
						>
							<Icon name="lucide:book-open" class="w-3.5 h-3.5" />
						</button>
						<button
							class="flex items-center px-2 py-1 rounded-md text-xs font-semibold transition-all duration-200 {mdViewMode === 'code' ? 'text-violet-700 dark:text-violet-300 bg-violet-100 dark:bg-violet-900/60 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}"
							onclick={() => switchMdMode('code')}
							title="Source view"
						>
							<Icon name="lucide:code" class="w-3.5 h-3.5" />
						</button>
					</div>
				{/if}

				<!-- External change badge + refresh button -->
				{#if externallyChanged && onForceReload}
					<div class="flex items-center gap-1 mr-1">
						<span class="text-3xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-400 font-medium whitespace-nowrap">
							Changed externally
						</span>
						<button
							class="flex p-1.5 text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/30 rounded-lg transition-all duration-200"
							onclick={onForceReload}
							title="Reload file from disk (discard local changes)"
						>
							<Icon name="lucide:refresh-cw" class="w-4 h-4" />
						</button>
					</div>
				{/if}

				<!-- Actions for editable files -->
				{#if file && file.type === 'file' && !isBinary && !isBinaryContent(content) && !isImageFile(file.name) && !isBinaryFile(file.name) && !isPdfFile(file.name) && !isAudioFile(file.name) && !isVideoFile(file.name) && !(isSvgFile(file.name) && svgViewMode === 'visual') && !(isMarkdown && mdViewMode === 'visual')}
					<!-- Env values toggle -->
					{#if isEnvFile}
						<button
							class="flex p-2 rounded-lg transition-all duration-200
							{!hideEnvValues ?
								'text-violet-600 dark:text-violet-400 bg-violet-100 dark:bg-violet-900/50' :
								'text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30'
							}"
							onclick={() => { hideEnvValues = !hideEnvValues; }}
							title={hideEnvValues ? 'Show values' : 'Hide values'}
						>
							<Icon name={hideEnvValues ? 'lucide:eye-off' : 'lucide:eye'} class="w-4 h-4" />
						</button>
					{/if}
					<!-- Gutter view mode: segmented AI | Git. The AI pill doubles as a
					     dropdown scoping which edits the gutter paints (all / latest
					     turn / the one edit clicked in chat). -->
					{#if hasAiChanges}
						<div
							class="relative flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/60"
							role="group"
							aria-label="Gutter view mode"
							use:clickOutside={() => (aiMenuOpen = false)}
						>
							<button
								class="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold transition-all duration-200 {gutterMode === 'ai' ?
									'text-violet-700 dark:text-violet-300 bg-violet-100 dark:bg-violet-900/60 shadow-sm' :
									'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
								}"
								onclick={() => {
									setGutterViewMode('ai');
									if (aiChangeCount >= 1) aiMenuOpen = !aiMenuOpen;
								}}
								aria-pressed={gutterMode === 'ai'}
								aria-haspopup={aiChangeCount >= 1 ? 'menu' : undefined}
								aria-expanded={aiChangeCount >= 1 ? aiMenuOpen : undefined}
								title="Show AI changes"
							>
								<Icon name="lucide:sparkles" class="w-3.5 h-3.5" />
								{#if aiChangeCount >= 1}
									<Icon name="lucide:chevron-down" class="w-3 h-3 opacity-70" />
								{/if}
							</button>
							<button
								class="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold transition-all duration-200 {gutterMode === 'git' ?
									'text-sky-700 dark:text-sky-300 bg-sky-100 dark:bg-sky-900/60 shadow-sm' :
									'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
								}"
								onclick={() => {
									setGutterViewMode('git');
									aiMenuOpen = false;
								}}
								aria-pressed={gutterMode === 'git'}
								title="Show Git changes"
							>
								<Icon name="lucide:git-branch" class="w-3.5 h-3.5" />
							</button>

							{#if aiMenuOpen && aiChangeCount >= 1}
								<div
									class="absolute top-full left-0 mt-1 w-52 py-1 bg-white dark:bg-slate-800 border border-violet-500/20 rounded-lg shadow-2xl shadow-slate-900/20 dark:shadow-black/40 z-50 overflow-hidden"
									role="menu"
									transition:scale={{ duration: 150, easing: cubicOut, start: 0.95, opacity: 0 }}
								>
									<button
										class="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-200 hover:bg-violet-500/10 transition-colors"
										role="menuitemradio"
										aria-checked={aiFilter === 'all'}
										onclick={() => selectAiFilter('all')}
									>
										<Icon name="lucide:check" class="w-3.5 h-3.5 text-violet-600 dark:text-violet-400 {aiFilter === 'all' ? '' : 'opacity-0'}" />
										<span>All AI changes</span>
									</button>
									<button
										class="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-200 hover:bg-violet-500/10 transition-colors"
										role="menuitemradio"
										aria-checked={aiFilter === 'turn'}
										onclick={() => selectAiFilter('turn')}
									>
										<Icon name="lucide:check" class="w-3.5 h-3.5 text-violet-600 dark:text-violet-400 {aiFilter === 'turn' ? '' : 'opacity-0'}" />
										<span>Latest AI turn</span>
									</button>
									{#if aiSelectedKey}
										<button
											class="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-200 hover:bg-violet-500/10 transition-colors"
											role="menuitemradio"
											aria-checked={aiFilter === 'selected'}
											onclick={() => selectAiFilter('selected')}
										>
											<Icon name="lucide:check" class="w-3.5 h-3.5 text-violet-600 dark:text-violet-400 {aiFilter === 'selected' ? '' : 'opacity-0'}" />
											<span class="min-w-0 truncate">Selected AI change{selectedEditLabel}</span>
										</button>
									{/if}
								</div>
							{/if}
						</div>
					{/if}
					<!-- Word Wrap toggle -->
					{#if onToggleWordWrap}
						<button
							class="flex p-2 rounded-lg transition-all duration-200
							{wordWrap ?
								'text-violet-600 dark:text-violet-400 bg-violet-100 dark:bg-violet-900/50' :
								'text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30'
							}"
							onclick={onToggleWordWrap}
							title="Toggle Word Wrap"
						>
							<Icon name="lucide:wrap-text" class="w-4 h-4" />
						</button>
					{/if}
					<!-- Save button -->
					<button
						class="flex p-2 text-green-600 dark:text-green-400 hover:text-green-700 dark:hover:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/30 rounded-lg transition-all duration-200 {saveButtonDisabled ? 'opacity-50 cursor-not-allowed' : ''}"
						onclick={() => {
							if (canSave) {
								saveChanges();
							}
						}}
						disabled={saveButtonDisabled}
						title={saveButtonDisabled ? (hasChanges ? 'Saving...' : 'No changes to save') : 'Save changes (Ctrl+S)'}
					>
						{#if isSaving}
							<div class="w-4 h-4 border-2 border-green-600 border-t-transparent rounded-full animate-spin"></div>
						{:else}
							<Icon name="lucide:save" class="w-4 h-4" />
						{/if}
					</button>

					{#if editableContent}
						<button
							class="flex p-2 text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30 rounded-lg transition-all duration-200"
							onclick={copyToClipboard}
							title="Copy content"
						>
							<Icon name="lucide:copy" class="w-4 h-4" />
						</button>
					{/if}
				{:else if file && file.type === 'file'}
					<!-- Edit button for raster images the editor can round-trip -->
					{#if canEditImage}
						<button
							class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-white bg-violet-600 hover:bg-violet-700 rounded-lg transition-all duration-200"
							onclick={() => { showImageEditor = true; }}
							title="Edit image"
						>
							<Icon name="lucide:pencil" class="w-3.5 h-3.5" /> Edit
						</button>
					{/if}
				{/if}

				<!-- Close, when the viewer is hosted in a modal that has no chrome of
				     its own. Sits outside the editable/preview branches so every file
				     type keeps a way out. -->
				{#if onClose}
					<button
						type="button"
						class="flex p-2 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-all duration-200"
						onclick={onClose}
						title="Close (Esc)"
						aria-label="Close"
					>
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
				{/if}
			</div>
		</div>
		{/if}

		<!-- The pinned edit exists in the conversation but not in the file any more.
		     Say so rather than showing an empty gutter that reads as "no changes". -->
		{#if gutterMode === 'ai' && aiFilter === 'selected' && aiSelectedMissing}
			<div class="flex-shrink-0 flex items-center gap-2 px-4 py-1.5 text-2xs bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-900/40 text-amber-800 dark:text-amber-300">
				<Icon name="lucide:info" class="w-3.5 h-3.5 shrink-0" />
				<span class="min-w-0 truncate">
					This change is no longer in the file — a later edit replaced it, or a checkpoint was restored.
				</span>
				<button
					type="button"
					class="ml-auto shrink-0 px-2 py-0.5 rounded-md font-medium bg-amber-100 dark:bg-amber-900/40 hover:bg-amber-200 dark:hover:bg-amber-900/70 transition-colors"
					onclick={showRecordedAiPeek}
				>
					View recorded diff
				</button>
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
										minimap: { enabled: false },
										wordWrap: 'off',
										renderWhitespace: 'none',
										mouseWheelZoom: false,
										overviewRulerLanes: 1,
										overviewRulerBorder: false
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
					<button
						class="px-6 py-2.5 bg-violet-600 text-white rounded-xl hover:bg-violet-700 transition-all duration-200"
						onclick={downloadFile}
					>
						Download File
					</button>
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
									minimap: { enabled: false },
									wordWrap: wordWrap ? 'on' : 'off',
									renderWhitespace: 'none',
									mouseWheelZoom: false,
									overviewRulerLanes: 1,
									overviewRulerBorder: false
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
									minimap: { enabled: false },
									wordWrap: wordWrap ? 'on' : 'off',
									renderWhitespace: 'none',
									mouseWheelZoom: false,
									overviewRulerLanes: 1,
									overviewRulerBorder: false
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
	   lines are reachable. The action buttons live in a Monaco overlay widget
	   outside the peek inner, so they stay accessible regardless of scroll. */
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
		font-family: 'SF Mono', Monaco, Inconsolata, 'Roboto Mono', Consolas, 'Courier New',
			monospace;
		font-size: var(--peek-font-size, 12px);
		background-color: #ffffff;
		border-top: 1px solid #d4d4d4;
		border-bottom: 1px solid #d4d4d4;
		padding-top: 28px;
		overflow-y: auto;
		overflow-x: auto;
		box-sizing: border-box;
		pointer-events: auto;
	}
	:global(.dark .git-diff-peek-inner) {
		background-color: #0d1117;
		border-top-color: #30363d;
		border-bottom-color: #30363d;
	}

	/* Merged peek header — a Monaco overlay widget positioned above the
	   editor so it can span the gutter and content columns as one
	   continuous bar (view zones split into two clipped DOM trees and
	   cannot host a single full-width child). top is set imperatively by
	   the view zone's onDomNodeTop callback. */
	:global(.git-diff-peek-overlay-header) {
		position: absolute;
		left: 0;
		right: 0;
		display: flex;
		align-items: center;
		box-sizing: border-box;
		height: 29px;
		padding: 0 8px 0 12px;
		font-family: 'SF Mono', Monaco, Inconsolata, 'Roboto Mono', Consolas, 'Courier New',
			monospace;
		font-size: 11px;
		font-weight: 600;
		color: #444;
		background-color: #f3f3f3;
		border-bottom: 1px solid #e0e0e0;
		z-index: 5;
		pointer-events: auto;
	}
	:global(.dark .git-diff-peek-overlay-header) {
		color: #c9d1d9;
		background-color: #161b22;
		border-bottom-color: #30363d;
	}

	/* Type-tinted headers — green for added, red for deleted, blue for
	   modified. The gutter bar already uses the same hues; mirroring them
	   on the header makes the peek's type identifiable at a glance. */
	:global(.git-diff-peek-added .git-diff-peek-overlay-header) {
		background-color: #ecfdf5;
		border-bottom-color: #a7f3d0;
		color: #047857;
	}
	:global(.dark .git-diff-peek-added .git-diff-peek-overlay-header) {
		background-color: #052e2b;
		border-bottom-color: #065f46;
		color: #6ee7b7;
	}
	:global(.git-diff-peek-deleted .git-diff-peek-overlay-header) {
		background-color: #fef2f2;
		border-bottom-color: #fecaca;
		color: #b91c1c;
	}
	:global(.dark .git-diff-peek-deleted .git-diff-peek-overlay-header) {
		background-color: #2b0a0a;
		border-bottom-color: #7f1d1d;
		color: #fca5a5;
	}
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

	:global(.git-diff-peek-overlay-title) {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.git-diff-peek-overlay-actions) {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 2px;
		margin-left: 8px;
	}

	:global(.git-diff-peek-iconbtn) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		padding: 0;
		background: transparent;
		border: none;
		border-radius: 4px;
		color: inherit;
		cursor: pointer;
		opacity: 0.65;
		pointer-events: auto;
		z-index: 1;
	}
	:global(.git-diff-peek-iconbtn:hover:not(:disabled)) {
		background-color: rgba(0, 0, 0, 0.08);
		opacity: 1;
	}
	:global(.dark .git-diff-peek-iconbtn:hover:not(:disabled)) {
		background-color: rgba(255, 255, 255, 0.12);
	}
	:global(.git-diff-peek-iconbtn:disabled) {
		opacity: 0.3;
		cursor: default;
	}

	:global(.git-diff-peek-discard-btn) {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 0 8px;
		height: 22px;
		background: transparent;
		border: none;
		border-radius: 4px;
		color: inherit;
		cursor: pointer;
		opacity: 0.65;
		font-size: 11px;
		white-space: nowrap;
		pointer-events: auto;
		z-index: 1;
	}
	:global(.git-diff-peek-discard-btn:hover) {
		background-color: rgba(0, 0, 0, 0.08);
		opacity: 1;
	}
	:global(.dark .git-diff-peek-discard-btn:hover) {
		background-color: rgba(255, 255, 255, 0.12);
	}

	:global(.git-diff-peek-body) {
		flex: none;
		min-width: 0;
		overflow: visible;
		color: #333;
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
	:global(.dark .git-diff-peek-body-old) {
		color: #e6edf3;
	}
	:global(.dark .git-diff-peek-body-new) {
		color: #e6edf3;
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
	:global(.git-diff-peek-modified .git-diff-peek-overlay-header) {
		background-color: #eff6ff;
		border-bottom-color: #bfdbfe;
		color: #1e40af;
	}
	:global(.dark .git-diff-peek-modified .git-diff-peek-overlay-header) {
		background-color: #172554;
		border-bottom-color: #1e3a8a;
		color: #93c5fd;
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
	   padding-top reserves the strip where the overlay header sits, so the
	   first line-number row aligns with the first body row on the content
	   side. Top/bottom borders match .git-diff-peek-inner so the peek's
	   frame is continuous across the gutter and content columns. */
	:global(.git-diff-peek-margin) {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		font-family: 'SF Mono', Monaco, Inconsolata, 'Roboto Mono', Consolas, 'Courier New',
			monospace;
		font-size: var(--peek-font-size, 12px);
		color: rgba(0, 0, 0, 0.4);
		user-select: none;
		overflow: hidden;
		box-sizing: border-box;
		pointer-events: auto;
		border-top: 1px solid #d4d4d4;
		border-bottom: 1px solid #d4d4d4;
		padding-top: 28px;
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
		color: rgba(255, 255, 255, 0.35);
		border-top-color: #30363d;
		border-bottom-color: #30363d;
	}

	:global(.git-diff-peek-margin-row) {
		flex-shrink: 0;
		line-height: var(--peek-line-height, 18px);
		min-height: var(--peek-line-height, 18px);
		padding-right: 10px;
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
