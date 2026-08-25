/**
 * Structural extraction — the codebase as graph nodes.
 *
 * The input is the set of files that CHANGED ON DISK during a turn, taken from
 * the snapshot service. That source matters more than it looks: snapshots are a
 * gitignore-aware disk diff against the session baseline
 * (`snapshot-service.ts:166` — "the source of truth is the DISK"), so a file is
 * seen no matter how it was edited.
 *
 * Deriving this from tool calls instead would have been wrong. Agents rewrite
 * files through `Bash` constantly — `sed -i`, a codemod script, `git checkout`,
 * a formatter, a build step — and none of that appears as an Edit or Write tool
 * call. Watching the disk sees all of it and needs no per-engine knowledge of
 * tool names, which also means every engine gets identical behaviour for free.
 *
 * Only changed files are read. There is no repository-wide indexing pass, so the
 * cost is bounded by how much the turn actually touched, and the graph grows to
 * describe the parts of the codebase that are genuinely being worked on.
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, join, posix, relative, resolve } from 'node:path';
import { graphQueries } from '$backend/database/queries/graph-queries';
import { debug } from '$shared/utils/logger';
import type { GraphNode } from '$shared/types/memory';
import { detectLanguage, extractDefinitions, extractImports, isParseable, RESOLVE_EXTENSIONS } from './languages';

/** Files parsed per turn. A large refactor is summarised, not exhaustively mapped. */
const MAX_FILES_PER_TURN = 60;

/** Source files above this are skipped — bundles and generated blobs teach nothing. */
const MAX_FILE_BYTES = 400_000;

/** Symbol nodes created per file, so a barrel export cannot flood the graph. */
const MAX_SYMBOLS_PER_FILE = 25;

/** Paths that describe machinery rather than the project's own design. */
const IGNORED_SEGMENTS = new Set([
	'node_modules',
	'dist',
	'build',
	'.git',
	'.svelte-kit',
	'coverage',
	'vendor',
	'__pycache__',
	'target',
	'.next',
	'.cache'
]);

export interface StructuralIngestInput {
	projectId: string;
	projectPath: string;
	sessionId: string | null;
	/** Repo-relative paths that changed on disk this turn. */
	changedPaths: string[];
}

/**
 * Everything one file contributes, resolved off disk before any row is written.
 *
 * The two phases are separated on purpose. Parsing is async (`readFile`, `stat`)
 * and SQLite transactions are synchronous, so interleaving them would mean either
 * no transaction at all — which is what this originally did, at a cost of several
 * thousand individually-durable statements on a busy turn — or a transaction held
 * open across every file read on the machine.
 */
interface ParsedFile {
	path: string;
	language: string | null;
	/** Repo-relative paths this file imports, already resolved to real files. */
	importsLocal: string[];
	/** npm package names this file imports. */
	importsExternal: string[];
	definitions: string[];
}

export interface StructuralIngestResult {
	files: number;
	symbols: number;
	edges: number;
	/** Path → node id, so episodic extraction can attach `about` edges. */
	fileNodes: Map<string, string>;
}

function isIgnored(path: string): boolean {
	return path.split(/[/\\]/).some(segment => IGNORED_SEGMENTS.has(segment));
}

/** Normalize to forward slashes so Windows and POSIX produce the same digest. */
function normalize(path: string): string {
	return path.replace(/\\/g, '/');
}

/**
 * Resolve an import specifier to a repo-relative path, or null when it points
 * outside the project (a package, a stdlib module, an unresolvable alias).
 *
 * Only relative specifiers are resolved. TypeScript path aliases (`$backend/…`)
 * would need tsconfig parsing per project and are deliberately left alone: a
 * wrong edge is worse than a missing one, because it invents a dependency the
 * codebase does not have.
 */
