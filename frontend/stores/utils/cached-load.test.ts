import { describe, expect, test } from 'bun:test';
import { createCachedLoadCore } from './cached-load';

/** A load that resolves/rejects on command, so ordering can be asserted exactly. */
function deferred() {
	let resolve!: () => void;
	let reject!: (err: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('createCachedLoadCore', () => {
	test('caches a successful load and serves it without loading again', async () => {
		let calls = 0;
		const cache = createCachedLoadCore('test');
		const load = async () => {
			calls++;
		};

		await cache.ensure(load);
		expect(cache.loaded).toBe(true);
		expect(calls).toBe(1);

		await cache.ensure(load);
		expect(calls).toBe(1);
	});

	test('a FAILED load is not cached, so the next caller retries', async () => {
		// This is the whole bug: twelve stores marked themselves loaded in their
		// catch block, so one timeout left the list empty for the rest of the
		// session with nothing to repair it. A failure must leave the cache open.
		let calls = 0;
		const cache = createCachedLoadCore('test');
		const load = async () => {
			calls++;
			if (calls === 1) throw new Error('timeout');
		};

		await cache.ensure(load);
		expect(cache.loaded).toBe(false);

		await cache.ensure(load);
		expect(cache.loaded).toBe(true);
		expect(calls).toBe(2);
	});

	test('a failed load does not reject its caller', async () => {
		const cache = createCachedLoadCore('test');
		// Callers treat this as "the store did not change"; swallowing the error is
		// what lets a panel keep rendering its previous value.
		await cache.ensure(async () => {
			throw new Error('boom');
		});
		expect(cache.loaded).toBe(false);
	});

	test('concurrent ensure() calls collapse onto one load', async () => {
		// Panels mount together, and during a reconnect they all ask at once.
		// Firing N identical requests is exactly the burst that made an already
		// struggling server worse.
		let calls = 0;
		const gate = deferred();
		const cache = createCachedLoadCore('test');
		const load = async () => {
			calls++;
			await gate.promise;
		};

		const a = cache.ensure(load);
		const b = cache.ensure(load);
		const c = cache.ensure(load);
		expect(calls).toBe(1);

		gate.resolve();
		await Promise.all([a, b, c]);
		expect(calls).toBe(1);
		expect(cache.loaded).toBe(true);
	});

	test('refresh() starts its own load instead of joining one in flight', async () => {
		// A refresh usually follows a mutation (an account was added), so an
		// in-flight read that started BEFORE that change must not be reused — it
		// would answer with the state the caller is trying to move away from.
		let calls = 0;
		const gate = deferred();
		const cache = createCachedLoadCore('test');
		const load = async () => {
			calls++;
			await gate.promise;
		};

		const first = cache.ensure(load);
		expect(calls).toBe(1);

		const second = cache.refresh(load);
		expect(calls).toBe(2);

		gate.resolve();
		await Promise.all([first, second]);
	});

	test('reset() reopens the cache and markLoaded() closes it without a load', async () => {
		let calls = 0;
		const cache = createCachedLoadCore('test');
		const load = async () => {
			calls++;
		};

		cache.markLoaded();
		expect(cache.loaded).toBe(true);
		await cache.ensure(load);
		expect(calls).toBe(0);

		cache.reset();
		expect(cache.loaded).toBe(false);
		await cache.ensure(load);
		expect(calls).toBe(1);
	});

	test('publish mirrors every change, and only real changes', async () => {
		const seen: boolean[] = [];
		const cache = createCachedLoadCore('test', (loaded) => seen.push(loaded));

		await cache.ensure(async () => {});
		cache.markLoaded(); // already true — must not publish again
		cache.reset();
		cache.reset(); // already false — must not publish again

		expect(seen).toEqual([true, false]);
	});
});
