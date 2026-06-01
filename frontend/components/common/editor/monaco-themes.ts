import type { editor } from 'monaco-editor';

interface ThemeConfig {
	name: string;
	base: 'vs' | 'vs-dark';
	colors: {
		background: string;
		foreground: string;
		lineHighlight: string;
		lineNumber: string;
		lineNumberActive: string;
		selection: string;
		selectionInactive: string;
		cursor: string;
		whitespace: string;
		indentGuide: string;
		indentGuideActive: string;
		ruler: string;
		scrollbar: string;
		scrollbarHover: string;
		scrollbarActive: string;
		diffInsertedText: string;
		diffRemovedText: string;
		diffInsertedLine: string;
		diffRemovedLine: string;
	};
	tokens: {
		comment: string;
		keyword: string;
		string: string;
		number: string;
		type: string;
		function: string;
	};
}

export const THEMES = {
	dark: {
		name: 'custom-dark',
		base: 'vs-dark',
		colors: {
			background: '#0f172a99',
			foreground: '#e6edf3',
			lineHighlight: '#ffffff0d',
			lineNumber: '#6e7681',
			lineNumberActive: '#f0f6fc',
			selection: '#264f78',
			selectionInactive: '#264f7840',
			cursor: '#f0f6fc',
			whitespace: '#484f58',
			indentGuide: '#21262d',
			indentGuideActive: '#30363d',
			ruler: '#21262d',
			scrollbar: '#6e768140',
			scrollbarHover: '#6e768180',
			scrollbarActive: '#8b949e',
			diffInsertedText: '#23863633',
			diffRemovedText: '#f8514933',
			diffInsertedLine: '#23863620',
			diffRemovedLine: '#f8514920',
		},
		tokens: {
			comment: '6A9955',
			keyword: '569CD6',
			string: 'CE9178',
			number: 'B5CEA8',
			type: '4EC9B0',
			function: 'DCDCAA',
		},
	},
	light: {
		name: 'custom-light',
		base: 'vs',
		colors: {
			background: '#ffffffe6',
			foreground: '#000000',
			lineHighlight: '#0000000d',
			lineNumber: '#999999',
			lineNumberActive: '#333333',
			selection: '#add6ff',
			selectionInactive: '#e5ebf1',
			cursor: '#000000',
			whitespace: '#cccccc',
			indentGuide: '#e3e3e3',
			indentGuideActive: '#d3d3d3',
			ruler: '#e3e3e3',
			scrollbar: '#92929240',
			scrollbarHover: '#92929280',
			scrollbarActive: '#555555',
			diffInsertedText: '#dafbe133',
			diffRemovedText: '#ffc3c333',
			diffInsertedLine: '#dafbe120',
			diffRemovedLine: '#ffc3c320',
		},
		tokens: {
			comment: '008000',
			keyword: '0000FF',
			string: 'A31515',
			number: '098658',
			type: '267F99',
			function: '795E26',
		},
	},
} as const satisfies Record<'dark' | 'light', ThemeConfig>;

export type ThemeMode = keyof typeof THEMES;

export const getThemeName = (isDark: boolean): string =>
	isDark ? THEMES.dark.name : THEMES.light.name;

export const getThemeBackground = (isDark: boolean): string =>
	isDark ? THEMES.dark.colors.background : THEMES.light.colors.background;

export function createThemeDefinition(
	themeConfig: ThemeConfig
): editor.IStandaloneThemeData {
	return {
		base: themeConfig.base,
		inherit: true,
		rules: [
			{ token: 'comment', foreground: themeConfig.tokens.comment },
			{ token: 'keyword', foreground: themeConfig.tokens.keyword },
			{ token: 'string', foreground: themeConfig.tokens.string },
			{ token: 'number', foreground: themeConfig.tokens.number },
			{ token: 'type', foreground: themeConfig.tokens.type },
			{ token: 'function', foreground: themeConfig.tokens.function },
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
			'scrollbarSlider.activeBackground': themeConfig.colors.scrollbarActive,
			'diffEditor.insertedTextBackground': themeConfig.colors.diffInsertedText,
			'diffEditor.removedTextBackground': themeConfig.colors.diffRemovedText,
			'diffEditor.insertedLineBackground': themeConfig.colors.diffInsertedLine,
			'diffEditor.removedLineBackground': themeConfig.colors.diffRemovedLine,
		},
	};
}

export function registerThemes(monaco: typeof import('monaco-editor')) {
	monaco.editor.defineTheme(THEMES.dark.name, createThemeDefinition(THEMES.dark));
	monaco.editor.defineTheme(THEMES.light.name, createThemeDefinition(THEMES.light));
}
