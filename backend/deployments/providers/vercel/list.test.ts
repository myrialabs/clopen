/**
 * Filling a filtered page.
 *
 * Vercel cannot filter previews server-side — `target` is `production` or null,
 * and there is no `target=preview` to send — so the preview and custom filters
 * discard rows after the request. On a project that deploys production often,
 * one request can therefore answer with almost nothing while plenty more pages
 * exist.
 *
 * That is exactly the bug the Issues list shipped with `state=all`, where the
 * fifty most recently updated items were nearly all pull requests and almost
 * nothing survived the filter. These tests are here so it is not shipped twice.
 */

import { describe, it, expect, afterEach } from 'bun:test';

import { vercelDeployAdapter } from './adapter';
import type { DeployContext } from '../../types';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function deployment(id: string, target: string | null) {
	return {
		uid: id,
		name: 'web',
		url: `${id}.vercel.app`,
		readyState: 'READY',
		target,
		createdAt: 1_700_000_000_000
	};
}

/**
 * Answer the project call once, then hand back deployment pages in order.
 *
 * `next` is a timestamp cursor, and the last page returns null for it — which
 * is how the adapter learns to stop.
 */
function mockApi(pages: { deployments: unknown[]; next: number | null }[]) {
	const requested: string[] = [];

	globalThis.fetch = (async (input: string | URL) => {
		const url = String(input);
		requested.push(url);

		if (url.includes('/v9/projects/')) {
			return new Response(
				JSON.stringify({ id: 'prj_1', name: 'web', targets: { production: { id: 'dpl_live' } } }),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		}

		const page = pages.shift() ?? { deployments: [], next: null };
		return new Response(
			JSON.stringify({ deployments: page.deployments, pagination: { count: page.deployments.length, next: page.next, prev: null } }),
			{ status: 200, headers: { 'content-type': 'application/json' } }
		);
	}) as typeof fetch;

	return requested;
}

const context: DeployContext = {
	projectId: 'proj',
	// Only the fields the adapter reads; the account row never reaches the API.
	account: { id: 'acc_1', label: 'Vercel' } as DeployContext['account'],
	credentials: { token: 'tok' },
	binding: {
		locator: 'prj_1',
		displayName: 'web',
		detected: true,
		teamId: null,
		config: { environment: 'all', autoRefresh: true }
	}
};

describe('list — filling a filtered page', () => {
	it('keeps pulling until the FILTERED page is full', async () => {
		mockApi([
			// Almost all production: one preview survives the filter per page.
			{ deployments: [deployment('a', 'production'), deployment('b', null)], next: 111 },
			{ deployments: [deployment('c', 'production'), deployment('d', null)], next: 222 },
			{ deployments: [deployment('e', null), deployment('f', null)], next: null }
		]);

		const page = await vercelDeployAdapter.list(context, { environment: 'preview', limit: 4 });

		expect(page.items.map((item) => item.id)).toEqual(['b', 'd', 'e', 'f']);
		expect(page.items.every((item) => item.environment === 'preview')).toBe(true);
	});

	it('resumes from where the fill stopped, not from the next page number', async () => {
		const requested = mockApi([
			{ deployments: [deployment('a', 'production')], next: 111 },
			{ deployments: [deployment('b', null)], next: 222 }
		]);

		const page = await vercelDeployAdapter.list(context, { environment: 'preview', limit: 1 });

		// The cursor is the one the LAST request returned. Anything else re-reads
		// rows this page already discarded.
		expect(page.nextCursor).toBe('222');
		expect(page.hasMore).toBe(true);
		// The second request carried the first page's cursor.
		expect(requested.at(-1)).toContain('until=111');
	});

	it('stops and reports no more when the provider runs out', async () => {
		mockApi([{ deployments: [deployment('a', null)], next: null }]);

		const page = await vercelDeployAdapter.list(context, { environment: 'all', limit: 10 });

		expect(page.hasMore).toBe(false);
		expect(page.nextCursor).toBeNull();
	});

	it('filters server-side for production, so no fill is needed', async () => {
		const requested = mockApi([
			{ deployments: [deployment('a', 'production'), deployment('b', 'production')], next: null }
		]);

		const page = await vercelDeployAdapter.list(context, { environment: 'production', limit: 10 });

		expect(page.items).toHaveLength(2);
		expect(requested.some((url) => url.includes('target=production'))).toBe(true);
	});

	it('marks only the deployment the project says is live', async () => {
		mockApi([
			{ deployments: [deployment('dpl_live', 'production'), deployment('dpl_old', 'production')], next: null }
		]);

		const page = await vercelDeployAdapter.list(context, { environment: 'all', limit: 10 });

		expect(page.items.find((item) => item.id === 'dpl_live')?.isCurrent).toBe(true);
		// Ready and production, but superseded — and it must not claim otherwise.
		expect(page.items.find((item) => item.id === 'dpl_old')?.isCurrent).toBe(false);
	});
});

/**
 * Listing the projects a credential can reach.
 *
 * The default-scope listing and the per-team listing overlap whenever the
 * token's default scope IS one of the user's teams, which is the ordinary state
 * for anyone who works in a team. Concatenating them crashed the picker on a
 * duplicate key, and quietly de-duplicating it the wrong way is worse than the
 * crash: keep the unscoped copy and every later call drops the `teamId`, which
 * a team project answers with a 404 that reads like "no such project".
 */
function mockProjectLists(
	defaultScope: { id: string; name: string }[],
	teams: { team: { id: string; name: string }; projects: { id: string; name: string }[] }[]
) {
	globalThis.fetch = (async (input: string | URL) => {
		const url = new URL(String(input));
		const json = (body: unknown) =>
			new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

		if (url.pathname === '/v2/teams') {
			return json({ teams: teams.map((entry) => entry.team) });
		}

		const teamId = url.searchParams.get('teamId');
		if (!teamId) return json({ projects: defaultScope });

		const match = teams.find((entry) => entry.team.id === teamId);
		return json({ projects: match?.projects ?? [] });
	}) as typeof fetch;
}

const unbound = {
	projectId: 'proj',
	account: { id: 'acc_1', label: 'Vercel' } as DeployContext['account'],
	credentials: { token: 'tok' }
};

describe('listTargets — overlapping scopes', () => {
	it('lists a project once when the default scope is also a team', async () => {
		mockProjectLists(
			[{ id: 'prj_1', name: 'web' }],
			[{ team: { id: 'team_a', name: 'Acme' }, projects: [{ id: 'prj_1', name: 'web' }] }]
		);

		const targets = await vercelDeployAdapter.listTargets(unbound);

		expect(targets).toHaveLength(1);
		expect(targets.map((target) => target.id)).toEqual(['prj_1']);
	});

	it('keeps the TEAM-scoped copy, because every later call needs the team id', async () => {
		mockProjectLists(
			[{ id: 'prj_1', name: 'web' }],
			[{ team: { id: 'team_a', name: 'Acme' }, projects: [{ id: 'prj_1', name: 'web' }] }]
		);

		const [target] = await vercelDeployAdapter.listTargets(unbound);

		expect(target.teamId).toBe('team_a');
		expect(target.teamName).toBe('Acme');
	});

	it('leaves a genuinely personal project unscoped', async () => {
		mockProjectLists(
			[{ id: 'prj_solo', name: 'solo' }],
			[{ team: { id: 'team_a', name: 'Acme' }, projects: [{ id: 'prj_team', name: 'team-app' }] }]
		);

		const targets = await vercelDeployAdapter.listTargets(unbound);

		expect(targets.find((target) => target.id === 'prj_solo')?.teamId).toBeNull();
		expect(targets.find((target) => target.id === 'prj_team')?.teamId).toBe('team_a');
	});

	it('still lists the default scope when teams cannot be read', async () => {
		globalThis.fetch = (async (input: string | URL) => {
			const url = new URL(String(input));
			if (url.pathname === '/v2/teams') return new Response('{}', { status: 403 });
			return new Response(JSON.stringify({ projects: [{ id: 'prj_1', name: 'web' }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}) as typeof fetch;

		// A token scoped to one project cannot list teams, and that must not turn
		// into an empty picker.
		const targets = await vercelDeployAdapter.listTargets(unbound);
		expect(targets.map((target) => target.id)).toEqual(['prj_1']);
	});
});

describe('list — overlapping pages', () => {
	it('does not repeat a deployment the previous page already returned', async () => {
		// A build landing mid-fill shifts the timestamp window, so the next page
		// can start on a row the last one ended with. The list is keyed by id.
		mockApi([
			{ deployments: [deployment('a', null), deployment('b', null)], next: 111 },
			{ deployments: [deployment('b', null), deployment('c', null)], next: null }
		]);

		const page = await vercelDeployAdapter.list(context, { environment: 'all', limit: 10 });

		expect(page.items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
	});
})

/**
 * Starting a build, and creating a project.
 *
 * The trap in `createDeployment` is that `name` alone is enough for the API to
 * accept the request — and when the name does not match an existing project it
 * CREATES one. A build meant for the bound project would silently land in a
 * second project beside it, which is the kind of wrong that looks like nothing
 * happened. `project` is what pins it.
 */
function mockPost(project: Record<string, unknown>) {
	const calls: { url: string; body: Record<string, unknown> }[] = [];

	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const json = (body: unknown) =>
			new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

		if (init?.method === 'POST') {
			calls.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
			return json({ uid: 'dpl_new', id: 'prj_new', name: 'web' });
		}
		return json(project);
	}) as typeof fetch;

	return calls;
}

describe('createDeployment', () => {
	const linked = {
		id: 'prj_1',
		name: 'web',
		link: { type: 'github', org: 'acme', repo: 'web', repoId: 42, productionBranch: 'main' }
	};

	it('pins the build to the bound project, not merely to a name', async () => {
		const calls = mockPost(linked);

		await vercelDeployAdapter.createDeployment!(context, { ref: 'main', production: false });

		expect(calls[0].body.project).toBe('prj_1');
	});

	it('builds from the branch asked for, through the project own git provider', async () => {
		const calls = mockPost(linked);

		await vercelDeployAdapter.createDeployment!(context, { ref: 'feature/x', production: false });

		// A GitLab-linked project rejects `type: 'github'` outright, so the type
		// comes from the project rather than from a default.
		expect(calls[0].body.gitSource).toEqual({ type: 'github', ref: 'feature/x', repoId: 42 });
	});

	it('omits target for a preview build, because there is no preview target', async () => {
		const calls = mockPost(linked);

		await vercelDeployAdapter.createDeployment!(context, { ref: 'main', production: false });
		expect(calls[0].body.target).toBeUndefined();

		await vercelDeployAdapter.createDeployment!(context, { ref: 'main', production: true });
		expect(calls[1].body.target).toBe('production');
	});

	it('refuses when the project has no repository to build from', async () => {
		mockPost({ id: 'prj_1', name: 'web', link: null });

		expect(vercelDeployAdapter.createDeployment!(context, { ref: 'main', production: false }))
			.rejects.toThrow(/not connected to a git repository/);
	});
});

describe('deployInfo', () => {
	it('reports a git-connected project as deployable, with its production branch', async () => {
		mockPost({ id: 'prj_1', name: 'web', link: { type: 'github', org: 'acme', repo: 'web', repoId: 42, productionBranch: 'trunk' } });

		const info = await vercelDeployAdapter.deployInfo!(context);

		expect(info).toMatchObject({ canDeploy: true, gitRepo: 'acme/web', productionBranch: 'trunk' });
	});

	it('falls back to main when the project defers to the repository default', async () => {
		mockPost({ id: 'prj_1', name: 'web', link: { type: 'github', org: 'acme', repo: 'web', repoId: 42, productionBranch: null } });

		expect((await vercelDeployAdapter.deployInfo!(context)).productionBranch).toBe('main');
	});

	it('explains why an unconnected project cannot be deployed, rather than failing later', async () => {
		mockPost({ id: 'prj_1', name: 'web', link: null });

		const info = await vercelDeployAdapter.deployInfo!(context);

		expect(info.canDeploy).toBe(false);
		expect(info.reason).toMatch(/not connected to a git repository/);
	});
});

describe('createProject', () => {
	it('connects the repository it was given', async () => {
		const calls = mockPost({});

		await vercelDeployAdapter.createProject!(unbound, {
			name: 'web',
			gitRepo: 'acme/web',
			gitProvider: 'github',
			framework: null
		});

		expect(calls[0].body).toMatchObject({
			name: 'web',
			gitRepository: { type: 'github', repo: 'acme/web' }
		});
	});

	it('leaves the framework unset rather than guessing one', async () => {
		const calls = mockPost({});

		await vercelDeployAdapter.createProject!(unbound, {
			name: 'web',
			gitRepo: null,
			gitProvider: null,
			framework: null
		});

		// A wrong framework is a broken build with a confusing cause; the host
		// detects it from the repository.
		expect(calls[0].body.framework).toBeUndefined();
		expect(calls[0].body.gitRepository).toBeUndefined();
	});
});

describe('connectRepository', () => {
	it('attaches the repository to the bound project, scoped to its team', async () => {
		const calls = mockPost({});
		const teamContext = { ...context, binding: { ...context.binding, teamId: 'team_a' } };

		await vercelDeployAdapter.connectRepository!(teamContext, {
			gitRepo: 'acme/web',
			gitProvider: 'github'
		});

		expect(calls[0].url).toContain('/v9/projects/prj_1/link');
		expect(calls[0].url).toContain('teamId=team_a');
		expect(calls[0].body).toEqual({ type: 'github', repo: 'acme/web' });
	});

	it('passes the provider through rather than assuming github', async () => {
		const calls = mockPost({});

		await vercelDeployAdapter.connectRepository!(context, {
			gitRepo: 'acme/web',
			gitProvider: 'gitlab'
		});

		expect(calls[0].body.type).toBe('gitlab');
	});
});

/**
 * Knowing in advance whether Connect can work.
 *
 * Vercel needs the ACCOUNT to hold a git login connection before any project
 * can be linked, and reports its absence only when the link is attempted — at
 * the moment the user has already been promised the button would work. That
 * prerequisite is an OAuth flow on Vercel's own site: no API token can supply
 * it, so the honest move is to detect it and point at the fix.
 */
function mockNamespaces(namespaces: unknown[] | { status: number }) {
	globalThis.fetch = (async (input: string | URL) => {
		const url = new URL(String(input));
		if (url.pathname === '/v1/integrations/git-namespaces') {
			if (!Array.isArray(namespaces)) return new Response('{}', { status: namespaces.status });
			return new Response(JSON.stringify(namespaces), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}
		return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
	}) as typeof fetch;
}

describe('repositoryAccess', () => {
	it('does NOT treat an empty list as proof the account has no connection', async () => {
		// This was the bug. An account with GitHub connected and working reported
		// no namespaces, and the check disabled the button on that inference —
		// telling the user something they could see on screen was false. Silence
		// from this endpoint can also mean a token that cannot read integrations.
		mockNamespaces([]);

		const access = await vercelDeployAdapter.repositoryAccess!(context, 'argafairuz/calc-2');

		expect(access.state).toBe('unknown');
		expect(access.actionUrl).toBe('https://github.com/apps/vercel/installations/new');
	});

	it('allows it when the repository owner is reachable', async () => {
		mockNamespaces([{ id: 1, slug: 'argafairuz', provider: 'github', ownerType: 'user' }]);

		const access = await vercelDeployAdapter.repositoryAccess!(context, 'argafairuz/calc-2');

		expect(access.state).toBe('ready');
		expect(access.reason).toBeNull();
	});

	it('matches the owner case-insensitively', async () => {
		mockNamespaces([{ id: 1, slug: 'ArgaFairuz', provider: 'github', ownerType: 'user' }]);

		expect((await vercelDeployAdapter.repositoryAccess!(context, 'argafairuz/calc-2')).state).toBe('ready');
	});

	it('blocks only when the list is NON-empty and still omits the owner', async () => {
		// That combination is informative: the app is installed somewhere, just
		// not where this repository lives.
		mockNamespaces([
			{ id: 1, slug: 'acme', provider: 'github', ownerType: 'team' },
			{ id: 2, slug: 'someone-else', provider: 'github', ownerType: 'user' }
		]);

		const access = await vercelDeployAdapter.repositoryAccess!(context, 'argafairuz/calc-2');

		expect(access.state).toBe('blocked');
		expect(access.reason).toContain('acme');
		expect(access.reason).toContain('argafairuz');
	});

	it('blocks on a restricted namespace, which looks reachable but is not', async () => {
		mockNamespaces([
			{ id: 1, slug: 'argafairuz', provider: 'github', ownerType: 'user', isAccessRestricted: true }
		]);

		const access = await vercelDeployAdapter.repositoryAccess!(context, 'argafairuz/calc-2');
		expect(access.state).toBe('blocked');
		expect(access.reason).toMatch(/restricted/i);
	});

	it('reports UNKNOWN rather than ready when the check itself fails', async () => {
		// The first version answered "ready" here, which put the button back on
		// screen and let the very failure this check exists to prevent arrive as
		// a toast. Unreadable is its own answer.
		mockNamespaces({ status: 403 });

		const access = await vercelDeployAdapter.repositoryAccess!(context, 'argafairuz/calc-2');

		expect(access.state).toBe('unknown');
		expect(access.actionUrl).toBe('https://github.com/apps/vercel/installations/new');
	});

	it('tolerates a wrapped response instead of reading it as "no namespaces"', async () => {
		// Documented as a bare array. Reading a wrapper as empty would produce a
		// confident "blocked" built on a parsing mistake.
		globalThis.fetch = (async (input: string | URL) => {
			const url = new URL(String(input));
			if (url.pathname === '/v1/integrations/git-namespaces') {
				return new Response(
					JSON.stringify({ gitNamespaces: [{ id: 1, slug: 'argafairuz', provider: 'github', ownerType: 'user' }] }),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			}
			return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
		}) as typeof fetch;

		expect((await vercelDeployAdapter.repositoryAccess!(context, 'argafairuz/calc-2')).state).toBe('ready');
	});

	it('does NOT send teamId, which this endpoint rejects outright', async () => {
		// Nearly every other Vercel endpoint requires `teamId`; this one answers
		// 400 for it, because git namespaces belong to the signed-in user rather
		// than to a team. Sending it turned every check into an error, which the
		// caller reported as "could not verify" and let the button through — one
		// wrong query parameter made the whole pre-flight decoration.
		const urls: string[] = [];
		globalThis.fetch = (async (input: string | URL) => {
			urls.push(String(input));
			return new Response(JSON.stringify([{ id: 1, slug: 'argafairuz', provider: 'github', ownerType: 'user' }]), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}) as typeof fetch;

		const teamContext = { ...context, binding: { ...context.binding, teamId: 'team_a' } };
		await vercelDeployAdapter.repositoryAccess!(teamContext, 'argafairuz/calc-2');

		const call = urls.find((url) => url.includes('git-namespaces'))!;
		expect(call).not.toContain('teamId');
		expect(call).not.toContain('slug=');
	});
});

/**
 * Deleting, pausing, and reading what the target is doing.
 *
 * The rollback candidacy case is the one worth guarding: `isRollbackCandidate`
 * has THREE answers, and collapsing the missing one into `false` hid the
 * rollback action on every listing that omitted the field.
 */
describe('deleteDeployment', () => {
	it('deletes through the versioned deployment path, scoped to its team', async () => {
		const urls: string[] = [];
		const methods: string[] = [];
		globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
			urls.push(String(input));
			methods.push(init?.method ?? 'GET');
			return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
		}) as typeof fetch;

		const teamContext = { ...context, binding: { ...context.binding, teamId: 'team_a' } };
		await vercelDeployAdapter.deleteDeployment!(teamContext, 'dpl_1');

		expect(methods[0]).toBe('DELETE');
		expect(urls[0]).toContain('/v13/deployments/dpl_1');
		expect(urls[0]).toContain('teamId=team_a');
	});
});

describe('projectStatus', () => {
	function mockProject(project: Record<string, unknown>) {
		globalThis.fetch = (async (_input: string | URL) =>
			new Response(JSON.stringify(project), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})) as typeof fetch;
	}

	it('reports a paused target, which is read-only here', async () => {
		// Clopen never pauses: on Vercel that blocks the active production
		// deployment, so the site goes down rather than merely stopping builds.
		// It is surfaced only because nothing else explains an idle list.
		mockProject({ id: 'prj_1', name: 'web', paused: true });
		expect((await vercelDeployAdapter.projectStatus!(context)).paused).toBe(true);
	});

	it('surfaces a traffic move still being carried out', async () => {
		// This is what turns the `pending` rollback and promote return into an
		// outcome — without it the panel could never say whether traffic moved.
		mockProject({
			id: 'prj_1',
			name: 'web',
			lastAliasRequest: { type: 'rollback', jobStatus: 'in-progress', toDeploymentId: 'dpl_9' }
		});

		const status = await vercelDeployAdapter.projectStatus!(context);

		expect(status.aliasRequest).toEqual({
			type: 'rollback',
			status: 'in-progress',
			toDeploymentId: 'dpl_9'
		});
	});

	it('answers null when no traffic move has been requested', async () => {
		mockProject({ id: 'prj_1', name: 'web' });
		expect((await vercelDeployAdapter.projectStatus!(context)).aliasRequest).toBeNull();
	});
});

describe('rollback candidacy', () => {
	it('keeps the provider three answers apart', async () => {
		mockApi([
			{
				deployments: [
					{ ...deployment('a', 'production'), isRollbackCandidate: true },
					{ ...deployment('b', 'production'), isRollbackCandidate: false },
					// Says nothing — must NOT read as "no".
					deployment('c', 'production')
				],
				next: null
			}
		]);

		const page = await vercelDeployAdapter.list(context, { environment: 'all', limit: 10 });
		const byId = Object.fromEntries(page.items.map((item) => [item.id, item.isRollbackCandidate]));

		expect(byId.a).toBe(true);
		expect(byId.b).toBe(false);
		expect(byId.c).toBeNull();
	});
});
