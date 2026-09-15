/**
 * Resolving where a Neon branch answers.
 *
 * This file exists because two response shapes were conflated. Neon has both:
 *
 *   ConnectionDetails       `{ connection_uri, connection_parameters }`  — inside
 *                            the `connection_uris[]` array of a CREATE response
 *   ConnectionURIResponse   `{ uri }`                                    — what
 *                            `GET /connection_uri` answers with, and nothing else
 *
 * Reading the second as though it were the first leaves every discrete field
 * undefined, so linking any project failed with "Neon did not report a host for
 * branch …". The tests below pin both shapes and the choice between them.
 */

import { describe, it, expect, afterEach } from 'bun:test';

import {
	connectionFromCreateResponse,
	parseConnectionUri,
	resolveBranchConnection
} from './endpoints';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const DIRECT_HOST = 'ep-morning-scene-a1b2c3.ap-southeast-1.aws.neon.tech';
const POOLER_HOST = 'ep-morning-scene-a1b2c3-pooler.ap-southeast-1.aws.neon.tech';
const DIRECT_URI = `postgresql://neondb_owner:npg_secret@${DIRECT_HOST}/neondb?sslmode=require`;
const POOLED_URI = `postgresql://neondb_owner:npg_secret@${POOLER_HOST}/neondb?sslmode=require`;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

describe('parseConnectionUri', () => {
	it('reads every part back out of the bare string', () => {
		const parsed = parseConnectionUri(DIRECT_URI);

		expect(parsed).not.toBeNull();
		expect(parsed!.host).toBe(DIRECT_HOST);
		expect(parsed!.port).toBe(5432);
		expect(parsed!.username).toBe('neondb_owner');
		expect(parsed!.password).toBe('npg_secret');
		expect(parsed!.database).toBe('neondb');
		expect(parsed!.sslMode).toBe('require');
	});

	it('keeps the URI verbatim, since Neon already applied the mode we asked for', () => {
		// Rebuilding would drop options Neon chose to include and could disagree
		// with the discrete fields; both come from this one string instead.
		const withOptions = `${DIRECT_URI}&channel_binding=require`;
		expect(parseConnectionUri(withOptions)!.uri).toBe(withOptions);
	});

	it('decodes an escaped password rather than storing the escaping', () => {
		const parsed = parseConnectionUri(
			`postgresql://user%40x:p%40ss%2Fword@${DIRECT_HOST}/db?sslmode=require`
		);
		expect(parsed!.username).toBe('user@x');
		expect(parsed!.password).toBe('p@ss/word');
	});

	it('answers null for a URI that cannot log in', () => {
		// Reported as unresolved rather than passed on: a connection with no
		// password fails much later, inside a driver, saying "authentication
		// failed" instead of naming the real problem.
		expect(parseConnectionUri(`postgresql://neondb_owner@${DIRECT_HOST}/neondb`)).toBeNull();
		expect(parseConnectionUri('not a uri')).toBeNull();
	});
});

describe('connectionFromCreateResponse', () => {
	it('prefers connection_parameters, which carries both hosts', () => {
		const entries = [
			{
				connection_uri: DIRECT_URI,
				connection_parameters: {
					host: DIRECT_HOST,
					pooler_host: POOLER_HOST,
					role: 'neondb_owner',
					database: 'neondb',
					password: 'npg_secret'
				}
			}
		];

		expect(connectionFromCreateResponse(entries, false)!.host).toBe(DIRECT_HOST);
		expect(connectionFromCreateResponse(entries, true)!.host).toBe(POOLER_HOST);
	});

	it('falls back to parsing the string for a DIRECT request', () => {
		expect(connectionFromCreateResponse([{ connection_uri: DIRECT_URI }], false)!.host).toBe(
			DIRECT_HOST
		);
	});

	it('refuses to answer a POOLED request from the string alone', () => {
		// The string names the direct host, and deriving the pooler hostname would
		// mean guessing a naming convention. Null sends the caller to
		// `GET /connection_uri?pooled=true`, which answers authoritatively.
		expect(connectionFromCreateResponse([{ connection_uri: DIRECT_URI }], true)).toBeNull();
	});

	it('answers null when the create response carried nothing', () => {
		// The documented case: a branch cut from a parent with more than one role
		// or database comes back without any connection URI at all.
		expect(connectionFromCreateResponse(undefined, false)).toBeNull();
		expect(connectionFromCreateResponse([], false)).toBeNull();
	});
});

