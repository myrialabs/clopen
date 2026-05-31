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
	import type { IconName } from '$shared/types/ui/icons';
	import type { editor } from 'monaco-editor';
	import { debug } from '$shared/utils/logger';
	import ws from '$frontend/utils/ws';
	import { computeLineDiff, type GutterChange } from '$frontend/utils/line-diff';
	import { gitStatusState } from '$frontend/stores/features/git-status.svelte';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import { requestRevealFile } from '$frontend/stores/core/files.svelte';

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
		onEditorScroll
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

	let monacoEditorRef: MonacoEditorComponent | null = $state(null);

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
	let gutterChanges: GutterChange[] = [];
	let headContent = $state<string | null>(null);
	let headContentForPath = '';
	let pendingScrollRestore: number | null = null;
	let scrollListenerDispose: (() => void) | null = null;
	let gutterUpdateTimer: ReturnType<typeof setTimeout> | null = null;
	let gutterClickDispose: (() => void) | null = null;
	let activeDiffZone: {
		id: string;
		line: number;
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
		requestRevealFile(resolved);
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
			return;
		}
		if (path === headContentForPath) return;
		headContentForPath = path;
		headContent = null;

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

	function scheduleGutterUpdate() {
		if (gutterUpdateTimer) clearTimeout(gutterUpdateTimer);
		gutterUpdateTimer = setTimeout(() => {
			gutterUpdateTimer = null;
			updateGutterDecorations();
		}, 200);
	}

	function colorForChangeType(type: GutterChange['type']): string {
		if (isDark) {
			return type === 'added' ? '#047857' : type === 'modified' ? '#b45309' : '#b91c1c';
		}
		return type === 'added' ? '#10b981' : type === 'modified' ? '#f59e0b' : '#ef4444';
	}

	function updateGutterDecorations() {
		const editor = monacoEditorRef?.getEditor();
		if (!editor) return;

		// No HEAD content (untracked, missing repo) — clear any existing gutter
		if (headContent === null || headContent === undefined) {
			gutterChanges = [];
			gutterDecorations = editor.deltaDecorations(gutterDecorations, []);
			closeDiffPeek();
			return;
		}

		const changes = computeLineDiff(headContent, editableContent);
		gutterChanges = changes;

		// Close any open peek whose anchor line is no longer marked as changed
		if (activeDiffZone) {
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

	function findChangeAtLine(line: number): GutterChange | null {
		for (const change of gutterChanges) {
			if (line >= change.startLine && line <= change.endLine) return change;
		}
		return null;
	}

	// Icon SVGs (inline so we can attach them to dynamically-created DOM nodes)
	const ICON_CHEVRON_UP =
		'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 10 8 5 13 10"/></svg>';
	const ICON_CHEVRON_DOWN =
		'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 8 11 13 6"/></svg>';
	const ICON_CLOSE =
		'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';

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

	function buildPeekDom(change: GutterChange): HTMLElement {
		const root = document.createElement('div');
		root.className = `git-diff-peek git-diff-peek-${change.type}`;

		const inner = document.createElement('div');
		inner.className = 'git-diff-peek-inner';
		root.appendChild(inner);

		if (change.oldLines.length > 0) {
			const body = document.createElement('div');
			body.className = 'git-diff-peek-body';
			// Inner content track is sized to max-content so it widens past
			// the body when any row's text overflows — that's what makes the
			// body's overflow:auto produce a horizontal scrollbar. Block-level
			// row children alone fill the body width and never trigger scroll.
			const bodyContent = document.createElement('div');
			bodyContent.className = 'git-diff-peek-body-content';
			body.appendChild(bodyContent);
			change.oldLines.forEach((line) => {
				const row = document.createElement('div');
				row.className = 'git-diff-peek-row';
				// No line-number column here — line numbers render in the
				// marginDomNode so the text aligns with the editor's content
				// area below. Preserve indentation via white-space: pre.
				row.textContent = line.length > 0 ? line : '\u00A0';
				bodyContent.appendChild(row);
			});
			inner.appendChild(body);
		} else {
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

		// padding-top on .git-diff-peek-margin reserves the header-row strip
		// where the overlay widget sits, so the first line-number row aligns
		// with the first body row on the content side.
		change.oldLines.forEach((_, idx) => {
			const row = document.createElement('div');
			row.className = 'git-diff-peek-margin-row';
			row.textContent = String(change.oldStartLine + idx);
			margin.appendChild(row);
		});

		return margin;
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
		total: number
	): HTMLElement {
		const root = document.createElement('div');
		root.className = `git-diff-peek-overlay-header git-diff-peek-overlay-header-${change.type}`;

		const title = document.createElement('span');
		title.className = 'git-diff-peek-overlay-title';
		const fileName = file?.name ?? '';
		title.textContent = `${fileName} · ${index} of ${total}`;
		root.appendChild(title);

		const actions = document.createElement('div');
		actions.className = 'git-diff-peek-overlay-actions';

		const prevBtn = document.createElement('button');
		prevBtn.className = 'git-diff-peek-iconbtn';
		prevBtn.type = 'button';
		prevBtn.title = 'Previous change';
		prevBtn.setAttribute('aria-label', 'Previous change');
		prevBtn.innerHTML = ICON_CHEVRON_UP;
		prevBtn.disabled = total <= 1;
		attachPeekButton(prevBtn, () => navigatePeek(-1));
		actions.appendChild(prevBtn);

		const nextBtn = document.createElement('button');
		nextBtn.className = 'git-diff-peek-iconbtn';
		nextBtn.type = 'button';
		nextBtn.title = 'Next change';
		nextBtn.setAttribute('aria-label', 'Next change');
		nextBtn.innerHTML = ICON_CHEVRON_DOWN;
		nextBtn.disabled = total <= 1;
		attachPeekButton(nextBtn, () => navigatePeek(1));
		actions.appendChild(nextBtn);

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
		if (!activeDiffZone || gutterChanges.length === 0) return;
		const currentLine = activeDiffZone.line;
		const currentIdx = gutterChanges.findIndex(
			(c) => c.startLine === currentLine
		);
		if (currentIdx === -1) return;
		const nextIdx =
			(currentIdx + direction + gutterChanges.length) % gutterChanges.length;
		const next = gutterChanges[nextIdx];
		const editor = monacoEditorRef?.getEditor();
		if (editor) editor.revealLineInCenter(next.startLine);
		showDiffPeek(next);
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

	function showDiffPeek(change: GutterChange) {
		const editorInstance = monacoEditorRef?.getEditor();
		if (!editorInstance) return;

		closeDiffPeek();

		const index = gutterChanges.indexOf(change) + 1;
		const total = gutterChanges.length;
		const domNode = buildPeekDom(change);
		const marginDomNode = buildPeekMargin(change);
		const overlayHeader = buildPeekOverlayHeader(change, index, total);
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
		const bodyEl = domNode.querySelector<HTMLElement>('.git-diff-peek-body');
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
			if (bodyEl) {
				bodyEl.scrollLeft += e.deltaX;
				bodyEl.scrollTop += e.deltaY;
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
		const contentLines = change.oldLines.length;
		const contentPx =
			contentLines > 0 ? contentLines * editorLineHeight : editorLineHeight;
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
			escHandler,
			domNode,
			overlayWidget,
			scrollDispose: () => scrollDisposable.dispose(),
			layoutDispose: () => layoutDisposable.dispose(),
			detachSwallow
		};
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
			const change = findChangeAtLine(line);
			if (!change) return;
			if (activeDiffZone && activeDiffZone.line === change.startLine) {
				closeDiffPeek();
			} else {
				showDiffPeek(change);
			}
		});
		gutterClickDispose = () => disposable.dispose();
	}

	// Called by MonacoCodeEditor once the editor instance is fully constructed.
	// Re-runs after every theme remount, so re-attach the scroll listener and
	// re-apply gutter decorations + pending scroll restore each time.
	function handleEditorMount(editorInstance: editor.IStandaloneCodeEditor) {
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

		// Previous editor's view zones are gone with the disposed instance
		if (activeDiffZone) {
			window.removeEventListener('keydown', activeDiffZone.escHandler);
			activeDiffZone.scrollDispose();
			activeDiffZone.layoutDispose();
			activeDiffZone.detachSwallow();
			activeDiffZone = null;
		}

		attachGutterClickHandler(editorInstance);

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
	}

	// Handle content changes from editor
	function handleContentChange(newContent: string) {
		hasChanges = newContent !== referenceContent;
		onContentChange?.(newContent);
		// User edits invalidate the captured HEAD-side hunk in the peek; close it
		// so the next click reflects the up-to-date diff.
		if (activeDiffZone) closeDiffPeek();
		scheduleGutterUpdate();
	}

	// Expose scroll position to parent (FilesPanel snapshots it on tab switches)
	export function getEditorScrollTop(): number {
		return monacoEditorRef?.getScrollTop?.() ?? 0;
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
			gitignore: 'plaintext', env: 'plaintext', txt: 'plaintext', log: 'plaintext',
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
					<h3 class="text-xs sm:text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
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
					<div class="flex bg-slate-100 dark:bg-slate-800 rounded-lg overflow-hidden mr-1">
						<button
							class="flex px-2 py-1.5 text-xs font-medium transition-colors {svgViewMode === 'visual' ? 'bg-violet-600 text-white' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}"
							onclick={() => { svgViewMode = 'visual'; }}
							title="Visual preview"
						>
							<Icon name="lucide:eye" class="w-3.5 h-3.5" />
						</button>
						<button
							class="flex px-2 py-1.5 text-xs font-medium transition-colors {svgViewMode === 'code' ? 'bg-violet-600 text-white' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}"
							onclick={() => { svgViewMode = 'code'; }}
							title="Code view"
						>
							<Icon name="lucide:code" class="w-3.5 h-3.5" />
						</button>
					</div>
				{/if}

				<!-- Markdown view mode toggle -->
				{#if isMarkdown}
					<div class="flex bg-slate-100 dark:bg-slate-800 rounded-lg overflow-hidden mr-1">
						<button
							class="flex px-2 py-1.5 text-xs font-medium transition-colors {mdViewMode === 'visual' ? 'bg-violet-600 text-white' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}"
							onclick={() => switchMdMode('visual')}
							title="Rendered markdown preview"
						>
							<Icon name="lucide:book-open" class="w-3.5 h-3.5" />
						</button>
						<button
							class="flex px-2 py-1.5 text-xs font-medium transition-colors {mdViewMode === 'code' ? 'bg-violet-600 text-white' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}"
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

					<button
						class="flex p-2 text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30 rounded-lg transition-all duration-200"
						onclick={downloadFile}
						title="Download file"
					>
						<Icon name="lucide:download" class="w-4 h-4" />
					</button>
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
					<!-- Non-editable file actions -->
					<button
						class="flex p-2 text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30 rounded-lg transition-all duration-200"
						onclick={downloadFile}
						title="Download file"
					>
						<Icon name="lucide:download" class="w-4 h-4" />
					</button>
				{/if}
			</div>
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
						{#key themeKey}
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
		background-color: #f59e0b;
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
		background-color: #d97706;
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
	   source scrollWidth); .git-diff-peek-inner is constrained to the visible
	   viewport so the action buttons remain reachable. */
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
		/* padding-top reserves space for the overlay-widget header that sits
		   above the body; combined with the matching padding-top on the
		   margin column, the body's first row and the margin's first row
		   align at the same Y. */
		padding-top: 28px;
		overflow: hidden;
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

	:global(.git-diff-peek-body) {
		flex: 1;
		min-width: 0;
		overflow: auto;
		background-color: rgba(248, 81, 73, 0.08);
		color: #333;
		/* Monaco sets user-select:none on the editor container, which inherits
		   into the view zone and disables text highlighting inside the peek.
		   Override here so the user can select diff text normally. */
		-webkit-user-select: text;
		user-select: text;
		cursor: text;
	}
	:global(.dark .git-diff-peek-body) {
		background-color: rgba(248, 81, 73, 0.14);
		color: #e6edf3;
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
		background-color: rgba(248, 81, 73, 0.08);
		color: rgba(0, 0, 0, 0.4);
		user-select: none;
		overflow: hidden;
		box-sizing: border-box;
		pointer-events: auto;
		border-top: 1px solid #d4d4d4;
		border-bottom: 1px solid #d4d4d4;
		padding-top: 28px;
	}
	:global(.dark .git-diff-peek-margin) {
		background-color: rgba(248, 81, 73, 0.14);
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
</style>
