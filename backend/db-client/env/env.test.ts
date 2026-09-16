/**
 * Tests for DB Client → environment variables.
 *
 * The cases here are the ones that make the feature worth having, or make it
 * dangerous:
 *
 *  - Detection has to find the name the PROJECT uses, or the whole premise
 *    collapses into "we wrote DATABASE_URL and nothing read it".
 *  - It has to find it in `.env.example` and in `prisma/schema.prisma` too,
 *    because a fresh clone has a schema and no dotenv file.
 *  - It must NOT claim `NEXT_PUBLIC_API_URL` or `SMTP_HOST` as a database.
 *  - Applying must update the key where the project already has it, and must
 *    never touch a file git tracks without being told to.
 *  - A worktree's branch block owns the end of the file, so a write above it
 *    has no effect and must be refused rather than reported as a success.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { closeDatabase, initializeDatabase } from '$backend/database';
import { execGit } from '$backend/git/git-executor';
import type { DbClientConnection, DbDriver } from '$shared/types/db-client';
import { detectEnvUsage } from './detect';
import { diffLines } from './diff';
import { defaultPrefixFor, renderEnvVars } from './naming';
import { dbClientEnv, type EnvScope } from './service';

const PASSWORD = 's3cr3t';

function connection(overrides: Partial<DbClientConnection> = {}): DbClientConnection {
	return {
		id: 'conn-env-test',
		name: 'Shop DB',
		driver: 'postgres' as DbDriver,
		host: 'db.example.com',
		port: 5432,
		username: 'app',
		password: PASSWORD,
		database: 'shop',
		sslMode: 'require',
		sslCa: null,
		ssh: {
			enabled: false,
			connectionId: null,
			host: '',
			port: 22,
			username: '',
			authMethod: 'password'
		},
		options: {},
		color: null,
		createdAt: '',
		updatedAt: '',
		lastUsedAt: null,
		...overrides
	};
}

let root: string;
let scope: EnvScope;

beforeAll(async () => {
	await initializeDatabase();
});

afterAll(() => {
	closeDatabase();
});

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), 'clopen-dbenv-'));
	scope = { projectId: 'p1', projectName: 'Shop', root };
	await execGit(['init'], root);
	await execGit(['config', 'user.email', 'test@example.com'], root);
	await execGit(['config', 'user.name', 'Test'], root);
	await fs.writeFile(path.join(root, '.gitignore'), '.env\n.env.local\n');
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

const request = (overrides: Record<string, unknown> = {}) =>
	({
		connectionId: 'conn-env-test',
		shape: 'url',
		prefix: 'DATABASE',
		fileName: '.env',
		...overrides
	}) as Parameters<typeof dbClientEnv.plan>[2];

describe('naming', () => {
	const base = {
		connection: connection(),
		url: 'postgresql://app:s3cr3t@db.example.com:5432/shop?sslmode=require',
		alternateUrl: null as string | null
	};

	it('renders a single URL and the split form from the same connection', () => {
		expect(renderEnvVars({ ...base, naming: { shape: 'url', prefix: 'DATABASE' } })).toEqual([
			{
				key: 'DATABASE_URL',
				value: 'postgresql://app:s3cr3t@db.example.com:5432/shop?sslmode=require',
				isSecret: true,
				note: null
			}
		]);

		const split = renderEnvVars({ ...base, naming: { shape: 'split', prefix: 'DB' } });
		expect(split.map((entry) => entry.key)).toEqual([
			'DB_HOST',
			'DB_PORT',
			'DB_USER',
			'DB_PASSWORD',
			'DB_NAME',
			'DB_SSLMODE'
		]);
		expect(split.find((entry) => entry.key === 'DB_PASSWORD')).toMatchObject({
			value: PASSWORD,
			isSecret: true
		});
	});

	it('writes the project’s own names when it has some', () => {
		// The whole reason the framework presets are gone: a project using
		// DB_USERNAME gets DB_USERNAME, not a DB_USER beside it that nothing reads.
		const split = renderEnvVars({
			...base,
			naming: {
				shape: 'split',
				prefix: 'DB',
				keyMap: { user: 'DB_USERNAME', database: 'DB_DATABASE', host: 'PGHOST' }
			}
		});

		const keys = split.map((entry) => entry.key);
		expect(keys).toContain('DB_USERNAME');
		expect(keys).toContain('DB_DATABASE');
		expect(keys).toContain('PGHOST');
		expect(keys).not.toContain('DB_USER');
		expect(keys).not.toContain('DB_NAME');
	});

	it('uses the driver’s own word for the URL, not one spelling for all', () => {
		// MONGODB_URL is not a variant of MONGODB_URI, it is a variable nothing
		// reads. That is a fact about the driver, not about a framework.
		expect(defaultPrefixFor('mongodb', 'url')).toBe('MONGODB');
		const mongo = renderEnvVars({
			connection: connection({ driver: 'mongodb', port: 27017 }),
			naming: { shape: 'url', prefix: 'MONGODB' },
			url: 'mongodb://app:s3cr3t@db.example.com:27017/shop',
			alternateUrl: null
		});
		expect(mongo[0].key).toBe('MONGODB_URI');
	});

	it('leaves the user out of a Redis split, because there is not one', () => {
		const redis = renderEnvVars({
			connection: connection({ driver: 'redis', database: '0', port: 6379, username: null }),
			naming: { shape: 'split', prefix: 'REDIS' },
			url: 'redis://:s3cr3t@db.example.com:6379/0',
			alternateUrl: null
		});
		expect(redis.map((entry) => entry.key)).not.toContain('REDIS_USER');
	});

	it('keeps an empty password but drops the fields that describe nothing', () => {
		// `DB_HOST=` reads as a configured empty host and fails later than not
		// being there. An empty password is a real local configuration.
		const split = renderEnvVars({
			connection: connection({ password: null, username: null, database: null }),
			naming: { shape: 'split', prefix: 'DB' },
			url: '',
			alternateUrl: null
		});

		expect(split.map((entry) => entry.key)).toEqual(['DB_HOST', 'DB_PORT', 'DB_PASSWORD', 'DB_SSLMODE']);
		expect(split.find((entry) => entry.key === 'DB_PASSWORD')?.value).toBe('');
	});

	it('writes the second endpoint only when there is one, under the provider’s suffix', () => {
		expect(
			renderEnvVars({ ...base, naming: { shape: 'url', prefix: 'DATABASE' } }).map((e) => e.key)
		).toEqual(['DATABASE_URL']);

		expect(
			renderEnvVars({
				...base,
				alternateUrl: 'postgresql://direct',
				naming: { shape: 'url', prefix: 'POSTGRES', altSuffix: '_NON_POOLING' }
			}).map((e) => e.key)
		).toEqual(['POSTGRES_URL', 'POSTGRES_URL_NON_POOLING']);
	});

	it('describes SQLite as a path rather than inventing an endpoint', () => {
		const vars = renderEnvVars({
			connection: connection({ driver: 'sqlite', database: '/data/app.db' }),
			naming: { shape: 'split', prefix: 'DB' },
			url: 'file:/data/app.db',
			alternateUrl: null
		});
		expect(vars).toEqual([{ key: 'DB_PATH', value: '/data/app.db', isSecret: false, note: null }]);
	});
});

describe('detectEnvUsage', () => {
	it('finds the convention the project actually uses, most-precedent file first', async () => {
		// Two groups neither of which names an engine, so the file decides:
		// `.env.local` wins in Next.js and Vite.
		await fs.writeFile(path.join(root, '.env'), 'MAIN_DB_URL=postgres://old\nSMTP_HOST=mail\n');
		await fs.writeFile(path.join(root, '.env.local'), 'DATABASE_URL=postgres://local\n');

		const detection = await detectEnvUsage({
			root,
			projectId: 'p1',
			projectName: 'Shop',
			driver: 'postgres'
		});

		const labels = detection.existing.map((group) => group.keys.join(','));
		expect(labels).toContain('DATABASE_URL');
		expect(labels).toContain('MAIN_DB_URL');
		expect(detection.existing[0].keys).toEqual(['DATABASE_URL']);
		expect(detection.existing[0].files).toEqual(['.env.local']);
		// SMTP_HOST is not a database, and one stray HOST must not become a group.
		expect(labels.join(' ')).not.toContain('SMTP');
	});

	it('opens on the group that names THIS engine, not the other one', async () => {
		// A project with both is ordinary, and only one of them belongs to the
		// connection being written. Without this the first thing a Redis
		// connection offers is to overwrite the Postgres URL.
		await fs.writeFile(
			path.join(root, '.env'),
			'DATABASE_URL=postgres://pg\nREDIS_URL=redis://localhost:6379\n'
		);

		const forRedis = await detectEnvUsage({ root, projectId: 'p1', projectName: 'Shop', driver: 'redis' });
		expect(forRedis.existing[0].keys).toEqual(['REDIS_URL']);

		const forPostgres = await detectEnvUsage({ root, projectId: 'p1', projectName: 'Shop', driver: 'postgres' });
		expect(forPostgres.existing[0].keys).toEqual(['DATABASE_URL']);
	});

	it('groups a split convention and names it', async () => {
		await fs.writeFile(
			path.join(root, '.env'),
			['DB_HOST=localhost', 'DB_PORT=5432', 'DB_USERNAME=app', 'DB_PASSWORD=x', 'DB_DATABASE=shop'].join('\n')
		);

		const detection = await detectEnvUsage({ root, projectId: 'p1', projectName: 'Shop', driver: 'postgres' });

		expect(detection.existing).toHaveLength(1);
		expect(detection.existing[0]).toMatchObject({ prefix: 'DB', shape: 'split' });
		expect(detection.existing[0].isTemplateOnly).toBe(false);
		// The roles, mapped onto the names THIS project uses — `DB_USERNAME` and
		// `DB_DATABASE`, not the generic `DB_USER` and `DB_NAME`.
		expect(detection.existing[0].keyMap).toMatchObject({
			host: 'DB_HOST',
			port: 'DB_PORT',
			user: 'DB_USERNAME',
			password: 'DB_PASSWORD',
			database: 'DB_DATABASE'
		});
	});

	it('reads a template for its shape and marks it as documentation', async () => {
		// `.env.example` is often the only record of the names a project expects,
		// and writing a password into it is the one thing that must not happen.
		await fs.writeFile(path.join(root, '.env.example'), '# DATABASE_URL=\nAPP_NAME=shop\n');

		const detection = await detectEnvUsage({ root, projectId: 'p1', projectName: 'Shop', driver: 'postgres' });

		expect(detection.existing[0]).toMatchObject({
			keys: ['DATABASE_URL'],
			isTemplateOnly: true
		});
		expect(detection.files.find((file) => file.name === '.env.example')?.isTemplate).toBe(true);
	});

	it('finds the name a Prisma schema reads when no dotenv file exists', async () => {
		await fs.mkdir(path.join(root, 'prisma'), { recursive: true });
		await fs.writeFile(
			path.join(root, 'prisma/schema.prisma'),
			'datasource db {\n  provider = "postgresql"\n  url = env("POSTGRES_PRISMA_URL")\n  directUrl = env("DIRECT_URL")\n}\n'
		);

		const detection = await detectEnvUsage({ root, projectId: 'p1', projectName: 'Shop', driver: 'postgres' });

		expect(detection.sources).toContain('prisma/schema.prisma');
		const keys = detection.existing.flatMap((group) => group.keys);
		expect(keys).toContain('POSTGRES_PRISMA_URL');
		expect(keys).toContain('DIRECT_URL');
	});

	it('finds the name a drizzle config reads', async () => {
		await fs.writeFile(
			path.join(root, 'drizzle.config.ts'),
			'export default { dbCredentials: { url: process.env.SHOP_DATABASE_URL! } };\n'
		);

		const detection = await detectEnvUsage({ root, projectId: 'p1', projectName: 'Shop', driver: 'postgres' });
		expect(detection.existing.flatMap((g) => g.keys)).toContain('SHOP_DATABASE_URL');
	});

	it('does not claim an unrelated URL as a database', async () => {
		await fs.writeFile(
			path.join(root, '.env'),
			'NEXT_PUBLIC_API_URL=https://api.example.com\nSENTRY_DSN=https://x@sentry.io/1\n'
		);

		const detection = await detectEnvUsage({ root, projectId: 'p1', projectName: 'Shop', driver: 'postgres' });
		expect(detection.existing).toEqual([]);
	});

	it('claims a neutrally named URL when its VALUE is a connection string', async () => {
		await fs.writeFile(path.join(root, '.env'), 'STORE_URL=postgres://app@localhost/shop\n');

		const detection = await detectEnvUsage({ root, projectId: 'p1', projectName: 'Shop', driver: 'postgres' });
		expect(detection.existing[0].keys).toEqual(['STORE_URL']);
	});

	it('refuses to offer Prisma’s shadow database', async () => {
		// It is a separate, disposable database Prisma diffs migrations against;
		// pointing it at the real one would run that diff on real data.
		await fs.writeFile(path.join(root, '.env'), 'SHADOW_DATABASE_URL=postgres://shadow\n');

		const detection = await detectEnvUsage({ root, projectId: 'p1', projectName: 'Shop', driver: 'postgres' });
		expect(detection.existing).toEqual([]);
	});
});

describe('dbClientEnv.state', () => {
	it('opens on the convention and the file the project already uses', async () => {
		await fs.writeFile(path.join(root, '.env'), 'DATABASE_URL=postgres://old\n');
		await fs.writeFile(path.join(root, '.env.local'), 'DB_HOST=localhost\nDB_USER=app\nDB_PASSWORD=x\n');

		const state = await dbClientEnv.state(connection(), scope);

		expect(state.suggestion.shape).toBe('split');
		expect(state.suggestion.prefix).toBe('DB');
		expect(state.suggestion.fileName).toBe('.env.local');
		expect(state.suggestion.keyMap).toMatchObject({ host: 'DB_HOST', user: 'DB_USER' });
	});

	it('falls back to a preset, and to .env, for a project with nothing', async () => {
		const state = await dbClientEnv.state(connection(), scope);

		expect(state.suggestion.shape).toBe('url');
		expect(state.suggestion.prefix).toBe('DATABASE');
		expect(state.suggestion.fileName).toBe('.env');
		expect(state.detection.existing).toEqual([]);
	});

	it('still lists the variables when no project is in scope', async () => {
		const state = await dbClientEnv.state(connection(), null);

		expect(state.suggestion.fileName).toBe(null);
		expect(state.shapes.map((entry) => entry.id)).toEqual(['url', 'split']);
	});

	it('warns about an SSH tunnel the project cannot use', async () => {
		const state = await dbClientEnv.state(
			connection({ ssh: { enabled: true, connectionId: null, host: 'jump', port: 22, username: 'x', authMethod: 'key' } }),
			scope
		);

		expect(state.warnings.join(' ')).toContain('SSH tunnel');
	});
});

describe('dbClientEnv.plan', () => {
	it('updates the key where the project already has it', async () => {
		await fs.writeFile(path.join(root, '.env'), '# app\nDATABASE_URL=postgres://old\nAPP=1\n');

		const plan = await dbClientEnv.plan(connection(), scope, request());

		expect(plan.updated).toEqual(['DATABASE_URL']);
		expect(plan.appended).toEqual([]);
		expect(plan.diff.some((line) => line.kind === 'removed' && line.text.includes('postgres://old'))).toBe(true);
		expect(plan.diff.some((line) => line.kind === 'added' && line.text.includes('db.example.com'))).toBe(true);
	});

	it('appends into a managed block when the project has no such key', async () => {
		await fs.writeFile(path.join(root, '.env'), 'APP=1\n');

		const plan = await dbClientEnv.plan(connection(), scope, request());
		expect(plan.appended).toEqual(['DATABASE_URL']);
		expect(plan.updated).toEqual([]);
	});

	it('reports a tracked file rather than silently writing one', async () => {
		await fs.writeFile(path.join(root, '.env.production'), 'APP=1\n');
		await execGit(['add', '.env.production'], root);
		await execGit(['commit', '-m', 'add env'], root);

		const plan = await dbClientEnv.plan(connection(), scope, request({ fileName: '.env.production' }));
		expect(plan.fileTracked).toBe(true);
	});

	it('describes the database in scope, not the connection\u2019s empty one', async () => {
		// A connection with no database of its own browses one, and it is THAT one
		// the project needs a URL for. The connection's own empty field would
		// produce a string pointing at the server with no database on the end.
		const plan = await dbClientEnv.plan(
			connection({ database: null }),
			scope,
			request({ database: 'analytics', fileName: '' })
		);

		expect(plan.vars[0].value).toContain('/analytics');
	});

	it('renders a pasteable fragment even with no file chosen', async () => {
		const plan = await dbClientEnv.plan(connection(), scope, request({ fileName: '' }));

		expect(plan.fileName).toBe(null);
		expect(plan.text.trim()).toBe(
			'DATABASE_URL=postgresql://app:s3cr3t@db.example.com:5432/shop?sslmode=require'
		);
	});

	it('refuses a prefix that is not a legal variable name', async () => {
		await expect(
			dbClientEnv.plan(connection(), scope, request({ prefix: 'my-db' }))
		).rejects.toThrow('valid variable prefix');
	});

	it('refuses a shape it cannot write', async () => {
		await expect(
			dbClientEnv.plan(connection(), scope, request({ shape: 'framework' }))
		).rejects.toThrow('is not a shape');
	});
});

describe('dbClientEnv.apply and remove', () => {
	it('writes, then puts the previous value back', async () => {
		await fs.writeFile(path.join(root, '.env'), 'DATABASE_URL=postgres://mine\nAPP=1\n');

		const applied = await dbClientEnv.apply(connection(), scope, request());
		expect(applied.status).toBe('written');
		expect(applied.updated).toEqual(['DATABASE_URL']);

		let contents = await fs.readFile(path.join(root, '.env'), 'utf-8');
		expect(contents).toContain('db.example.com');
		expect(contents).toContain('APP=1');

		const removed = await dbClientEnv.remove(connection(), scope, request());
		expect(removed.status).toBe('written');

		contents = await fs.readFile(path.join(root, '.env'), 'utf-8');
		expect(contents).toContain('DATABASE_URL=postgres://mine');
		expect(contents).not.toContain('db.example.com');
		expect(contents).toContain('APP=1');
	});

	it('leaves a value the user edited after applying', async () => {
		await dbClientEnv.apply(connection(), scope, request());
		const target = path.join(root, '.env');
		const edited = (await fs.readFile(target, 'utf-8')).replace('db.example.com', 'their-host');
		await fs.writeFile(target, edited);

		await dbClientEnv.remove(connection(), scope, request());

		expect(await fs.readFile(target, 'utf-8')).toContain('their-host');
	});

	it('refuses a tracked file until the caller says otherwise', async () => {
		await fs.writeFile(path.join(root, '.env.production'), 'APP=1\n');
		await execGit(['add', '.env.production'], root);
		await execGit(['commit', '-m', 'add env'], root);

		const refused = await dbClientEnv.apply(
			connection(),
			scope,
			request({ fileName: '.env.production' })
		);
		expect(refused.status).toBe('skipped-tracked');
		expect(await fs.readFile(path.join(root, '.env.production'), 'utf-8')).toBe('APP=1\n');

		const allowed = await dbClientEnv.apply(
			connection(),
			scope,
			request({ fileName: '.env.production', allowTracked: true })
		);
		expect(allowed.status).toBe('written');
	});

	it('creates the file when the project has none', async () => {
		const applied = await dbClientEnv.apply(connection(), scope, request());

		expect(applied.status).toBe('written');
		expect(await fs.readFile(path.join(root, '.env'), 'utf-8')).toContain('DATABASE_URL=');
	});

	it('keeps two connections in one plain file', async () => {
		// A project with a Postgres and a Redis connection is ordinary, and the
		// file has to stay one a human would have written: no markers at all, and
		// applying the second must not disturb the first.
		const cache = connection({
			id: 'conn-redis',
			name: 'Cache',
			driver: 'redis',
			database: '0',
			port: 6379
		});
		const cacheRequest = {
			connectionId: 'conn-redis',
			shape: 'url',
			prefix: 'REDIS',
			fileName: '.env'
		} as Parameters<typeof dbClientEnv.plan>[2];

		await dbClientEnv.apply(connection(), scope, request());
		await dbClientEnv.apply(cache, scope, cacheRequest);

		const contents = await fs.readFile(path.join(root, '.env'), 'utf-8');
		expect(contents).toContain('DATABASE_URL=');
		expect(contents).toContain('REDIS_URL=');
		// Nothing announcing itself. What a dotenv file should look like after
		// this feature runs is a dotenv file with the variables in it.
		expect(contents).not.toContain('clopen:db-client');
		expect(contents).not.toContain('>>>');

		// Undoing one leaves the other, which is the whole reason removal is
		// per-key rather than per-block.
		await dbClientEnv.remove(cache, scope, cacheRequest);
		const after = await fs.readFile(path.join(root, '.env'), 'utf-8');
		expect(after).toContain('DATABASE_URL=');
		expect(after).not.toContain('REDIS_URL=');
	});

	it('reports a block that already says exactly this as unchanged', async () => {
		// The panel shows "Undo write" off this, so an apply that wrote nothing
		// must not look like one that did.
		await dbClientEnv.apply(connection(), scope, request());
		const plan = await dbClientEnv.plan(connection(), scope, request());

		expect(plan.unchanged).toEqual(['DATABASE_URL']);
		expect(plan.appended).toEqual([]);
		expect(plan.diff).toEqual([]);
	});
});

describe('diffLines', () => {
	it('marks what went and what arrived', () => {
		expect(diffLines('A=1\nB=2', 'A=1\nB=3')).toEqual([
			{ kind: 'context', text: 'A=1' },
			{ kind: 'removed', text: 'B=2' },
			{ kind: 'added', text: 'B=3' }
		]);
	});

	it('collapses a long unchanged run instead of dropping it silently', () => {
		const before = Array.from({ length: 20 }, (_, i) => `K${i}=1`).join('\n');
		const after = `${before}\nNEW=1`;

		const diff = diffLines(before, after);
		expect(diff.filter((line) => line.text === '…')).toHaveLength(1);
		expect(diff.at(-1)).toEqual({ kind: 'added', text: 'NEW=1' });
	});

	it('handles a file that did not exist, without a phantom blank line', () => {
		expect(diffLines('', 'A=1\n')).toEqual([{ kind: 'added', text: 'A=1' }]);
	});

	it('answers empty when nothing changed', () => {
		// An ellipsis standing in for the whole file reads as "something is
		// hidden here"; the honest rendering of no change is no diff.
		expect(diffLines('A=1\nB=2\n', 'A=1\nB=2\n')).toEqual([]);
	});
});
