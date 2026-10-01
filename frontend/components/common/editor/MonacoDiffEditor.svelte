<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import type { editor } from 'monaco-editor';
	import { themeStore } from '$frontend/stores/ui/theme.svelte';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import { debug } from '$shared/utils/logger';
	import { initMonaco, createModel } from './monaco-loader';
	import { getThemeName, registerThemes } from './monaco-themes';
	import { EDITOR_CHROME, editorFontMetrics, DEFAULT_FONT_SCALE } from './editor-options';
	import {
		ChangeNavigator,
		changeMarkerDecorations,
		editorHistory,
		redoIn,
		undoIn,
		NO_CHANGES,
		type ChangeSpan,
		type ChangeState
	} from './editor-changes';

	interface Props {
		original: string;
		modified: string;
		language: string;
		originalPath?: string;
		modifiedPath?: string;
		originalLineNumbers?: number[];
		modifiedLineNumbers?: number[];
		readonly?: boolean;
		renderSideBySide?: boolean;
		/**
		 * Fold the stretches no change touches, keeping a few lines of context
		 * around each change. Only worth turning on for a whole file: a diff
		 * already cut down to hunks has nothing left to fold.
		 */
		hideUnchangedRegions?: boolean;
		/** Scroll to the first change once the diff is computed. */
		revealFirstChange?: boolean;
		onEditorMount?: (editor: editor.IDiffEditor) => void;
		/** Fired whenever the changes, the reader's place among them or the edit history move. */
		onChangesUpdate?: (state: ChangeState) => void;
		/**
		 * Discard a change somewhere other than this buffer (the Git panel writes
		 * it to disk). Without it, Discard edits the modified side, and only while
		 * that side is editable.
		 */
		onDiscardChange?: (change: editor.ILineChange) => void;
		/** Whether `onDiscardChange` can take this change. Defaults to yes. */
		canDiscardChange?: (change: editor.ILineChange) => boolean;
		/** Fired on every edit to the modified side (only reachable when not readonly). */
		onModifiedChange?: (value: string) => void;
		/** Initial vertical scroll to restore once the diff has rendered. */
		scrollTop?: number;
		/** Fired when the user scrolls (the modified/right pane drives scroll). */
		onScroll?: (top: number) => void;
		width?: string;
		height?: string;
		/**
		 * Fraction of the app font size to render code at.
		 *
		 * A diff inside a review pane sits next to prose, a file tree and a
		 * header, and at the panel's own scale it dwarfs all of them. The panel
		 * says how loud its code should be; the app still owns the base size.
		 */
		fontScale?: number;
	}

	const {
		original,
		modified,
		language,
		originalPath,
		modifiedPath,
		originalLineNumbers,
		modifiedLineNumbers,
		readonly = true,
		renderSideBySide = true,
		hideUnchangedRegions = false,
		revealFirstChange = false,
		onEditorMount,
		onChangesUpdate,
		onDiscardChange,
		canDiscardChange,
		onModifiedChange,
		scrollTop = 0,
		onScroll,
		width = '100%',
		height = '100%',
		fontScale = DEFAULT_FONT_SCALE,
	}: Props = $props();

	/** Lines of context kept visible on each side of a change when folding. */
	const CONTEXT_LINES = 3;

	function makeLineNumberFn(numbers: number[] | undefined) {
		if (!numbers || numbers.length === 0) return undefined;
		return (n: number): string => {
			const real = numbers[n - 1];
			return real && real > 0 ? String(real) : '';
		};
	}

	function hideUnchangedOptions(enabled: boolean) {
		return {
			enabled,
			contextLineCount: CONTEXT_LINES,
			minimumLineCount: CONTEXT_LINES,
			revealLineCount: 20
		};
	}

	let container = $state<HTMLDivElement | null>(null);
	let diffEditor: editor.IStandaloneDiffEditor | null = null;
	let monaco: typeof import('monaco-editor') | null = null;
	let ownedModels: editor.ITextModel[] = [];
	/** Language the current models were built for. */
	let builtLanguage = '';
	let editorDisposables: Array<{ dispose(): void }> = [];

	/** The diff's changes, top to bottom in the modified pane. */
	let lineChanges: editor.ILineChange[] = [];
	let navigator: ChangeNavigator | null = null;
	let markers: editor.IEditorDecorationsCollection | null = null;
	let revealPending = false;

	const isDark = $derived(themeStore.isDark);
	const currentTheme = $derived(getThemeName(isDark));

	/** A change as lines of the modified pane — the navigator's and the markers' unit. */
	function spanOf(change: editor.ILineChange): ChangeSpan {
		// A pure deletion has no lines of its own on the modified side; Monaco
		// hands back the line it sits after (0 at the very top).
		const start = Math.max(1, change.modifiedStartLineNumber);
		if (change.modifiedEndLineNumber === 0) return { type: 'deleted', start, end: start };
		return {
			type: change.originalEndLineNumber === 0 ? 'added' : 'modified',
			start,
			end: Math.max(start, change.modifiedEndLineNumber)
		};
	}

	function currentChange(): editor.ILineChange | undefined {
		const index = navigator?.index ?? -1;
		return index >= 0 ? lineChanges[index] : undefined;
	}

	function canDiscard(change: editor.ILineChange | undefined): boolean {
		if (!change) return false;
		if (onDiscardChange) return canDiscardChange?.(change) ?? true;
		return !readonly;
	}

	function report() {
		if (!onChangesUpdate) return;
		if (!diffEditor || !navigator) {
			onChangesUpdate(NO_CHANGES);
			return;
		}
		const history = readonly
			? { canUndo: false, canRedo: false }
			: editorHistory(diffEditor.getModifiedEditor());
		onChangesUpdate({
			count: navigator.count,
			index: navigator.index,
			canDiscard: canDiscard(currentChange()),
			...history
		});
	}

	function handleDiffUpdated() {
		if (!diffEditor || !navigator) return;
		lineChanges = [...(diffEditor.getLineChanges() ?? [])].sort(
			(a, b) => spanOf(a).start - spanOf(b).start
		);
		paintMarkers();
		navigator.setChanges(lineChanges.map(spanOf));

		if (revealPending && lineChanges.length > 0) {
			revealPending = false;
			navigator.reveal(0);
		}
	}

	/** Where each change sits, as marks in the scrollbar. */
	function paintMarkers() {
		if (!diffEditor) return;
		markers ??= diffEditor.getModifiedEditor().createDecorationsCollection();
		markers.set(changeMarkerDecorations(lineChanges.map(spanOf), isDark));
	}

	/**
	 * Put one change back to what it replaced — an ordinary edit, so Undo
	 * brings it back and nothing reaches disk until the caller saves.
	 */
	function discardInBuffer(change: editor.ILineChange) {
		if (!diffEditor || readonly) return;
		const [originalModel, modifiedModel] = ownedModels;
		const target = diffEditor.getModifiedEditor();
		if (!originalModel || !modifiedModel) return;

		const { originalStartLineNumber: oStart, originalEndLineNumber: oEnd } = change;
		const { modifiedStartLineNumber: mStart, modifiedEndLineNumber: mEnd } = change;
		const originalText = oEnd === 0
			? ''
			: originalModel.getValueInRange({
				startLineNumber: oStart,
				startColumn: 1,
				endLineNumber: oEnd,
				endColumn: originalModel.getLineMaxColumn(oEnd)
			});
		const lastLine = modifiedModel.getLineCount();

		let edit: editor.IIdentifiedSingleEditOperation;
		if (mEnd === 0) {
			// Lines were removed: put them back after the line they followed.
			edit = mStart === 0
				? { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: `${originalText}\n` }
				: {
					range: {
						startLineNumber: mStart,
						startColumn: modifiedModel.getLineMaxColumn(mStart),
						endLineNumber: mStart,
						endColumn: modifiedModel.getLineMaxColumn(mStart)
					},
					text: `\n${originalText}`
				};
		} else if (oEnd === 0) {
			// Lines were added: take them out along with their line break.
			edit = mEnd < lastLine
				? { range: { startLineNumber: mStart, startColumn: 1, endLineNumber: mEnd + 1, endColumn: 1 }, text: '' }
				: mStart > 1
					? {
						range: {
							startLineNumber: mStart - 1,
							startColumn: modifiedModel.getLineMaxColumn(mStart - 1),
							endLineNumber: mEnd,
							endColumn: modifiedModel.getLineMaxColumn(mEnd)
						},
						text: ''
					}
					: { range: modifiedModel.getFullModelRange(), text: '' };
		} else {
			edit = {
				range: {
					startLineNumber: mStart,
					startColumn: 1,
					endLineNumber: mEnd,
					endColumn: modifiedModel.getLineMaxColumn(mEnd)
				},
				text: originalText
			};
		}

		target.pushUndoStop();
		target.executeEdits('clopen.discard-change', [edit]);
		target.pushUndoStop();
	}

	async function initDiffEditor() {
		if (!container) return;

		try {
			if (!monaco) {
				monaco = await initMonaco();
				registerThemes(monaco);
			}

			if (!container) return;

			disposeEditor();

			const originalModel = createModel(monaco, original, language, originalPath);
			const modifiedModel = createModel(monaco, modified, language, modifiedPath);
			ownedModels = [originalModel, modifiedModel];
			builtLanguage = language;

			lineChanges = [];
			revealPending = revealFirstChange && scrollTop === 0;

			diffEditor = monaco.editor.createDiffEditor(container, {
				...EDITOR_CHROME,
				...editorFontMetrics(fontScale),
				theme: currentTheme,
				readOnly: readonly,
				originalEditable: false,
				renderSideBySide,
				renderSideBySideInlineBreakpoint: Math.round(600 * (settings.fontSize / 13)),
				useInlineViewWhenSpaceIsLimited: false,
				hideUnchangedRegions: hideUnchangedOptions(hideUnchangedRegions),
				// A change that only re-indents is still a change: counted, marked
				// and put back like any other, the same as the Files editor's gutter.
				ignoreTrimWhitespace: false,
				// Changes are stepped through and discarded from the header, not
				// from arrows and menus in the gutter.
				renderMarginRevertIcon: false,
				renderGutterMenu: false,
				// The diff editor's own ruler is a 30px column beside the scrollbar;
				// the changes are marked inside the scrollbar instead (paintMarkers).
				renderOverviewRuler: false,
				enableSplitViewResizing: true,
				automaticLayout: true,
			});

			diffEditor.setModel({
				original: originalModel,
				modified: modifiedModel,
			});

			applyLineNumberFns();

			const modEditor = diffEditor.getModifiedEditor();
			const origEditor = diffEditor.getOriginalEditor();

			navigator = new ChangeNavigator(modEditor, { onUpdate: report });
			editorDisposables.push(navigator);
			editorDisposables.push(diffEditor.onDidUpdateDiff(handleDiffUpdated));
			editorDisposables.push(
				modifiedModel.onDidChangeContent(() => {
					onModifiedChange?.(modifiedModel.getValue());
					// After the edit settles: an undo reports its content before the
					// model has moved it onto the redo stack.
					queueMicrotask(report);
				})
			);
			// VS Code's own chord for walking a diff, on both panes.
			for (const target of [modEditor, origEditor]) {
				editorDisposables.push(
					target.addAction({
						id: 'clopen.diff.nextChange',
						label: 'Go to Next Change',
						keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.F5],
						run: () => navigator?.step(1)
					}),
					target.addAction({
						id: 'clopen.diff.previousChange',
						label: 'Go to Previous Change',
						keybindings: [monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.F5],
						run: () => navigator?.step(-1)
					})
				);
			}

			if (onEditorMount) {
				onEditorMount(diffEditor);
			}

			const restoreTo = scrollTop;
			// Force a layout after the first paint. A diff editor created during a
			// project switch (when the panel may momentarily have no stable size)
			// can otherwise render blank until something else triggers a resize.
			requestAnimationFrame(() => {
				diffEditor?.layout();
				// Restore scroll once lines have rendered (scrollHeight is 0 before
				// the first layout, so an earlier restore would be a no-op).
				if (restoreTo > 0) {
					requestAnimationFrame(() => modEditor.setScrollTop(restoreTo));
				}
			});
			// Persist scroll changes (the modified/right pane drives diff scroll).
			editorDisposables.push(
				modEditor.onDidScrollChange((e) => {
					if (e.scrollTopChanged) onScroll?.(e.scrollTop);
				})
			);
			report();
		} catch (err) {
			debug.error('git', 'Failed to init diff editor:', err);
		}
	}

	$effect(() => {
		if (monaco && diffEditor) {
			monaco.editor.setTheme(currentTheme);
			untrack(paintMarkers);
		}
	});

	$effect(() => {
		const metrics = editorFontMetrics(fontScale);
		const size = settings.fontSize;
		if (diffEditor) {
			diffEditor.updateOptions({
				...metrics,
				renderSideBySideInlineBreakpoint: Math.round(600 * (size / 13)),
			});
		}
	});

	$effect(() => {
		const readOnly = readonly;
		if (diffEditor) {
			diffEditor.updateOptions({ readOnly });
			// Discard, Undo and Redo come and go with editability.
			untrack(report);
		}
	});

	// Layout and folding are view options: changing them must not rebuild the
	// editor, or an edit in progress (and its undo stack) would go with it.
	$effect(() => {
		const sideBySide = renderSideBySide;
		const hide = hideUnchangedRegions;
		if (diffEditor) {
			diffEditor.updateOptions({
				renderSideBySide: sideBySide,
				hideUnchangedRegions: hideUnchangedOptions(hide)
			});
		}
	});

	function applyLineNumberFns() {
		if (!diffEditor) return;
		const origFn = makeLineNumberFn(originalLineNumbers);
		const modFn = makeLineNumberFn(modifiedLineNumbers);
		diffEditor.getOriginalEditor().updateOptions({
			lineNumbers: origFn ?? 'on'
		});
		diffEditor.getModifiedEditor().updateOptions({
			lineNumbers: modFn ?? 'on'
		});
	}

	$effect(() => {
		originalLineNumbers;
		modifiedLineNumbers;
		if (diffEditor) {
			applyLineNumberFns();
		}
	});

	$effect(() => {
		const nextOriginal = original;
		const nextModified = modified;
		language;
		if (!container) return;
		untrack(() => {
			// The parent handing back what the editor already holds is the echo of
			// an edit made here — rebuilding would throw away the undo stack.
			const [originalModel, modifiedModel] = ownedModels;
			if (
				diffEditor &&
				originalModel &&
				modifiedModel &&
				builtLanguage === language &&
				originalModel.getValue() === nextOriginal &&
				modifiedModel.getValue() === nextModified
			) {
				return;
			}
			initDiffEditor();
		});
	});

	function disposeEditor() {
		markers = null;
		navigator = null;
		for (const disposable of editorDisposables) disposable.dispose();
		editorDisposables = [];
		if (diffEditor) {
			diffEditor.dispose();
			diffEditor = null;
		}
		for (const model of ownedModels) {
			model.dispose();
		}
		ownedModels = [];
	}

	onDestroy(disposeEditor);

	export const getEditor = () => diffEditor;
	export const layout = () => diffEditor?.layout();
	export const focus = () => diffEditor?.focus();
	export const nextChange = () => navigator?.step(1);
	export const previousChange = () => navigator?.step(-1);
	/** Discard the current change — in this buffer, or through `onDiscardChange`. */
	export function discardChange() {
		const change = currentChange();
		if (!change || !canDiscard(change)) return;
		if (onDiscardChange) onDiscardChange(change);
		else discardInBuffer(change);
	}
	export const undo = () => undoIn(diffEditor?.getModifiedEditor());
	export const redo = () => redoIn(diffEditor?.getModifiedEditor());
</script>

<div bind:this={container} style="width: {width}; height: {height};"></div>
