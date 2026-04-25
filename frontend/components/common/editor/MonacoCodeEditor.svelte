<script lang="ts">
	import { onMount } from 'svelte';
	import type { editor } from 'monaco-editor';
	import { themeStore } from '$frontend/stores/ui/theme.svelte';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import { debug } from '$shared/utils/logger';
	import { initMonaco, createModel } from './monaco-loader';
	import { THEMES, getThemeName, registerThemes } from './monaco-themes';
	import { detectLanguageFromFilename as detectLang } from './monaco-languages';

	interface Props {
		value: string;
		language: string;
		path?: string;
		readonly?: boolean;
		onChange?: (value: string) => void;
		onEditorMount?: (editor: editor.IStandaloneCodeEditor) => void;
		options?: editor.IStandaloneEditorConstructionOptions;
		width?: string;
		height?: string;
	}

	let {
		value = $bindable(''),
		language = 'javascript',
		path,
		readonly = false,
		onChange,
		onEditorMount,
		options = {},
		width = '100%',
		height = '100%',
	}: Props = $props();

	const isDark = $derived(themeStore.isDark);
	const currentTheme = $derived(getThemeName(isDark));
	let lastTheme = $state('');
	let isInitialized = $state(false);

	let container: HTMLDivElement;
	let monacoEditor: editor.IStandaloneCodeEditor;
	let monaco: typeof import('monaco-editor');
	let ownedModel: editor.ITextModel | null = null;
	let resizeObserver: ResizeObserver | null = null;

	const EDITOR_CONFIG: editor.IStandaloneEditorConstructionOptions = {
		fontSize: 12,
		lineHeight: 18,
		lineNumbers: 'on',
		minimap: { enabled: false },
		scrollBeyondLastLine: false,
		wordWrap: 'on',
		automaticLayout: true,
		tabSize: 2,
		insertSpaces: true,
		renderWhitespace: 'boundary',
		renderControlCharacters: true,
		folding: true,
		foldingStrategy: 'indentation',
		showFoldingControls: 'always',
		matchBrackets: 'always',
		autoIndent: 'full',
		formatOnPaste: true,
		formatOnType: true,
		contextmenu: true,
		mouseWheelZoom: true,
		multiCursorModifier: 'ctrlCmd',
		accessibilitySupport: 'auto',
		stickyScroll: {
			enabled: false,
		},
		suggest: {
			showKeywords: true,
			showSnippets: true,
			showFunctions: true,
			showConstructors: true,
			showFields: true,
			showVariables: true,
			showClasses: true,
			showStructs: true,
			showInterfaces: true,
			showModules: true,
			showProperties: true,
			showEvents: true,
			showOperators: true,
			showUnits: true,
			showValues: true,
			showConstants: true,
			showEnums: true,
			showEnumMembers: true,
			showColors: true,
			showFiles: true,
			showReferences: true,
			showFolders: true,
			showTypeParameters: true,
			showIssues: true,
			showUsers: true,
			showWords: true,
		},
		quickSuggestions: {
			other: true,
			comments: true,
			strings: true,
		},
		parameterHints: { enabled: true },
		hover: { enabled: true },
	};

	const createEditorOptions = (
		model: editor.ITextModel,
		theme: string
	): editor.IStandaloneEditorConstructionOptions => ({
		...EDITOR_CONFIG,
		fontSize: Math.round(settings.fontSize * 0.9),
		lineHeight: Math.round(settings.fontSize * 0.9 * 1.5),
		model,
		theme,
		readOnly: readonly,
		...options,
	});

	$effect(() => {
		if (monacoEditor && monaco) {
			const model = monacoEditor.getModel();
			if (model) {
				monaco.editor.setModelLanguage(model, language);
			}
		}
	});

	$effect(() => {
		if (monacoEditor && monacoEditor.getValue() !== value) {
			monacoEditor.setValue(value);
		}
	});

	$effect(() => {
		if (monaco && monacoEditor && isInitialized && currentTheme !== lastTheme) {
			recreateEditorWithTheme();
			lastTheme = currentTheme;
		}
	});

	const recreateEditorWithTheme = () => {
		if (!monaco || !monacoEditor || !container || !container.parentNode) return;

		const existingModel = monacoEditor.getModel();
		const currentPosition = monacoEditor.getPosition();

		monacoEditor.dispose();

		if (!existingModel) return;

		monacoEditor = monaco.editor.create(
			container,
			createEditorOptions(existingModel, currentTheme)
		);

		if (currentPosition) {
			monacoEditor.setPosition(currentPosition);
		}

		setupEditorEventHandlers();

		if (onEditorMount) {
			onEditorMount(monacoEditor);
		}
	};

	const setupEditorEventHandlers = () => {
		if (!monacoEditor) return;

		monacoEditor.onDidChangeModelContent(() => {
			const newValue = monacoEditor.getValue();
			if (newValue !== value) {
				value = newValue;
				if (onChange) {
					onChange(newValue);
				}
			}
		});

		if (resizeObserver) {
			resizeObserver.disconnect();
		}
		resizeObserver = new ResizeObserver(() => {
			monacoEditor.layout();
		});
		resizeObserver.observe(container);
	};

	$effect(() => {
		if (monacoEditor) {
			monacoEditor.updateOptions({ readOnly: readonly });
		}
	});

	$effect(() => {
		const size = settings.fontSize;
		if (monacoEditor && isInitialized) {
			monacoEditor.updateOptions({
				fontSize: Math.round(size * 0.9),
				lineHeight: Math.round(size * 0.9 * 1.5),
			});
		}
	});

	function cleanup() {
		if (resizeObserver) {
			resizeObserver.disconnect();
			resizeObserver = null;
		}
		if (monacoEditor) {
			monacoEditor.dispose();
		}
		if (ownedModel) {
			ownedModel.dispose();
			ownedModel = null;
		}
	}

	onMount(() => {
		const initEditor = async () => {
			try {
				monaco = await initMonaco();

				if (!container || !container.parentNode) {
					debug.warn('session', 'Monaco container removed before editor init, skipping');
					return;
				}

				registerThemes(monaco);

				ownedModel = createModel(monaco, value, language, path);

				monacoEditor = monaco.editor.create(
					container,
					createEditorOptions(ownedModel, currentTheme)
				);

				monaco.editor.setTheme(currentTheme);
				isInitialized = true;
				lastTheme = currentTheme;

				setupEditorEventHandlers();

				if (onEditorMount) {
					onEditorMount(monacoEditor);
				}

				return cleanup;
			} catch (error) {
				debug.error('session', 'Failed to initialize Monaco Editor:', error);
			}
		};

		initEditor();
		return cleanup;
	});

	export function getEditor() {
		return monacoEditor;
	}

	export const getValue = () => monacoEditor?.getValue() || '';
	export const setValue = (newValue: string) => monacoEditor?.setValue(newValue);
	export const getLanguage = () => monacoEditor?.getModel()?.getLanguageId() || language;
	export const setLanguage = (newLanguage: string) => {
		language = newLanguage;
		if (monacoEditor && monaco) {
			const model = monacoEditor.getModel();
			if (model) {
				monaco.editor.setModelLanguage(model, newLanguage);
			}
		}
	};
	export const detectLanguageFromFilename = (filename: string) => {
		const detectedLanguage = detectLang(filename, language);
		setLanguage(detectedLanguage);
		return detectedLanguage;
	};
	export const focus = () => monacoEditor?.focus();
	export const layout = () => monacoEditor?.layout();
	export const getScrollTop = () => monacoEditor?.getScrollTop() ?? 0;
	export const setScrollTop = (top: number) => monacoEditor?.setScrollTop(top);
	export const onDidScrollChange = (cb: (top: number) => void) => {
		if (!monacoEditor) return () => {};
		const disposable = monacoEditor.onDidScrollChange((e) => {
			if (e.scrollTopChanged) cb(e.scrollTop);
		});
		return () => disposable.dispose();
	};
</script>

<div
	bind:this={container}
	class="overflow-hidden transition-colors duration-200 ease-linear {isDark ? 'dark' : 'light'}"
	style="width: {width}; height: {height}; background-color: {THEMES[isDark ? 'dark' : 'light']
		.colors.background};"
></div>

<style>
	:global(.monaco-editor) {
		font-family: 'SF Mono', Monaco, Inconsolata, 'Roboto Mono', Consolas, 'Courier New', monospace !important;
	}
</style>
