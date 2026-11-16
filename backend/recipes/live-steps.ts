/**
 * Which steps of a run are under way right now — kept in memory by the
 * engine, read by whatever shows the plan. The trace records a step once it
 * ends; without this a plan could only guess what is running, and a step
 * that takes minutes looked like it was still waiting.
 *
 * Counted, not just marked: a run being replaced (a task changed mid-way)
 * still unwinds its steps while the new one starts the same paths.
 */

const live = new Map<string, Map<string, number>>();

export function stepStarted(ownerId: string, path: string): void {
	const paths = live.get(ownerId) ?? new Map<string, number>();
	paths.set(path, (paths.get(path) ?? 0) + 1);
	live.set(ownerId, paths);
}

export function stepEnded(ownerId: string, path: string): void {
	const paths = live.get(ownerId);
	const count = paths?.get(path) ?? 0;
	if (!paths || !count) return;
	if (count > 1) paths.set(path, count - 1);
	else paths.delete(path);
	if (!paths.size) live.delete(ownerId);
}

/** The steps of a task's or a flow's run that are running now, outermost first. */
export function runningSteps(ownerId: string): string[] {
	return [...(live.get(ownerId)?.keys() ?? [])].sort((a, b) => a.length - b.length);
}
