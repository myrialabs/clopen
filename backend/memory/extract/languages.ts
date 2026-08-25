/**
 * Language detection and source-level pattern extraction.
 *
 * Imports and definitions are recovered with regular expressions, not a parser.
 * That is a deliberate trade: a real AST per language would mean a tree-sitter
 * grammar (and a WASM runtime) for every language a user might open, on a hot
 * path that runs after every turn. What the graph needs is the *shape* of the
 * codebase — which files reference which, and roughly what each defines — and
 * regexes recover that well enough to be useful while costing microseconds.
 *
 * The limits are real and worth stating: a commented-out import still counts, a
 * dynamic `import(variable)` is invisible, and a declaration split across lines
 * may be missed. Structural nodes are therefore treated as evidence rather than
 * ground truth, and every one carries `confidence` below 1.
 */

/** File extension → language label. */
const EXTENSIONS: Record<string, string> = {
	ts: 'typescript',
	tsx: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	js: 'javascript',
	jsx: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	svelte: 'svelte',
	vue: 'vue',
	py: 'python',
	pyi: 'python',
	go: 'go',
	rs: 'rust',
	java: 'java',
	kt: 'kotlin',
	kts: 'kotlin',
	swift: 'swift',
	rb: 'ruby',
	php: 'php',
	cs: 'csharp',
	c: 'c',
	h: 'c',
	cc: 'cpp',
	cpp: 'cpp',
	hpp: 'cpp',
	css: 'css',
	scss: 'scss',
	html: 'html',
	json: 'json',
	yml: 'yaml',
	yaml: 'yaml',
	toml: 'toml',
	sql: 'sql',
	sh: 'shell',
	bash: 'shell',
	md: 'markdown'
};

/** Extensions tried when resolving an extensionless relative import. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte', '.vue', '.py', '.go', '.rs'];

/** Languages worth reading the contents of; others become bare file nodes. */
const PARSEABLE = new Set([
	'typescript',
	'javascript',
	'svelte',
	'vue',
	'python',
	'go',
	'rust',
	'java',
	'kotlin',
	'ruby',
	'php',
	'csharp',
	'c',
	'cpp'
]);

export function detectLanguage(path: string): string | null {
	const ext = path.split('.').pop()?.toLowerCase();
	return ext ? (EXTENSIONS[ext] ?? null) : null;
}

export function isParseable(language: string | null): boolean {
	return language !== null && PARSEABLE.has(language);
}

export { RESOLVE_EXTENSIONS };

/** Import/include specifiers per language family. */
const IMPORT_PATTERNS: Record<string, RegExp[]> = {
	typescript: [
		/\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/g,
		/\bexport\s+(?:type\s+)?[\w*{}\s,$]+\s+from\s+['"]([^'"]+)['"]/g,
		/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
		/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
	],
	python: [
		/^\s*from\s+([\w.]+)\s+import\b/gm,
		/^\s*import\s+([\w.]+)/gm
	],
	go: [/^\s*(?:\w+\s+)?"([^"]+)"\s*$/gm],
	rust: [/^\s*use\s+([\w:]+)/gm],
	java: [/^\s*import\s+(?:static\s+)?([\w.]+);/gm],
	ruby: [/\brequire(?:_relative)?\s+['"]([^'"]+)['"]/g],
	php: [/\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g],
	csharp: [/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm],
	c: [/^\s*#include\s*[<"]([^>"]+)[>"]/gm]
};

IMPORT_PATTERNS.javascript = IMPORT_PATTERNS.typescript;
IMPORT_PATTERNS.svelte = IMPORT_PATTERNS.typescript;
IMPORT_PATTERNS.vue = IMPORT_PATTERNS.typescript;
IMPORT_PATTERNS.kotlin = IMPORT_PATTERNS.java;
IMPORT_PATTERNS.cpp = IMPORT_PATTERNS.c;

/** Top-level definitions worth naming as their own node. */
const DEFINITION_PATTERNS: Record<string, RegExp[]> = {
	typescript: [
		/^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
		/^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
		/^\s*export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
		/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm
	],
	python: [
		/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm,
		/^\s*class\s+([A-Za-z_]\w*)/gm
	],
	go: [
		/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm,
		/^\s*type\s+([A-Za-z_]\w*)/gm
	],
	rust: [
		/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm,
		/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/gm
	],
	java: [
		/^\s*(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/gm
	],
	php: [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+([A-Za-z_]\w*)/gm, /^\s*function\s+([A-Za-z_]\w*)/gm],
	csharp: [/^\s*(?:public|internal|private|protected)?\s*(?:static\s+)?(?:sealed\s+)?(?:class|interface|record|struct|enum)\s+([A-Za-z_]\w*)/gm],
	ruby: [/^\s*(?:class|module)\s+([A-Z]\w*)/gm, /^\s*def\s+([a-z_]\w*[?!]?)/gm]
};

DEFINITION_PATTERNS.javascript = DEFINITION_PATTERNS.typescript;
DEFINITION_PATTERNS.svelte = DEFINITION_PATTERNS.typescript;
DEFINITION_PATTERNS.vue = DEFINITION_PATTERNS.typescript;
DEFINITION_PATTERNS.kotlin = DEFINITION_PATTERNS.java;
DEFINITION_PATTERNS.cpp = DEFINITION_PATTERNS.c ?? [];

function collect(source: string, patterns: RegExp[] | undefined, limit: number): string[] {
	if (!patterns) return [];
	const found = new Set<string>();
	for (const pattern of patterns) {
		// Patterns are module-level and carry /g, so lastIndex must be reset or a
		// previous file's position leaks into this one.
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(source)) !== null) {
			const value = match[1]?.trim();
			if (value) found.add(value);
			if (found.size >= limit) return [...found];
		}
	}
	return [...found];
}

/** Import specifiers referenced by a source file, verbatim. */
export function extractImports(source: string, language: string, limit = 80): string[] {
	return collect(source, IMPORT_PATTERNS[language], limit);
}

/** Names of top-level definitions in a source file. */
export function extractDefinitions(source: string, language: string, limit = 40): string[] {
	return collect(source, DEFINITION_PATTERNS[language], limit);
}
