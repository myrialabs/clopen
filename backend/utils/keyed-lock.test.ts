import { describe, expect, test } from 'bun:test';
import { createKeyedLock } from './keyed-lock';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('createKeyedLock', () => {
	test('runs tasks for one key one at a time, in order', async () => {
		const lock = createKeyedLock<number>();
		const order: string[] = [];
		await Promise.all([1, 2, 3].map((n) => lock(7, async () => {
			order.push(`start ${n}`);
			await tick();
			order.push(`end ${n}`);
		})));
		expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
	});

	test('a failed task does not block the next one', async () => {
		const lock = createKeyedLock<string>();
		const failed = lock('a', async () => { throw new Error('boom'); });
		await expect(failed).rejects.toThrow('boom');
		expect(await lock('a', async () => 'next')).toBe('next');
	});

	test('different keys do not wait on each other', async () => {
		const lock = createKeyedLock<string>();
		let release!: () => void;
		const blocked = lock('a', () => new Promise<void>((resolve) => { release = resolve; }));
		expect(await lock('b', async () => 'free')).toBe('free');
		release();
		await blocked;
	});
});
