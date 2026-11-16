/**
 * Task webhooks: a long random token runs exactly one task, a new token
 * retires the old URL, and a loop elsewhere cannot run a task without end.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { closeDatabase, initializeDatabase } from '$backend/database';
import { allowHookCall, flowForToken, flowHookToken, forgetFlowHook, regenerateFlowHook } from './hooks';

beforeAll(async () => {
	await initializeDatabase();
});

afterAll(() => {
	forgetFlowHook('job-test-hook');
	closeDatabase();
});

describe('task webhooks', () => {
	it('finds the task by its token, and only by its current one', () => {
		const token = flowHookToken('job-test-hook');
		expect(token.length).toBeGreaterThanOrEqual(30);
		expect(flowHookToken('job-test-hook')).toBe(token);
		expect(flowForToken(token)).toBe('job-test-hook');
		const next = regenerateFlowHook('job-test-hook');
		expect(flowForToken(token)).toBeNull();
		expect(flowForToken(next)).toBe('job-test-hook');
		expect(flowForToken('short')).toBeNull();
	});

	it('runs a task at most ten times a minute', () => {
		const results = Array.from({ length: 12 }, () => allowHookCall('job-rate-test'));
		expect(results.filter(Boolean)).toHaveLength(10);
	});
});
