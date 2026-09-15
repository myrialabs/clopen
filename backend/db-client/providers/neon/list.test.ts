/**
 * Listing Neon projects, which is organisation-scoped.
 *
 * This file exists because the adapter shipped getting it wrong. `/projects`
 * reads like an account-wide listing and is not: the document calls it "a list
 * of projects for the specified organization", and a personal key that omits
 * `org_id` is refused with
 *
 *   400 org_id is required, you can find it on your organization settings page
 *
 * which took down every read path — the picker, the branching parent list, the
 * health probe and the readiness poll — against a real key. The tests below
 * lock down the three things that were wrong or missing.
 */

import { describe, it, expect, afterEach } from 'bun:test';

import { listNeonProjects } from './adapter';
import { NeonError } from './client';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** A distinct key per test — the organisation lookup is memoised per key. */
let keyCounter = 0;
function credentials() {
	keyCounter += 1;
	return { apiKey: `napi_test_${keyCounter}` };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function project(id: string) {
	return { id, name: id, region_id: 'aws-eu-central-1' };
}

/**
 * Stand in for Neon, refusing `/projects` without `org_id` exactly as it does.
 *
 * `projectsByOrg` maps an organisation id to what that scope answers with;
 * `organizations` is what `/users/me/organizations` reports.
 */
function mockNeon(input: {
	organizations: { id: string; name?: string }[];
	projectsByOrg: Record<string, unknown[]>;
	/** Organisations whose listing fails, and with what status. */
	failing?: Record<string, number>;
	/** Allow a bare `/projects` call to succeed, as a legacy account would. */
	bareProjects?: unknown[];
}) {
	const requested: string[] = [];

	globalThis.fetch = (async (target: string | URL) => {
		const url = new URL(String(target));
		requested.push(url.pathname + url.search);

		if (url.pathname.endsWith('/users/me/organizations')) {
			return json({ organizations: input.organizations });
		}

		if (url.pathname.endsWith('/projects')) {
			const orgId = url.searchParams.get('org_id');
			if (!orgId) {
				if (input.bareProjects) return json({ projects: input.bareProjects });
				return json(
					{ message: 'org_id is required, you can find it on your organization settings page' },
					400
				);
			}
			const status = input.failing?.[orgId];
			if (status) return json({ message: 'Nope' }, status);
			return json({ projects: input.projectsByOrg[orgId] ?? [] });
		}

		throw new Error(`unexpected request: ${url}`);
	}) as typeof fetch;

	return requested;
}

describe('listNeonProjects', () => {
	it('sends org_id, which is what the bare call is refused for', async () => {
		const requested = mockNeon({
			organizations: [{ id: 'org-one' }],
			projectsByOrg: { 'org-one': [project('p1')] }
		});

		const projects = await listNeonProjects(credentials());

		expect(projects.map((entry) => entry.id)).toEqual(['p1']);
		// The regression in one assertion: no request for `/projects` without a
		// scope, because Neon answers that one with a 400.
		expect(requested.some((path) => path.includes('/projects?') && !path.includes('org_id='))).toBe(false);
		expect(requested).toContain('/api/v2/projects?limit=400&org_id=org-one');
	});

	it('merges every organisation the key reaches', async () => {
		// The quieter bug behind the 400: a key in two organisations would only
		// ever have seen one of them, and nothing would have said so.
		mockNeon({
			organizations: [{ id: 'org-one' }, { id: 'org-two' }],
			projectsByOrg: { 'org-one': [project('p1')], 'org-two': [project('p2')] }
		});

		const projects = await listNeonProjects(credentials());
		expect(projects.map((entry) => entry.id).sort()).toEqual(['p1', 'p2']);
	});

	it('de-duplicates a project reported by two scopes', async () => {
		mockNeon({
			organizations: [{ id: 'org-one' }, { id: 'org-two' }],
			projectsByOrg: { 'org-one': [project('p1')], 'org-two': [project('p1')] }
		});

		expect(await listNeonProjects(credentials())).toHaveLength(1);
	});

	it('drops a soft-deleted project rather than offering a dead end', async () => {
		mockNeon({
			organizations: [{ id: 'org-one' }],
			projectsByOrg: {
				'org-one': [project('p1'), { ...project('p2'), deleted_at: '2026-01-01T00:00:00Z' }]
			}
		});

		expect((await listNeonProjects(credentials())).map((entry) => entry.id)).toEqual(['p1']);
	});

	it('returns what it got when one organisation fails, and throws when none answered', async () => {
		// Partial failure is tolerated because half a list beats none; a TOTAL
		// failure must not be reported as "no projects", which is the "an absent
		// signal is not a negative one" mistake.
		mockNeon({
			organizations: [{ id: 'org-one' }, { id: 'org-two' }],
			projectsByOrg: { 'org-one': [project('p1')] },
			failing: { 'org-two': 500 }
		});
		expect((await listNeonProjects(credentials())).map((entry) => entry.id)).toEqual(['p1']);

		mockNeon({
			organizations: [{ id: 'org-one' }],
			projectsByOrg: {},
			failing: { 'org-one': 500 }
		});
		await expect(listNeonProjects(credentials())).rejects.toThrow();
	});

	it('falls back to the bare call only when the key reports no organisation', async () => {
		const requested = mockNeon({
			organizations: [],
			projectsByOrg: {},
			bareProjects: [project('legacy')]
		});

		expect((await listNeonProjects(credentials())).map((entry) => entry.id)).toEqual(['legacy']);
		expect(requested).toContain('/api/v2/projects?limit=400');
	});

	it("rewrites Neon's org_id message, which names a page that cannot help", async () => {
		// By the time this is reached it is OUR lookup that came back empty, so
		// repeating "you can find it on your organization settings page" would
		// send the user somewhere with nothing to fix.
		mockNeon({ organizations: [], projectsByOrg: {} });

		const error = await listNeonProjects(credentials()).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(NeonError);
		expect((error as NeonError).message).toBe(
			'This API key reaches no Neon organisation — create the key again from the account that owns your projects.'
		);
		// `config`, not `error`: the hub's strip should say there is something to
		// fix rather than showing a red failure with no guidance.
		expect((error as NeonError).kind).toBe('config');
	});
});
