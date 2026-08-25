/**
 * Minimal flat-frontmatter parse/serialize, shared by the single-md artifact
 * features (Commands, Subagents). Deliberately tiny — a flat `key: value` map
 * plus a Markdown body — mirroring the hand-rolled approach in
 * `backend/skills/spec.ts` so we avoid a YAML dependency. Unknown keys are
 * preserved verbatim for lossless round-trips.
 */

export interface ParsedDoc {
	frontmatter: Record<string, string>;
	body: string;
}

/** Strip matching single/double quotes from a scalar value. */
function unquote(value: string): string {
	const v = value.trim();
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		return v.slice(1, -1);
	}
	return v;
}

/** Quote a scalar for YAML output only when it could otherwise be misparsed. */
function quoteIfNeeded(value: string): string {
	if (value === '') return '""';
	if (/[:#"'\n]|^[\s]|[\s]$|^[[{>|&*!%@`]/.test(value)) {
		return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	}
	return value;
}

/** Split a document into its frontmatter block and body (null if no fence). */
function splitFrontmatter(raw: string): { fm: string; body: string } | null {
	const text = raw.replace(/^\uFEFF/, '');
	const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
	if (!match) return null;
	return { fm: match[1], body: (match[2] ?? '').replace(/^\r?\n/, '') };
}

/** Parse a flat-frontmatter Markdown document. A missing fence yields an empty map + full body. */
export function parseDoc(raw: string): ParsedDoc {
	const split = splitFrontmatter(raw);
	if (!split) return { frontmatter: {}, body: raw.trim() };
	const frontmatter: Record<string, string> = {};
	for (const line of split.fm.split(/\r?\n/)) {
		if (line.trim() === '' || line.trim().startsWith('#')) continue;
		const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (m) frontmatter[m[1]] = unquote(m[2]);
	}
	return { frontmatter, body: split.body };
}

/**
 * Serialize a flat-frontmatter document. `order` lists keys to emit first (in
 * order); remaining keys follow in insertion order. Empty values are skipped.
 */
export function serializeDoc(doc: ParsedDoc, order: string[] = []): string {
	const keys = [...order.filter(k => doc.frontmatter[k]), ...Object.keys(doc.frontmatter).filter(k => !order.includes(k))];
	const lines = ['---'];
	for (const k of keys) {
		const v = doc.frontmatter[k];
		if (v == null || v === '') continue;
		lines.push(`${k}: ${quoteIfNeeded(v)}`);
	}
	lines.push('---');
	const body = doc.body.replace(/^\s+/, '').replace(/\s+$/, '');
	return `${lines.join('\n')}\n\n${body}\n`;
}
