/**
 * Results and conditions inside a recipe.
 *
 * Every step leaves its result under a name; later steps refer to it as
 * `$name` or `$name.field.sub`. A condition is either a small check on a
 * result — `$price > 100`, `$mail contains "invoice"`, `$list is empty` — that
 * is decided here, exactly and for free, or a plain question that the engine
 * hands to a model. Anything that is not clearly a check is a question.
 */

export type Vars = Map<string, unknown>;

const REF = /\$([A-Za-z_][\w-]*)((?:\.[\w-]+)*)/g;

/** Read `$name.a.b`; undefined when any part is missing. */
export function lookup(vars: Vars, name: string, path = ''): unknown {
	let value = vars.get(name);
	for (const key of path.split('.').filter(Boolean)) {
		if (value === null || value === undefined) return undefined;
		if (typeof value === 'string') {
			try {
				value = JSON.parse(value);
			} catch {
				return undefined;
			}
		}
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

export function stringify(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/** Replace every `$name.path` in `text` with its value (unknown names stay as written). */
export function interpolate(text: string, vars: Vars): string {
	return text.replace(REF, (whole, name: string, path: string) => (vars.has(name) ? stringify(lookup(vars, name, path)) : whole));
}

/** The value a whole-string reference points at, keeping its type (`$list` → the array). */
export function resolveValue(text: string, vars: Vars): unknown {
	const match = /^\s*\$([A-Za-z_][\w-]*)((?:\.[\w-]+)*)\s*$/.exec(text);
	return match ? lookup(vars, match[1], match[2]) : interpolate(text, vars);
}

/** Items to loop over: an array, a JSON array, or one item per non-empty line. */
export function toItems(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.startsWith('[')) {
			try {
				const parsed = JSON.parse(trimmed);
				if (Array.isArray(parsed)) return parsed;
			} catch {
				// Not JSON: fall through to lines.
			}
		}
		return trimmed
			.split('\n')
			.map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
			.filter(Boolean);
	}
	if (value && typeof value === 'object') return Object.values(value);
	return value === undefined || value === null ? [] : [value];
}

function literal(raw: string, vars: Vars): unknown {
	const text = raw.trim();
	if (/^\$[A-Za-z_]/.test(text)) return resolveValue(text, vars);
	if (/^".*"$|^'.*'$/.test(text)) return text.slice(1, -1);
	if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
	if (text === 'true' || text === 'false') return text === 'true';
	if (text === 'null' || text === 'nothing') return null;
	return text;
}

function isEmpty(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	if (typeof value === 'string') return value.trim() === '';
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === 'object') return Object.keys(value).length === 0;
	return false;
}

function toNumber(value: unknown): number | null {
	if (typeof value === 'number') return value;
	if (typeof value === 'string') {
		const match = /-?\d[\d,]*(?:\.\d+)?/.exec(value);
		if (match) return Number(match[0].replace(/,/g, ''));
	}
	return null;
}

/**
 * Decide a condition when it is a plain check on a result. Returns null when
 * the condition is not one — the caller then asks a model.
 */
export function evaluateCheck(condition: string, vars: Vars): boolean | null {
	const text = condition.trim().replace(/^\((.*)\)$/, '$1');
	if (!/^(not\s+)?\$/i.test(text)) return null;

	const or = text.split(/\s+or\s+/i);
	if (or.length > 1) {
		const parts = or.map((part) => evaluateCheck(part, vars));
		return parts.some((part) => part === null) ? null : parts.some(Boolean);
	}
	const and = text.split(/\s+and\s+/i);
	if (and.length > 1) {
		const parts = and.map((part) => evaluateCheck(part, vars));
		return parts.some((part) => part === null) ? null : parts.every(Boolean);
	}

	let match = /^(\$[\w.-]+)\s+is\s+(not\s+)?empty$/i.exec(text);
	if (match) return isEmpty(resolveValue(match[1], vars)) !== Boolean(match[2]);
	match = /^(\$[\w.-]+)\s+(not\s+)?contains\s+(.+)$/i.exec(text);
	if (match) {
		const haystack = stringify(resolveValue(match[1], vars)).toLowerCase();
		const needle = stringify(literal(match[3], vars)).toLowerCase();
		return haystack.includes(needle) !== Boolean(match[2]);
	}
	match = /^(\$[\w.-]+)\s*(==|!=|>=|<=|>|<|=|is not|is)\s*(.+)$/i.exec(text);
	if (match) {
		const left = resolveValue(match[1], vars);
		const right = literal(match[3], vars);
		const op = match[2].toLowerCase();
		if (op === '==' || op === '=' || op === 'is') return stringify(left).trim() === stringify(right).trim();
		if (op === '!=' || op === 'is not') return stringify(left).trim() !== stringify(right).trim();
		const a = toNumber(left);
		const b = toNumber(right);
		if (a === null || b === null) return null;
		return op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : a <= b;
	}
	match = /^(not\s+)?(\$[\w.-]+)$/i.exec(text);
	if (match) {
		const value = resolveValue(match[2], vars);
		const truthy = typeof value === 'string' ? !['', 'false', 'no', '0'].includes(value.trim().toLowerCase()) : Boolean(value) && !isEmpty(value);
		return truthy !== Boolean(match[1]);
	}
	return null;
}