describe('resolveBranchConnection', () => {
	/** Neon, answering `/connection_uri` in its real `{ uri }` shape. */
	function mockNeon(options: { uri?: string; revealPassword?: string } = {}) {
		const requested: string[] = [];

		globalThis.fetch = (async (target: string | URL) => {
			const url = new URL(String(target));
			requested.push(url.pathname + url.search);

			if (url.pathname.endsWith('/databases')) return json({ databases: [{ name: 'neondb' }] });
			if (url.pathname.endsWith('/roles')) {
				return json({ roles: [{ name: 'neon_superuser', protected: true }, { name: 'neondb_owner' }] });
			}
			if (url.pathname.endsWith('/reveal_password')) {
				return json({ password: options.revealPassword });
			}
			if (url.pathname.endsWith('/connection_uri')) {
				const pooled = url.searchParams.get('pooled') === 'true';
				return json({ uri: options.uri ?? (pooled ? POOLED_URI : DIRECT_URI) });
			}
			throw new Error(`unexpected request: ${url}`);
		}) as typeof fetch;

		return requested;
	}

	it('resolves from the bare `{ uri }` shape the endpoint actually returns', async () => {
		// The regression in one test: this shape used to produce "Neon did not
		// report a host" for every project.
		const requested = mockNeon();

		const connection = await resolveBranchConnection(
			{ apiKey: 'napi_x' },
			{ projectId: 'proj-1', branchId: 'br-1', pooled: false }
		);

		expect(connection.host).toBe(DIRECT_HOST);
		expect(connection.password).toBe('npg_secret');
		expect(connection.database).toBe('neondb');
		expect(requested.some((path) => path.includes('database_name=neondb'))).toBe(true);
		expect(requested.some((path) => path.includes('role_name=neondb_owner'))).toBe(true);
	});

	it('asks for the pooled endpoint rather than deriving its hostname', async () => {
		mockNeon();

		const connection = await resolveBranchConnection(
			{ apiKey: 'napi_x' },
			{ projectId: 'proj-1', branchId: 'br-1', pooled: true }
		);
		expect(connection.host).toBe(POOLER_HOST);
	});

	it('skips a protected role, which cannot own a migration', async () => {
		const requested = mockNeon();
		await resolveBranchConnection(
			{ apiKey: 'napi_x' },
			{ projectId: 'proj-1', branchId: 'br-1', pooled: false }
		);
		expect(requested.some((path) => path.includes('role_name=neon_superuser'))).toBe(false);
	});

	it('reveals the password when the URI carries none', async () => {
		mockNeon({
			uri: `postgresql://neondb_owner@${DIRECT_HOST}/neondb`,
			revealPassword: 'npg_revealed'
		});

		const connection = await resolveBranchConnection(
			{ apiKey: 'napi_x' },
			{ projectId: 'proj-1', branchId: 'br-1', pooled: false }
		);
		expect(connection.password).toBe('npg_revealed');
		expect(connection.host).toBe(DIRECT_HOST);
	});

	it('names the real cause when the branch has no compute at all', async () => {
		mockNeon({ uri: '' });

		await expect(
			resolveBranchConnection({ apiKey: 'napi_x' }, { projectId: 'proj-1', branchId: 'br-1', pooled: false })
		).rejects.toThrow(/compute endpoint/);
	});
});
