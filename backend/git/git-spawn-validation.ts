/**
 * Guards for values passed into git CLI argv arrays.
 *
 * Bun.spawn / execGit use argv mode (no shell), but git itself still parses
 * leading `-` tokens as options. User-controlled branch / remote / ref names
 * must therefore be rejected when they look like flags.
 */

const MAX_GIT_ARG = 8192;
const MAX_COMMIT_MESSAGE = 256 * 1024;

/** Branch names, tag names, commit-ish, remote names in refspecs, etc. */
export function assertSafeGitRevish(value: string, label: string): void {
	if (value.length === 0) {
		throw new Error(`${label}: value must not be empty`);
	}
	if (value.length > MAX_GIT_ARG) {
		throw new Error(`${label}: value too long`);
	}
	if (/[\0\n\r]/.test(value)) {
		throw new Error(`${label}: invalid control characters`);
	}
	if (value.startsWith('-')) {
		throw new Error(`${label}: must not start with '-' (git option injection)`);
	}
}

/** `git remote` names — allow common refname chars (slashes for hierarchies, plus signs). */
export function assertSafeGitRemoteName(name: string): void {
	assertSafeGitRevish(name, 'remote name');
	if (!/^[A-Za-z0-9._\-+/]+$/.test(name)) {
		throw new Error(`Invalid git remote name "${name}": only letters, digits, '.', '_', '-', '+', '/' allowed`);
	}
}

/** `git remote add <name> <url>` — avoid NUL/newline and argv-shaped URLs. */
export function assertSafeGitRemoteUrl(url: string): void {
	if (url.length === 0) {
		throw new Error('remote URL must not be empty');
	}
	if (url.length > MAX_GIT_ARG * 8) {
		throw new Error('remote URL too long');
	}
	if (/[\0\n\r]/.test(url)) {
		throw new Error('remote URL contains invalid characters');
	}
	if (url.startsWith('-')) {
		throw new Error('remote URL must not start with "-"');
	}
}

/** Paths appended after `--` in git argv (still reject NUL / newlines). */
export function assertSafeGitPathOperand(path: string, label = 'path'): void {
	if (path.length > MAX_GIT_ARG) {
		throw new Error(`${label}: path too long`);
	}
	if (/[\0\n\r]/.test(path)) {
		throw new Error(`${label}: invalid path characters`);
	}
}

export function assertSafeGitCommitMessage(message: string): void {
	if (message.length > MAX_COMMIT_MESSAGE) {
		throw new Error('commit message too long');
	}
	if (message.includes('\0')) {
		throw new Error('commit message contains NUL byte');
	}
}

/** `ref` side of `git show rev:path` — disallow `:` so `rev` stays unambiguous. */
export function assertSafeGitShowRef(ref: string): void {
	assertSafeGitRevish(ref, 'git ref');
	if (ref.includes(':')) {
		throw new Error('git ref for show must not contain ":"');
	}
}
