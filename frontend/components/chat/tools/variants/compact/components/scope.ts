import { currentProjectName, currentProjectPath } from '$frontend/stores/core/projects.svelte';

/** Path of `target` relative to the current project root, or the original path. */
export function relativeToProject(target: string): string {
	if (!target) return '';
	const root = currentProjectPath();
	if (root && target === root) return '';
	if (root && target.startsWith(root)) {
		return target.slice(root.length).replace(/^[/\\]+/, '');
	}
	return target;
}

/** `(project · relpath)` scope label, mirroring Claude Code's search rows. */
export function projectScope(target: string): string {
	const name = currentProjectName();
	const rel = relativeToProject(target);
	const parts = [name, rel].filter(Boolean);
	return parts.length ? `(${parts.join(' · ')})` : '';
}

/** Combine a `(project · path)` scope with a trailing summary, e.g. `(clopen · src), 3 results`. */
export function withScope(target: string, summary: string): string {
	const scope = projectScope(target);
	return [scope, summary].filter(Boolean).join(', ');
}