async function resolveImport(
	fromPath: string,
	specifier: string,
	projectPath: string
): Promise<string | null> {
	if (!specifier.startsWith('.')) return null;

	const baseDir = posix.dirname(normalize(fromPath));
	const joined = posix.normalize(posix.join(baseDir, specifier));

	// Escaping the project root means it is not ours to describe.
	if (joined.startsWith('..')) return null;

	const candidates = [
		joined,
		...RESOLVE_EXTENSIONS.map(ext => `${joined}${ext}`),
		...RESOLVE_EXTENSIONS.map(ext => posix.join(joined, `index${ext}`))
	];

	for (const candidate of candidates) {
		// Strip any query/hash a bundler-style specifier might carry.
		const clean = candidate.split(/[?#]/)[0];
		const absolute = resolve(projectPath, clean);
		// Containment check: a crafted specifier must not let this stat outside
		// the project.
		if (relative(projectPath, absolute).startsWith('..')) continue;
		try {
			const info = await stat(absolute);
			if (info.isFile()) return clean;
		} catch {
			// keep trying
		}
	}
	return null;
}

/** Upsert the file node for a repo-relative path. */
function upsertFileNode(projectId: string, path: string, sessionId: string | null): GraphNode {
	const normalized = normalize(path);
	return graphQueries.upsert({
		kind: 'structural',
		subkind: 'file',
		scope: 'project',
		projectId,
		sessionId,
		label: basename(normalized),
		body: normalized,
		path: normalized,
		language: detectLanguage(normalized),
		// Structural facts read off disk are near-certain, but "near": the file
		// existed when it was read and may not now.
		confidence: 0.9,
		source: 'agent'
	});
}

/**
 * Turn a turn's disk changes into structural nodes and edges.
 *
 * Never throws — a file that vanished mid-turn, or an unreadable path, is
 * skipped. This runs after the user's turn has already completed, so failing
 * loudly would only break something the user considers finished.
 */
export async function ingestStructuralChanges(
	input: StructuralIngestInput
): Promise<StructuralIngestResult> {
	const { projectId, projectPath, sessionId } = input;
	const result: StructuralIngestResult = { files: 0, symbols: 0, edges: 0, fileNodes: new Map() };

	const paths = input.changedPaths
		.map(normalize)
		.filter(path => path && !isIgnored(path))
		.slice(0, MAX_FILES_PER_TURN);

	if (paths.length === 0) return result;

	// ── phase 1: read and parse, off the database entirely ──────────────────
	const parsed: ParsedFile[] = [];
	for (const path of paths) {
		try {
			parsed.push(await parseFile(path, projectPath));
		} catch (error) {
			debug.warn('memory', `Structural extraction skipped ${path}`, error);
		}
	}

	// ── phase 2: one transaction for every write ────────────────────────────
	// A busy turn touching sixty files that define twenty-five symbols each is
	// several thousand statements, and each upsert is itself a SELECT, an
	// INSERT/UPDATE and an FTS rewrite. Outside a transaction every one of those is
	// its own durability barrier, which made this by far the most expensive thing
	// on the write path — for no benefit, since a partially-ingested turn is not a
	// state anyone wants to keep anyway.
	try {
		graphQueries.transaction(() => {
			for (const file of parsed) {
				const fileNode = upsertFileNode(projectId, file.path, sessionId);
				result.files++;
				result.fileNodes.set(file.path, fileNode.id);

				// Directory containment gives the graph its skeleton, which is what makes
				// community detection produce meaningful "lobes" in the visualization
				// rather than one undifferentiated cloud.
				const parent = posix.dirname(file.path);
				if (parent && parent !== '.' && parent !== '/') {
					const moduleNode = graphQueries.upsert({
						kind: 'structural',
						subkind: 'module',
						scope: 'project',
						projectId,
						label: basename(parent),
						body: parent,
						path: parent,
						confidence: 0.9,
						source: 'agent'
					});
					if (graphQueries.link({ srcId: moduleNode.id, dstId: fileNode.id, rel: 'contains' })) {
						result.edges++;
					}
				}

				for (const target of file.importsLocal) {
					const targetNode = upsertFileNode(projectId, target, sessionId);
					if (graphQueries.link({ srcId: fileNode.id, dstId: targetNode.id, rel: 'imports' })) {
						result.edges++;
					}
				}

				// Non-relative specifiers become dependency nodes, which is what makes
				// "what in this codebase touches puppeteer" answerable — and, across
				// projects, "which repositories share this dependency".
				for (const pkg of file.importsExternal) {
					const depNode = graphQueries.upsert({
						kind: 'structural',
						subkind: 'dependency',
						scope: 'global',
						projectId: null,
						label: pkg,
						body: pkg,
						confidence: 0.8,
						source: 'agent'
					});
					if (graphQueries.link({ srcId: fileNode.id, dstId: depNode.id, rel: 'imports' })) {
						result.edges++;
					}
				}

				for (const name of file.definitions) {
					const symbolNode = graphQueries.upsert({
						kind: 'structural',
						subkind: 'symbol',
						scope: 'project',
						projectId,
						sessionId,
						label: name,
						body: `${name} — ${file.path}`,
						path: file.path,
						symbol: name,
						language: file.language,
						// Regex-derived, so lower than a file's existence.
						confidence: 0.6,
						source: 'agent'
					});
					result.symbols++;
					if (graphQueries.link({ srcId: fileNode.id, dstId: symbolNode.id, rel: 'defines' })) {
						result.edges++;
					}
				}
			}
		});
	} catch (error) {
		// The transaction rolled back, so the graph is exactly as it was. This runs
		// after the user's turn has already completed, so failing loudly would only
		// break something they consider finished.
		debug.warn('memory', 'Structural ingest rolled back', error);
		return { files: 0, symbols: 0, edges: 0, fileNodes: new Map() };
	}

	debug.log(
		'memory',
		`Structural ingest: ${result.files} file(s), ${result.symbols} symbol(s), ${result.edges} edge(s)`
	);
	return result;
}

/**
 * Read one file and resolve everything the graph needs from it. Touches no
 * database — see the two-phase note on `ParsedFile`.
 */
async function parseFile(path: string, projectPath: string): Promise<ParsedFile> {
	const absolute = join(projectPath, path);
	const language = detectLanguage(path);

	// A file that vanished mid-turn still gets its node: the memories pointing at
	// it remain true history, and `invalidate.ts` is what retires it once the
	// snapshot confirms the deletion. Only the read is skipped.
	let source: string | null = null;
	if (isParseable(language)) {
		try {
			const info = await stat(absolute);
			if (info.isFile() && info.size <= MAX_FILE_BYTES) {
				source = await readFile(absolute, 'utf8');
			}
		} catch {
			source = null;
		}
	}

	const parsed: ParsedFile = { path, language, importsLocal: [], importsExternal: [], definitions: [] };
	if (!source || !language) return parsed;

	for (const specifier of extractImports(source, language)) {
		const target = await resolveImport(path, specifier, projectPath);
		if (target) {
			parsed.importsLocal.push(target);
			continue;
		}
		const pkg = externalPackageName(specifier);
		if (pkg) parsed.importsExternal.push(pkg);
	}

	parsed.importsLocal = [...new Set(parsed.importsLocal)];
	parsed.importsExternal = [...new Set(parsed.importsExternal)];
	parsed.definitions = extractDefinitions(source, language).slice(0, MAX_SYMBOLS_PER_FILE);
	return parsed;
}

/** npm package names: lowercase, no leading dot/underscore, limited punctuation. */
const NPM_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Package name from a bare import specifier: `@scope/pkg/sub` → `@scope/pkg`,
 * `lodash/merge` → `lodash`. Returns null for anything that is not actually a
 * package.
 *
 * Rejecting non-packages matters more than it sounds. A build-tool path alias
 * (`$shared/types`, `~/lib`, `@/utils`) is not a dependency, and turning one into
 * a node invents a shared dependency between every file that uses the alias —
 * which then distorts community detection and, because the resulting node's label
 * is a two-token fragment, pollutes vector search as well. Aliases cannot be
 * resolved to real files without parsing each project's build config, so they are
 * dropped rather than guessed at.
 */
function externalPackageName(specifier: string): string | null {
	const cleaned = specifier.replace(/^node:/, '').split(/[?#]/)[0];
	if (!cleaned || cleaned.startsWith('/') || cleaned.startsWith('.')) return null;

	const segments = cleaned.split('/');
	if (cleaned.startsWith('@')) {
		// A scoped package is `@scope/name`; `@/utils` has an empty scope and is an
		// alias, not a package.
		if (segments.length < 2) return null;
		const scope = segments[0].slice(1);
		if (!NPM_NAME.test(scope) || !NPM_NAME.test(segments[1])) return null;
		return `${segments[0]}/${segments[1]}`;
	}

	// Filters `$shared`, `~lib`, `#internal` and Windows-style absolute includes.
	return NPM_NAME.test(segments[0]) ? segments[0] : null;
}
