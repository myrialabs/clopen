<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import type { editor } from 'monaco-editor';
	import { themeStore } from '$frontend/stores/ui/theme.svelte';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import { debug } from '$shared/utils/logger';
	import { initMonaco, createModel } from './monaco-loader';
	import { getThemeName, registerThemes } from './monaco-themes';

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
		onEditorMount?: (editor: editor.IDiffEditor) => void;
		width?: string;
		height?: string;
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
		onEditorMount,
		width = '100%',
		height = '100%',
	}: Props = $props();

	function makeLineNumberFn(numbers: number[] | undefined) {
		if (!numbers || numbers.length === 0) return undefined;
		return (n: number): string => {
			const real = numbers[n - 1];
			return real && real > 0 ? String(real) : '';
		};
	}

	let container = $state<HTMLDivElement | null>(null);
	let diffEditor: editor.IDiffEditor | null = null;
	let monaco: typeof import('monaco-editor') | null = null;
	let ownedModels: editor.ITextModel[] = [];

	const isDark = $derived(themeStore.isDark);
	const currentTheme = $derived(getThemeName(isDark));

	async function initDiffEditor() {
		if (!container) return;

		try {
			if (!monaco) {
				monaco = await initMonaco();
				registerThemes(monaco);
			}

			if (!container) return;

			if (diffEditor) {
				diffEditor.dispose();
				diffEditor = null;
			}
			disposeOwnedModels();

			const originalModel = createModel(monaco, original, language, originalPath);
			const modifiedModel = createModel(monaco, modified, language, modifiedPath);
			ownedModels = [originalModel, modifiedModel];

			diffEditor = monaco.editor.createDiffEditor(container, {
				theme: currentTheme,
				readOnly: readonly,
				renderSideBySide,
				renderSideBySideInlineBreakpoint: Math.round(600 * (settings.fontSize / 13)),
				useInlineViewWhenSpaceIsLimited: false,
				minimap: { enabled: false },
				scrollBeyondLastLine: false,
				fontSize: Math.round(settings.fontSize * 0.9),
				lineHeight: Math.round(settings.fontSize * 0.9 * 1.5),
				renderOverviewRuler: false,
				enableSplitViewResizing: true,
				automaticLayout: true,
				scrollbar: {
					verticalScrollbarSize: 8,
					horizontalScrollbarSize: 8,
				},
			});

			diffEditor.setModel({
				original: originalModel,
				modified: modifiedModel,
			});

			applyLineNumberFns();

			if (onEditorMount) {
				onEditorMount(diffEditor);
			}
		} catch (err) {
			debug.error('git', 'Failed to init diff editor:', err);
		}
	}

	$effect(() => {
		if (monaco && diffEditor) {
			monaco.editor.setTheme(currentTheme);
		}
	});

	$effect(() => {
		const size = settings.fontSize;
		if (diffEditor) {
			diffEditor.updateOptions({
				fontSize: Math.round(size * 0.9),
				lineHeight: Math.round(size * 0.9 * 1.5),
				renderSideBySideInlineBreakpoint: Math.round(600 * (size / 13)),
			});
		}
	});

	$effect(() => {
		if (diffEditor) {
			diffEditor.updateOptions({ readOnly: readonly });
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
		original;
		modified;
		language;
		renderSideBySide;
		if (container) {
			untrack(() => initDiffEditor());
		}
	});

	function disposeOwnedModels() {
		for (const model of ownedModels) {
			model.dispose();
		}
		ownedModels = [];
	}

	onDestroy(() => {
		if (diffEditor) {
			diffEditor.dispose();
			diffEditor = null;
		}
		disposeOwnedModels();
	});

	export const getEditor = () => diffEditor;
	export const layout = () => diffEditor?.layout();
	export const focus = () => diffEditor?.focus();
</script>

<div bind:this={container} style="width: {width}; height: {height};"></div>
