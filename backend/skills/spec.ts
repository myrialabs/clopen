/**
 * SKILL.md format — parse, serialize, validate.
 *
 * Implements the open Agent Skills spec (https://agentskills.io/specification):
 * a skill is a folder whose `SKILL.md` carries YAML frontmatter (`name`,
 * `description`, optional `license`/`compatibility`/`metadata`/`allowed-tools`)
 * followed by a Markdown instruction body.
 *
 * We deliberately hand-roll a tiny frontmatter parser rather than pull in a YAML
 * dependency: the spec's frontmatter surface is small and flat (one nested
 * `metadata` map), and skills we author in-app are written back in this exact
 * shape. Unknown keys are preserved verbatim so a round-trip of an imported
 * skill never drops fields the spec tells runtimes to ignore.
 */

export interface SkillFrontmatter {
	name: string;
	description: string;
	license?: string;
	compatibility?: string;
	allowedTools?: string;
	metadata?: Record<string, string>;
	/** Frontmatter keys we don't model, kept verbatim for lossless round-trips. */
	extra: Record<string, string>;
}

export interface ParsedSkill {
	frontmatter: SkillFrontmatter;
	/** The Markdown instruction body after the frontmatter fence. */
	body: string;
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
	// Quote when the value contains characters that change YAML meaning, or has
	// leading/trailing whitespace that would be trimmed on re-parse.
	if (/[:#"'\n]|^[\s]|[\s]$|^[[{>|&*!%@`]/.test(value)) {
		return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	}
	return value;
}

/**
 * Split a SKILL.md into its frontmatter block and body. Returns null when the
 * leading `---` fence is missing or unterminated.
 */
function splitFrontmatter(raw: string): { fm: string; body: string } | null {
	const text = raw.replace(/^\uFEFF/, "");
	const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
	if (!match) return null;
	return { fm: match[1], body: (match[2] ?? '').replace(/^\r?\n/, '') };
}

/** Parse a SKILL.md document. Throws with a readable message on malformed input. */
export function parseSkillMd(raw: string): ParsedSkill {
	const split = splitFrontmatter(raw);
	if (!split) {
		throw new Error('SKILL.md must start with a YAML frontmatter block fenced by --- lines.');
	}

	const fm: SkillFrontmatter = { name: '', description: '', extra: {}, metadata: undefined };
	const metadata: Record<string, string> = {};

	const lines = split.fm.split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }

		// Nested `metadata:` block — indented `key: value` entries.
		if (/^metadata:\s*$/.test(line)) {
			i++;
			while (i < lines.length && /^\s+\S/.test(lines[i])) {
				const m = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
				if (m) metadata[m[1]] = unquote(m[2]);
				i++;
			}
			continue;
		}

		const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!m) { i++; continue; }
		const key = m[1];
		let value: string;

		// Block scalar (`|` literal / `>` folded, with optional chomping). The value
		// lives on the following more-indented lines; both styles are folded to a
		// single line so the value stays one canonical, serialize-safe string.
		if (/^[|>][+-]?\s*$/.test(m[2].trim())) {
			i++;
			let baseIndent: number | null = null;
			const collected: string[] = [];
			while (i < lines.length) {
				const l = lines[i];
				if (l.trim() === '') { collected.push(''); i++; continue; }
				const indent = l.length - l.replace(/^\s+/, '').length;
				if (indent === 0) break; // dedented back to a top-level key
				if (baseIndent === null) baseIndent = indent;
				collected.push(l.slice(baseIndent));
				i++;
			}
			value = collected.join(' ').replace(/\s+/g, ' ').trim();
		} else {
			value = unquote(m[2]);
			i++;
		}

		switch (key) {
			case 'name': fm.name = value; break;
			case 'description': fm.description = value; break;
			case 'license': fm.license = value; break;
			case 'compatibility': fm.compatibility = value; break;
			case 'allowed-tools': fm.allowedTools = value; break;
			default: fm.extra[key] = value;
		}
	}

	if (Object.keys(metadata).length > 0) fm.metadata = metadata;
	return { frontmatter: fm, body: split.body };
}

/** Serialize a parsed skill back into a canonical SKILL.md document. */
export function serializeSkillMd(skill: ParsedSkill): string {
	const { frontmatter: fm, body } = skill;
	const lines: string[] = ['---'];
	lines.push(`name: ${quoteIfNeeded(fm.name)}`);
	lines.push(`description: ${quoteIfNeeded(fm.description)}`);
	if (fm.license) lines.push(`license: ${quoteIfNeeded(fm.license)}`);
	if (fm.compatibility) lines.push(`compatibility: ${quoteIfNeeded(fm.compatibility)}`);
	if (fm.allowedTools) lines.push(`allowed-tools: ${quoteIfNeeded(fm.allowedTools)}`);
	for (const [k, v] of Object.entries(fm.extra)) lines.push(`${k}: ${quoteIfNeeded(v)}`);
	if (fm.metadata && Object.keys(fm.metadata).length > 0) {
		lines.push('metadata:');
		for (const [k, v] of Object.entries(fm.metadata)) lines.push(`  ${k}: ${quoteIfNeeded(v)}`);
	}
	lines.push('---');
	const trimmedBody = body.replace(/^\s+/, '').replace(/\s+$/, '');
	return `${lines.join('\n')}\n\n${trimmedBody}\n`;
}

export interface SkillValidationResult {
	valid: boolean;
	errors: string[];
}

/**
 * Validate frontmatter against the spec. `expectedName` (when given) enforces
 * the spec rule that `name` must match the parent folder — we pass the slug.
 */
export function validateFrontmatter(fm: SkillFrontmatter, expectedName?: string): SkillValidationResult {
	const errors: string[] = [];

	if (!fm.name) {
		errors.push('`name` is required.');
	} else {
		if (fm.name.length > 64) errors.push('`name` must be at most 64 characters.');
		if (!NAME_RE.test(fm.name)) {
			errors.push('`name` may only contain lowercase letters, numbers, and single hyphens (no leading, trailing, or consecutive hyphens).');
		}
		if (expectedName && fm.name !== expectedName) {
			errors.push(`\`name\` (${fm.name}) must match the skill folder name (${expectedName}).`);
		}
	}

	if (!fm.description || !fm.description.trim()) {
		errors.push('`description` is required and must describe what the skill does and when to use it.');
	} else if (fm.description.length > 1024) {
		errors.push('`description` must be at most 1024 characters.');
	}

	if (fm.compatibility && fm.compatibility.length > 500) {
		errors.push('`compatibility` must be at most 500 characters.');
	}

	// Angle brackets in frontmatter can inject unintended system-prompt content.
	for (const [label, value] of [
		['name', fm.name],
		['description', fm.description],
		['license', fm.license],
		['compatibility', fm.compatibility]
	] as const) {
		if (value && /[<>]/.test(value)) errors.push(`\`${label}\` must not contain angle brackets (< or >).`);
	}

	return { valid: errors.length === 0, errors };
}

/**
 * Normalise an arbitrary string into a spec-valid skill slug: lowercase, ASCII
 * alphanumerics and single hyphens, no leading/trailing hyphen, capped at 64.
 */
export function slugifySkillName(input: string): string {
	const slug = input
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-{2,}/g, '-')
		.slice(0, 64)
		.replace(/-+$/g, '');
	return slug || 'skill';
}
