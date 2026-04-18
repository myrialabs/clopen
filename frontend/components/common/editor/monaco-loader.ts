import loader from '@monaco-editor/loader';
import type * as Monaco from 'monaco-editor';
import type { editor as MonacoEditor, Uri } from 'monaco-editor';

let monacoPromise: Promise<typeof Monaco> | null = null;
let modelCounter = 0;

export function initMonaco(): Promise<typeof Monaco> {
	if (!monacoPromise) {
		monacoPromise = loader.init().then((monaco) => {
			configureCompilerOptions(monaco);
			configureDiagnostics(monaco);
			return monaco;
		});
	}
	return monacoPromise;
}

const DEFAULT_FILENAME_BY_LANGUAGE: Record<string, string> = {
	typescript: 'file.ts',
	javascript: 'file.js',
	json: 'file.json',
	html: 'file.html',
	css: 'file.css',
	scss: 'file.scss',
	less: 'file.less',
	python: 'file.py',
	markdown: 'file.md',
	yaml: 'file.yaml',
	xml: 'file.xml',
};

function synthesizeFilename(language: string): string {
	return DEFAULT_FILENAME_BY_LANGUAGE[language] ?? 'file.txt';
}

function extractFilename(path: string): string {
	const name = path.split(/[\\/]/).pop();
	return name && name.length > 0 ? name : 'file';
}

export function createModelUri(monaco: typeof Monaco, path: string | undefined, language: string): Uri {
	const filename = path ? extractFilename(path) : synthesizeFilename(language);
	return monaco.Uri.parse(`inmemory://clopen/${++modelCounter}/${filename}`);
}

export function createModel(
	monaco: typeof Monaco,
	value: string,
	language: string,
	path?: string
): MonacoEditor.ITextModel {
	return monaco.editor.createModel(value, language, createModelUri(monaco, path, language));
}

function configureCompilerOptions(monaco: typeof Monaco) {
	const ts = monaco.languages.typescript;
	const compilerOptions = {
		target: ts.ScriptTarget.Latest,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.NodeJs,
		jsx: ts.JsxEmit.Preserve,
		allowJs: true,
		allowNonTsExtensions: true,
		esModuleInterop: true,
		allowSyntheticDefaultImports: true,
		noEmit: true,
	};
	ts.typescriptDefaults.setCompilerOptions(compilerOptions);
	ts.javascriptDefaults.setCompilerOptions(compilerOptions);
}

function configureDiagnostics(monaco: typeof Monaco) {
	const tsDiagnostics = {
		noSemanticValidation: true,
		noSyntaxValidation: false,
		noSuggestionDiagnostics: true,
	};
	monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(tsDiagnostics);
	monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(tsDiagnostics);

	monaco.languages.json.jsonDefaults.setDiagnosticsOptions({ validate: false });
	monaco.languages.css.cssDefaults.setOptions({ validate: false });
	monaco.languages.css.scssDefaults.setOptions({ validate: false });
	monaco.languages.css.lessDefaults.setOptions({ validate: false });
}
