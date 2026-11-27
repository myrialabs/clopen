/**
 * Just enough semver for Clopen's own release numbers (`0.4.50`, `v0.4.50`).
 *
 * Clopen publishes plain `major.minor.patch` versions, so pre-release tags and
 * build metadata are not ordered — anything after the patch number is ignored.
 */

function parts(version: string): number[] {
	return version
		.replace(/^v/, '')
		.split(/[-+]/)[0]
		.split('.')
		.slice(0, 3)
		.map(part => Number.parseInt(part, 10) || 0);
}

/** Negative when `a` is older than `b`, positive when newer, 0 when equal. */
export function compareVersions(a: string, b: string): number {
	const left = parts(a);
	const right = parts(b);
	for (let i = 0; i < 3; i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

export function isNewerVersion(current: string, candidate: string): boolean {
	return compareVersions(candidate, current) > 0;
}

/** `v0.4.50` → `0.4.50`. */
export function stripVersionPrefix(version: string): string {
	return version.replace(/^v/, '');
}
