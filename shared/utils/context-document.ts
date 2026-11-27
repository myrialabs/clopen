/**
 * Context documents — the file a mention is turned into.
 *
 * A snapshot is plain markdown the model can read with its own tools, and its
 * first line is a comment saying what it is:
 *
 *   <!-- clopen-context {"kind":"terminal","label":"dev server",…} -->
 *
 * The header travels with the bytes, so every path an attachment already takes
 * — the draft, the queue, an edit, a message returned to the box — carries it
 * without knowing about it. The composer and the timeline read it to draw the
 * card; the server reads it to label the attachment for the engine.
 */

import type { ContextKind, ContextSource } from '$shared/types/mentions';

const HEADER_START = '<!-- clopen-context ';
const HEADER_END = ' -->';

/** The media type every context document is written in. */
export const CONTEXT_MEDIA_TYPE = 'text/markdown';

/** How a kind is named in a label: "Attachment @2: terminal output …". */
export const CONTEXT_NOUNS: Record<ContextKind, string> = {
	file: 'project file',
	folder: 'folder listing',
	code: 'code selection',
	terminal: 'terminal output',
	'terminal-selection': 'terminal selection',
	'git-changes': 'git working-tree changes',
	'git-staged': 'git staged changes',
	'git-file': 'git file diff',
	'git-commit': 'git commit',
	'git-branch': 'git branch diff',
	'git-stash': 'git stash',
	'git-conflicts': 'git merge conflicts',
	'preview-tab': 'preview tab',
	'preview-element': 'preview page element',
	'preview-console': 'preview console log',
	'chat-session': 'chat transcript',
	'chat-message': 'chat message',
	project: 'project overview',
	'ai-changes': 'changes made by the AI',
	'work-item': 'issue or pull request',
	note: 'note',
	memory: 'memory',
	'db-connection': 'database schema',
	'db-table': 'database table',
	'db-result': 'database query result',
	deployment: 'deployment',
	container: 'container',
	port: 'listening port',
	'env-file': 'environment file'
};

/** Kinds that point at a real file instead of carrying a snapshot of it. */
export function isReferenceKind(kind: ContextKind): boolean {
	return kind === 'file';
}

export interface ContextSection {
	/** A `##` heading; omitted for the lead section. */
	title?: string;
	body: string;
	/** Fenced as code in this language; `''` fences without one. Omit for prose. */
	fence?: string;
}

export interface ContextDocumentInput {
	kind: ContextKind;
	label: string;
	detail?: string;
	path?: string;
	/** `- key: value` lines under the title. */
	facts?: Array<[string, string | number | null | undefined]>;
	sections?: ContextSection[];
	/** Defaults to now. */
	capturedAt?: string;
}

export interface ContextDocument {
	fileName: string;
	text: string;
	source: ContextSource;
}

