/**
 * Serialize async work per key within this process. Tasks for the same key run
 * one after another (a failed task does not block the next); different keys
 * never wait on each other.
 */
export function createKeyedLock<K>(): <T>(key: K, task: () => Promise<T>) => Promise<T> {
	const tails = new Map<K, Promise<unknown>>();
	return <T>(key: K, task: () => Promise<T>): Promise<T> => {
		const run = (tails.get(key) ?? Promise.resolve()).then(task, task);
		const settled = run.then(() => undefined, () => undefined);
		tails.set(key, settled);
		void settled.then(() => {
			if (tails.get(key) === settled) tails.delete(key);
		});
		return run;
	};
}
