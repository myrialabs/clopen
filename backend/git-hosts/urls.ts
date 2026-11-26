/**
 * Remote URLs and server roots.
 *
 * Every adapter answers "is this remote mine, and which repository is it" the
 * same way: compare the remote's hostname with the account's, then read the
 * path. Kept in one place so `git@host:owner/repo.git`, `ssh://git@host:22/…`
 * and `https://user@host/…` are parsed identically by all four services.
 */

/** Host and path of a git remote URL, or null for a local path. */
export function parseRemoteUrl(url: string): { host: string; path: string } | null {
	const trimmed = (url ?? '').trim();
	if (!trimmed) return null;

	// scp-like: [user@]host:path — not a URL, the part after the colon is a path.
	const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(trimmed);
	if (scp) return { host: scp[1]!.toLowerCase(), path: cleanPath(scp[2]!) };

	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol === 'file:' || !parsed.hostname) return null;
		return { host: parsed.hostname.toLowerCase(), path: cleanPath(decodeURIComponent(parsed.pathname)) };
	} catch {
		return null;
	}
}

function cleanPath(path: string): string {
	return path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
}

/**
 * A server root as the user typed it, normalised: scheme added when missing,
 * trailing slashes and any API suffix removed. Empty in, empty out.
 */
export function normaliseBaseUrl(raw: string | undefined | null): string {
	let value = (raw ?? '').trim();
	if (!value) return '';
	if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
	value = value.replace(/\/+$/, '');
	value = value.replace(/\/(api\/v3|api\/v4|api\/v1)$/i, '');
	return value;
}

/** Hostname of a server root, lowercased. */
export function hostOfBase(base: string): string {
	try {
		return new URL(base).hostname.toLowerCase();
	} catch {
		return '';
	}
}

/** Fill `{name}` placeholders. Values are URL-encoded except where a path is expected. */
export function fillTemplate(template: string, values: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`);
}

/** Strip any `user[:password]@` from an https clone URL — a token must never end up in `.git/config`. */
export function withoutUserInfo(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.username = '';
		parsed.password = '';
		return parsed.toString();
	} catch {
		return url;
	}
}