/** A fence long enough that nothing inside the body can close it. */
function fenceFor(body: string): string {
	let longest = 0;
	for (const match of body.matchAll(/`{3,}/g)) longest = Math.max(longest, match[0].length);
	return '`'.repeat(Math.max(3, longest + 1));
}

/** `name` as a file name: lowercase words joined by dashes, never empty. */
export function contextFileSlug(name: string): string {
	const slug = name
		.normalize('NFKD')
		.replace(/[^\w\s.-]+/g, ' ')
		.trim()
		.replace(/[\s.]+/g, '-')
		.replace(/-+/g, '-')
		.toLowerCase()
		.slice(0, 60)
		.replace(/^-|-$/g, '');
	return slug || 'context';
}

/** Build the document a mention attaches. */
export function buildContextDocument(input: ContextDocumentInput): ContextDocument {
	const source: ContextSource = {
		kind: input.kind,
		// The header has to fit in the bytes a reader probes (see below).
		label: input.label.replace(/\s+/g, ' ').trim().slice(0, 200),
		...(input.detail && { detail: input.detail.slice(0, 200) }),
		...(input.path && { path: input.path }),
		capturedAt: input.capturedAt ?? new Date().toISOString()
	};

	const lines: string[] = [
		// `-->` inside the JSON would end the comment early.
		`${HEADER_START}${JSON.stringify(source).replace(/-->/g, '--\\u003e')}${HEADER_END}`,
		`# ${capitalise(CONTEXT_NOUNS[input.kind])}: ${source.label}`,
		''
	];

	const facts = (input.facts ?? []).filter(([, value]) => value !== null && value !== undefined && value !== '');
	if (input.detail) facts.unshift(['Detail', input.detail]);
	facts.push(['Captured', source.capturedAt]);
	for (const [key, value] of facts) lines.push(`- ${key}: ${value}`);

	for (const section of input.sections ?? []) {
		lines.push('');
		if (section.title) lines.push(`## ${section.title}`, '');
		if (section.fence === undefined) {
			lines.push(section.body.trimEnd() || '_Empty._');
		} else {
			const fence = fenceFor(section.body);
			lines.push(`${fence}${section.fence}`, section.body.replace(/\n+$/, ''), fence);
		}
	}

	return {
		fileName: `${input.kind}-${contextFileSlug(source.label)}.md`,
		text: `${lines.join('\n')}\n`,
		source
	};
}

/**
 * A mentioned project file. The document only names it: the engine is pointed
 * at the file itself (see backend/chat/attachments), so it reads the version
 * on disk when it runs, not a copy from when it was mentioned.
 */
export function fileReferenceDocument(path: string): ContextDocument {
	return buildContextDocument({ kind: 'file', label: path, path, facts: [['Path', path]] });
}

function capitalise(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What a document says it is, or null for any other file. */
export function readContextHeader(text: string): ContextSource | null {
	if (!text.startsWith(HEADER_START)) return null;
	const end = text.indexOf(HEADER_END, HEADER_START.length);
	if (end === -1) return null;
	try {
		const parsed = JSON.parse(text.slice(HEADER_START.length, end)) as Partial<ContextSource>;
		if (typeof parsed.kind !== 'string' || !(parsed.kind in CONTEXT_NOUNS)) return null;
		if (typeof parsed.label !== 'string') return null;
		return {
			kind: parsed.kind as ContextKind,
			label: parsed.label,
			...(typeof parsed.detail === 'string' && parsed.detail && { detail: parsed.detail }),
			...(typeof parsed.path === 'string' && parsed.path && { path: parsed.path }),
			capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : ''
		};
	} catch {
		return null;
	}
}

/** Enough of a document's start to hold its header. */
export const CONTEXT_HEADER_PROBE_BYTES = 4096;

/**
 * The header of a document held as base64, decoding only its start. Works on
 * any attachment: a file that is not a context document answers null.
 */
export function readContextHeaderFromBase64(base64: string, mediaType: string): ContextSource | null {
	if (mediaType !== CONTEXT_MEDIA_TYPE && mediaType !== 'text/plain') return null;
	try {
		// Four base64 characters are three bytes; cut on a whole group.
		const head = base64.slice(0, Math.ceil((CONTEXT_HEADER_PROBE_BYTES * 4) / 3 / 4) * 4);
		const binary = atob(head);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return readContextHeader(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
}

/** UTF-8 text as base64, the form attachments travel in. */
export function textToBase64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** What a context attachment is, as a card names it: "Terminal output". */
export function contextNoun(kind: ContextKind): string {
	return capitalise(CONTEXT_NOUNS[kind]);
}

/** How the picker and the viewer name a context attachment: "Terminal output · dev server". */
export function describeContext(source: ContextSource): string {
	return `${contextNoun(source.kind)} · ${source.label}`;
}

/** A line count as people write it: "1,240 lines". */
export function countLines(text: string): string {
	const lines = text ? text.replace(/\n$/, '').split('\n').length : 0;
	return `${lines.toLocaleString('en-US')} ${lines === 1 ? 'line' : 'lines'}`;
}
