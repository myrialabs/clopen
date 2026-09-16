/**
 * Names and lines — the two things a dotenv writer has to get exactly right.
 */

/** Dotenv files that are templates rather than configuration. */
export const TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.dist'];

/**
 * Reject anything that is not a plain file name in the project root.
 *
 * The value reaches here from a stored binding or a form field, so it is
 * untrusted input joined onto a path. A name containing a separator or a `..`
 * is refused outright rather than normalised: there is no legitimate dotenv
 * file outside the root a project loads by default, so accepting one would only
 * ever be accepting an accident or an attack.
 */
export function isSafeEnvFileName(name: string): boolean {
	const trimmed = name.trim();
	if (!trimmed || trimmed.length > 64) return false;
	if (trimmed.includes('/') || trimmed.includes('\\')) return false;
	if (trimmed === '.' || trimmed === '..') return false;
	return /^\.?[A-Za-z0-9._-]+$/.test(trimmed);
}

/** Whether a name is one a shell would accept as a variable. */
export function isValidEnvKey(key: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key.trim());
}

/** True for `.env.example` and friends — read for their shape, never written. */
export function isTemplateEnvFile(name: string): boolean {
	return TEMPLATE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** True for any file a project would load as a dotenv file. */
export function isDotenvFileName(name: string): boolean {
	return /^\.env(\..+)?$/.test(name);
}

/**
 * Render one `KEY=value` line.
 *
 * Quoted only when it has to be. Every dotenv reader in common use strips
 * surrounding double quotes, but an unquoted value is what a human expects to
 * see, and a percent-encoded connection URI needs nothing. The quoting exists
 * for the case that is not: a password carrying a `#` would otherwise turn the
 * rest of the line into a comment.
 */
export function formatEnvLine(key: string, value: string): string {
	const needsQuotes = /[\s#'"$`\\]/.test(value) || value === '';
	if (!needsQuotes) return `${key}=${value}`;
	const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
	return `${key}="${escaped}"`;
}

/**
 * How `.env.local` beats `.env`, as a sortable number.
 *
 * The order is the reason this exists at all: Next.js and Vite read
 * `.env.local` IN PREFERENCE to `.env`, so a project with both has exactly one
 * right answer and picking the other produces the worst outcome available — the
 * variable is written and nothing reads it.
 */
export function envFilePrecedence(name: string): number {
	if (name === '.env.development.local' || name === '.env.local') return 0;
	if (name.endsWith('.local')) return 1;
	if (name === '.env') return 2;
	return 3;
}
