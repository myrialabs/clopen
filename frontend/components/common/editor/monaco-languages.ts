const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	js: 'javascript',
	jsx: 'javascript',
	ts: 'typescript',
	tsx: 'typescript',
	mjs: 'javascript',
	cjs: 'javascript',

	html: 'html',
	htm: 'html',
	css: 'css',
	scss: 'scss',
	sass: 'sass',
	less: 'less',

	py: 'python',
	pyx: 'python',
	pyi: 'python',

	java: 'java',
	class: 'java',

	c: 'c',
	cpp: 'cpp',
	cxx: 'cpp',
	cc: 'cpp',
	h: 'c',
	hpp: 'cpp',
	hxx: 'cpp',

	cs: 'csharp',
	csx: 'csharp',

	go: 'go',
	rs: 'rust',

	php: 'php',
	phtml: 'php',

	rb: 'ruby',
	rbw: 'ruby',

	swift: 'swift',
	kt: 'kotlin',
	kts: 'kotlin',
	scala: 'scala',
	sc: 'scala',
	r: 'r',
	m: 'matlab',

	sh: 'shell',
	bash: 'shell',
	zsh: 'shell',
	fish: 'shell',

	ps1: 'powershell',
	psm1: 'powershell',
	bat: 'bat',
	cmd: 'bat',

	sql: 'sql',
	xml: 'xml',
	xsd: 'xml',
	xsl: 'xml',
	svg: 'xml',

	json: 'json',
	jsonc: 'json',

	yaml: 'yaml',
	yml: 'yaml',
	toml: 'toml',
	ini: 'ini',
	cfg: 'ini',
	conf: 'ini',

	md: 'markdown',
	markdown: 'markdown',

	dockerfile: 'dockerfile',

	lua: 'lua',
	pl: 'perl',
	pm: 'perl',
	hs: 'haskell',
	fs: 'fsharp',
	fsx: 'fsharp',
	clj: 'clojure',
	cljs: 'clojure',
	erl: 'erlang',
	ex: 'elixir',
	exs: 'elixir',
	dart: 'dart',
	sol: 'solidity',
	graphql: 'graphql',
	gql: 'graphql',

	svelte: 'html',
	vue: 'html',

	gitignore: 'plaintext',
	env: 'env',
	txt: 'plaintext',
	log: 'plaintext',
};

const DEFAULT_LANGUAGE = 'plaintext';

export function getLanguageFromExtension(ext: string): string {
	return LANGUAGE_BY_EXTENSION[ext.toLowerCase()] || DEFAULT_LANGUAGE;
}

export function detectLanguageFromFilename(filename: string, fallback = DEFAULT_LANGUAGE): string {
	if (!filename) return fallback;
	if (/\.env(\.\w+)?$/i.test(filename)) return 'env';
	const ext = filename.split('.').pop();
	return ext ? getLanguageFromExtension(ext) : fallback;
}
