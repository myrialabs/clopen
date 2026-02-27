<script lang="ts">
	import { onMount } from 'svelte';
	import loader from '@monaco-editor/loader';
	import type { editor } from 'monaco-editor';
	import { themeStore } from '$frontend/lib/stores/ui/theme.svelte';
	import { debug } from '$shared/utils/logger';

	interface Props {
		value: string;
		language: string;
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
		readonly = false,
		onChange,
		onEditorMount,
		options = {},
		width = '100%',
		height = '100%',
	}: Props = $props();

	// Theme configuration
	const isDark = $derived(themeStore.isDark);
	const currentTheme = $derived(isDark ? 'custom-dark' : 'custom-light');
	let lastTheme = $state('');
	let isInitialized = $state(false);
	
	// Editor instances
	let container: HTMLDivElement;
	let monacoEditor: editor.IStandaloneCodeEditor;
	let monaco: typeof import('monaco-editor');
	let resizeObserver: ResizeObserver | null = null;

	// Theme definitions - centralized configuration
	const THEMES = {
		dark: {
			name: 'custom-dark',
			base: 'vs-dark' as const,
			colors: {
				background: '#0d1117',
				foreground: '#e6edf3',
				lineHighlight: '#161b22',
				lineNumber: '#6e7681',
				lineNumberActive: '#f0f6fc',
				selection: '#264f78',
				selectionInactive: '#264f7840',
				cursor: '#f0f6fc',
				whitespace: '#484f58',
				indentGuide: '#21262d',
				indentGuideActive: '#30363d',
				ruler: '#21262d',
				scrollbar: '#21262d60',
				scrollbarHover: '#30363d80',
				scrollbarActive: '#6e7681'
			},
			tokens: {
				comment: '6A9955',
				keyword: '569CD6',
				string: 'CE9178',
				number: 'B5CEA8',
				type: '4EC9B0',
				function: 'DCDCAA'
			}
		},
		light: {
			name: 'custom-light',
			base: 'vs' as const,
			colors: {
				background: '#ffffff',
				foreground: '#000000',
				lineHighlight: '#f6f6f6',
				lineNumber: '#999999',
				lineNumberActive: '#333333',
				selection: '#add6ff',
				selectionInactive: '#e5ebf1',
				cursor: '#000000',
				whitespace: '#cccccc',
				indentGuide: '#e3e3e3',
				indentGuideActive: '#d3d3d3',
				ruler: '#e3e3e3',
				scrollbar: '#cccccc60',
				scrollbarHover: '#999999a0',
				scrollbarActive: '#666666'
			},
			tokens: {
				comment: '008000',
				keyword: '0000FF',
				string: 'A31515',
				number: '098658',
				type: '267F99',
				function: '795E26'
			}
		}
	} as const;

	// Editor configuration - centralized options
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
			showWords: true
		},
		quickSuggestions: {
			other: true,
			comments: true,
			strings: true
		},
		parameterHints: { enabled: true },
		hover: { enabled: true }
	};

	// File extension to language mapping
	const getLanguageFromExtension = (ext: string): string => {
		const languageMap: Record<string, string> = {
			// JavaScript/TypeScript
			js: 'javascript',
			jsx: 'javascript',
			ts: 'typescript',
			tsx: 'typescript',
			mjs: 'javascript',
			cjs: 'javascript',
			
			// Web languages
			html: 'html',
			htm: 'html',
			css: 'css',
			scss: 'scss',
			sass: 'sass',
			less: 'less',
			
			// Python
			py: 'python',
			pyx: 'python',
			pyi: 'python',
			
			// Java
			java: 'java',
			class: 'java',
			
			// C/C++
			c: 'c',
			cpp: 'cpp',
			cxx: 'cpp',
			cc: 'cpp',
			h: 'c',
			hpp: 'cpp',
			hxx: 'cpp',
			
			// C#
			cs: 'csharp',
			csx: 'csharp',
			
			// Go
			go: 'go',
			
			// Rust
			rs: 'rust',
			
			// PHP
			php: 'php',
			phtml: 'php',
			
			// Ruby
			rb: 'ruby',
			rbw: 'ruby',
			
			// Swift
			swift: 'swift',
			
			// Kotlin
			kt: 'kotlin',
			kts: 'kotlin',
			
			// Scala
			scala: 'scala',
			sc: 'scala',
			
			// R
			r: 'r',
			
			// Matlab
			m: 'matlab',
			
			// Shell
			sh: 'shell',
			bash: 'shell',
			zsh: 'shell',
			fish: 'shell',
			
			// PowerShell
			ps1: 'powershell',
			psm1: 'powershell',
			
			// Batch
			bat: 'bat',
			cmd: 'bat',
			
			// SQL
			sql: 'sql',
			
			// XML
			xml: 'xml',
			xsd: 'xml',
			xsl: 'xml',
			
			// JSON
			json: 'json',
			jsonc: 'json',
			
			// YAML
			yaml: 'yaml',
			yml: 'yaml',
			
			// TOML
			toml: 'toml',
			
			// INI
			ini: 'ini',
			cfg: 'ini',
			conf: 'ini',
			
			// Markdown
			md: 'markdown',
			markdown: 'markdown',
			
			// Dockerfile
			dockerfile: 'dockerfile',
			
			// Lua
			lua: 'lua',
			
			// Perl
			pl: 'perl',
			pm: 'perl',
			
			// Haskell
			hs: 'haskell',
			
			// F#
			fs: 'fsharp',
			fsx: 'fsharp',
			
			// Clojure
			clj: 'clojure',
			cljs: 'clojure',
			
			// Erlang
			erl: 'erlang',
			
			// Elixir
			ex: 'elixir',
			exs: 'elixir',
			
			// Dart
			dart: 'dart',
			
			// Solidity
			sol: 'solidity',
			
			// GraphQL
			graphql: 'graphql',
			gql: 'graphql',
			
			// Svelte
			svelte: 'html', // Monaco doesn't have native Svelte support, use HTML
			
			// Vue
			vue: 'html', // Monaco doesn't have native Vue support, use HTML
			
			// Other config files
			gitignore: 'plaintext',
			env: 'plaintext',
			txt: 'plaintext',
			log: 'plaintext',
			
			// Default
			default: 'plaintext'
		};

		return languageMap[ext.toLowerCase()] || languageMap.default;
	};

	// Utility functions
	const detectLanguage = (filename: string): string => {
		if (!filename) return language;
		const ext = filename.split('.').pop();
		return ext ? getLanguageFromExtension(ext) : language;
	};

	const createThemeDefinition = (themeConfig: typeof THEMES.dark | typeof THEMES.light) => ({
		base: themeConfig.base,
		inherit: true,
		rules: [
			{ token: 'comment', foreground: themeConfig.tokens.comment },
			{ token: 'keyword', foreground: themeConfig.tokens.keyword },
			{ token: 'string', foreground: themeConfig.tokens.string },
			{ token: 'number', foreground: themeConfig.tokens.number },
			{ token: 'type', foreground: themeConfig.tokens.type },
			{ token: 'function', foreground: themeConfig.tokens.function }
		],
		colors: {
			'editor.background': themeConfig.colors.background,
			'editor.foreground': themeConfig.colors.foreground,
			'editor.lineHighlightBackground': themeConfig.colors.lineHighlight,
			'editorLineNumber.foreground': themeConfig.colors.lineNumber,
			'editorLineNumber.activeForeground': themeConfig.colors.lineNumberActive,
			'editor.selectionBackground': themeConfig.colors.selection,
			'editor.inactiveSelectionBackground': themeConfig.colors.selectionInactive,
			'editorCursor.foreground': themeConfig.colors.cursor,
			'editorWhitespace.foreground': themeConfig.colors.whitespace,
			'editorIndentGuide.background': themeConfig.colors.indentGuide,
			'editorIndentGuide.activeBackground': themeConfig.colors.indentGuideActive,
			'editorRuler.foreground': themeConfig.colors.ruler,
			'scrollbarSlider.background': themeConfig.colors.scrollbar,
			'scrollbarSlider.hoverBackground': themeConfig.colors.scrollbarHover,
			'scrollbarSlider.activeBackground': themeConfig.colors.scrollbarActive
		}
	});

	const createEditorOptions: (value: string, lang: string, theme: string) => editor.IStandaloneEditorConstructionOptions = (value, lang, theme) => ({
		...EDITOR_CONFIG,
		value,
		language: lang,
		theme,
		readOnly: readonly,
		...options
	});

	// Update language when it changes
	$effect(() => {
		if (monacoEditor && monaco) {
			const model = monacoEditor.getModel();
			if (model) {
				monaco.editor.setModelLanguage(model, language);
			}
		}
	});

	// Update value when it changes externally
	$effect(() => {
		if (monacoEditor && monacoEditor.getValue() !== value) {
			monacoEditor.setValue(value);
		}
	});

	// Theme change effect - simplified recreation logic
	$effect(() => {
		if (monaco && monacoEditor && isInitialized && currentTheme !== lastTheme) {
			recreateEditorWithTheme();
			lastTheme = currentTheme;
		}
	});

	// Recreate editor with new theme - extracted for clarity
	const recreateEditorWithTheme = () => {
		if (!monaco || !monacoEditor || !container || !container.parentNode) return;

		// Save current state
		const currentValue = monacoEditor.getValue();
		const currentModel = monacoEditor.getModel();
		const currentLanguage = currentModel?.getLanguageId() || language;
		const currentPosition = monacoEditor.getPosition();

		// Dispose current editor
		monacoEditor.dispose();

		// Create new editor with updated theme
		monacoEditor = monaco.editor.create(
			container,
			createEditorOptions(currentValue, currentLanguage, currentTheme)
		);

		// Restore editor state
		if (currentPosition) {
			monacoEditor.setPosition(currentPosition);
		}

		// Re-setup event handlers
		setupEditorEventHandlers();

		// Call mount callback
		if (onEditorMount) {
			onEditorMount(monacoEditor);
		}
	};

	// Setup event handlers - extracted for reuse
	const setupEditorEventHandlers = () => {
		if (!monacoEditor) return;

		// Content change handler
		monacoEditor.onDidChangeModelContent(() => {
			const newValue = monacoEditor.getValue();
			if (newValue !== value) {
				value = newValue;
				if (onChange) {
					onChange(newValue);
				}
			}
		});

		// Resize observer
		if (resizeObserver) {
			resizeObserver.disconnect();
		}
		resizeObserver = new ResizeObserver(() => {
			monacoEditor.layout();
		});
		resizeObserver.observe(container);
	};

	// Update readonly state when it changes
	$effect(() => {
		if (monacoEditor) {
			monacoEditor.updateOptions({ readOnly: readonly });
		}
	});

	// Cleanup function
	function cleanup() {
		if (resizeObserver) {
			resizeObserver.disconnect();
			resizeObserver = null;
		}
		if (monacoEditor) {
			monacoEditor.dispose();
		}
	}

	// Initialize Monaco Editor
	onMount(() => {
		const initEditor = async () => {
			try {
				monaco = await loader.init();

				// Guard: container may have been removed from DOM during async init
				// (e.g. rapid tab switching, component unmount during loader.init())
				if (!container || !container.parentNode) {
					debug.warn('session', 'Monaco container removed before editor init, skipping');
					return;
				}

				// Define themes using centralized configuration
				monaco.editor.defineTheme(THEMES.dark.name, createThemeDefinition(THEMES.dark));
				monaco.editor.defineTheme(THEMES.light.name, createThemeDefinition(THEMES.light));

				// Create editor with initial configuration
				monacoEditor = monaco.editor.create(
					container,
					createEditorOptions(value, language, currentTheme)
				);

				// Set initial theme and mark as initialized
				monaco.editor.setTheme(currentTheme);
				isInitialized = true;
				lastTheme = currentTheme;

				// Setup event handlers
				setupEditorEventHandlers();

				// Call mount callback
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

	// Public methods
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
		const detectedLanguage = detectLanguage(filename);
		setLanguage(detectedLanguage);
		return detectedLanguage;
	};
	export const focus = () => monacoEditor?.focus();
	export const layout = () => monacoEditor?.layout();
</script>

<div
	bind:this={container}
	class="overflow-hidden transition-colors duration-200 ease-linear {isDark ? 'dark' : 'light'}"
	style="width: {width}; height: {height}; background-color: {THEMES[isDark ? 'dark' : 'light'].colors.background};"
></div>

<style>
	/* Font Configuration - Global Monaco Override */
	:global(.monaco-editor) {
		font-family: 'SF Mono', Monaco, Inconsolata, 'Roboto Mono', Consolas, 'Courier New', monospace !important;
	}
</style>