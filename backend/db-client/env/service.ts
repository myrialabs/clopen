/**
 * The connection as environment variables — detect, preview, apply, undo.
 *
 * What this closes: DB Client could reach a database that the project sitting
 * next to it could not, and the step between the two was a user retyping a
 * host, a port, a password and an SSL mode into a dotenv file whose name and
 * whose variable names both varied by framework.
 *
 * Three rules hold the whole thing together.
 *
 * **The project's names win.** `detect.ts` reads what the project already uses
 * and that is what is offered; a preset is what a project with nothing in it
 * gets asked. Nothing is guessed while the answer is on disk.
 *
 * **Nothing is written that was not previewed.** `plan()` and `apply()` share
 * one `planEnvWrite`, so the diff the user approved is the write that happens.
 *
 * **A tracked file is refused.** Writing a live password into a file git tracks
 * commits one, so it takes an explicit override — and the override exists
 * because this is the user's own project and their own database, unlike the
 * automatic write worktree branching does.
 */

import {
	integrationAccountQueries,
	integrationDbLinkQueries
} from '$backend/database/queries';
import {
	clearEnvVars,
	formatEnvLine,
	isSafeEnvFileName,
	isValidEnvKey,
	planEnvWrite,
	writeEnvVars
} from '$backend/env-files';
import type {
	DbClientConnection,
	DbEnvApplyResult,
	DbEnvDetection,
	DbEnvPlan,
	DbEnvRequest,
	DbEnvShape,
	DbEnvState,
	DbEnvVar
} from '$shared/types/db-client';
import { buildConnectionUrl } from '../connection-url';
import { dbLinks } from '../integrations/links';
import { getDbProvider } from '../providers/registry';
import type { DbProviderEnvHints } from '../providers/types';
import { detectEnvUsage } from './detect';
import { diffLines } from './diff';
import { defaultPrefixFor, renderEnvVars, shapeInfos, type EnvNaming } from './naming';
import { debug } from '$shared/utils/logger';

/** The project a write would land in. Null when none is in scope. */
export interface EnvScope {
	projectId: string;
	projectName: string;
	root: string;
}

const EMPTY_DETECTION: DbEnvDetection = {
	projectId: null,
	projectName: null,
	files: [],
	existing: [],
	sources: []
};

/** The provider behind a derived connection, and what its docs call things. */
function providerFor(connectionId: string): {
	hints: DbProviderEnvHints | null;
	mode: string | null;
	remoteRef: string | null;
	accountId: string | null;
	provider: string | null;
	modeLabels: Map<string, string>;
} {
	const linked = dbLinks.linkForConnection(connectionId);
	if (!linked) {
		return { hints: null, mode: null, remoteRef: null, accountId: null, provider: null, modeLabels: new Map() };
	}

	const adapter = getDbProvider(linked.account.provider);
	return {
		hints: adapter?.envHints?.() ?? null,
		mode: linked.link.mode,
		remoteRef: linked.link.remote_ref,
		accountId: linked.account.id,
		provider: linked.account.provider,
		modeLabels: new Map((adapter?.info().modes ?? []).map((entry) => [entry.id, entry.label]))
	};
}

/**
 * Whether a second, non-pooled URL is worth offering.
 *
 * False when the connection is ALREADY on the direct endpoint, because a
 * `DIRECT_URL` equal to `DATABASE_URL` looks like configuration and changes
 * nothing — which is worse than not offering it.
 */
function alternateAvailable(info: ReturnType<typeof providerFor>): boolean {
	const { hints, mode } = info;
	if (!hints?.directMode || !mode) return false;
	return (hints.pooledModes ?? []).includes(mode);
}

/**
 * Ask the provider where its direct endpoint answers.
 *
 * Fail-soft: a provider outage costs the second variable and nothing else, and
 * the caller reports the reason alongside the URL it did get. Throwing here
 * would lose a preview the user can act on over a variable they may not need.
 */
async function resolveAlternateUrl(
	connection: DbClientConnection,
	info: ReturnType<typeof providerFor>
): Promise<{ url: string | null; error: string | null }> {
	if (!info.accountId || !info.provider || !info.remoteRef || !info.hints?.directMode) {
		return { url: null, error: null };
	}

	const account = integrationAccountQueries.getById(info.accountId);
	const adapter = getDbProvider(info.provider);
	if (!account || !adapter) return { url: null, error: null };

	try {
		const { secrets, ...endpoint } = await adapter.resolveEndpoint(
			{ accountId: account.id, credentials: integrationAccountQueries.credentialsOf(account) },
			{ remoteRef: info.remoteRef, mode: info.hints.directMode }
		);

		const linked = dbLinks.linkForConnection(connection.id);
		// Three places a password can come from, most authoritative first: the one
		// the provider just handed back, the one stored on the link, and the one
		// on the row. They agree in the ordinary case; when they do not, the fresh
		// one is the one that works.
		const password =
			secrets?.password ??
			(linked ? integrationDbLinkQueries.secretsOf(linked.link).password : null) ??
			connection.password;

		return {
			url: buildConnectionUrl({
				...connection,
				host: endpoint.host,
				port: endpoint.port,
				username: endpoint.username,
				database: endpoint.database,
				sslMode: endpoint.sslMode,
				password: password ?? null
			}),
			error: null
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		debug.warn('db-client', `Could not resolve the direct endpoint for ${connection.id}: ${message}`);
		return { url: null, error: message };
	}
}

/** One sentence each, in the order a reader needs them. */
function warningsFor(input: {
	connection: DbClientConnection;
	info: ReturnType<typeof providerFor>;
	includesAlternate: boolean;
	alternateError: string | null;
}): string[] {
	const { connection, info } = input;
	const warnings: string[] = [];

	if (connection.ssh?.enabled) {
		warnings.push(
			'Clopen reaches this database through an SSH tunnel it opens itself, so your app needs its own tunnel before this URL will connect.'
		);
	}

	const host = (connection.host ?? '').toLowerCase();
	if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
		warnings.push(
			'The host is localhost, so anything running in a container needs a host name that resolves from inside it.'
		);
	}

	if (connection.driver === 'sqlite') {
		warnings.push('SQLite has no endpoint, so the variable holds the path to the database file.');
	}

	const managed = dbLinks.managedBy(connection.id);
	if (managed) {
		warnings.push(
			`This connection is derived from the ${managed.providerName} account, so refreshing the link can change these values.`
		);
	}

	if (input.includesAlternate && info.hints?.directNotice) {
		warnings.push(info.hints.directNotice);
	}

	if (input.alternateError) {
		warnings.push(
			`Could not reach the provider for the direct endpoint, so only the pooled URL is shown — ${input.alternateError}`
		);
	}

	return warnings;
}

/** Uppercase, underscore-safe, and refused rather than mangled. */
function normalizePrefix(raw: string, fallback: string): string {
	const trimmed = (raw ?? '').trim().toUpperCase().replace(/_+$/, '');
	if (!trimmed) return fallback;
	if (!isValidEnvKey(trimmed)) {
		throw new Error(`"${raw}" is not a valid variable prefix — use letters, digits and underscores.`);
	}
	return trimmed;
}

/** The file a write should land in, given what detection found. */
function suggestFileName(detection: DbEnvDetection, preferred: string[]): string | null {
	const writable = detection.files.filter((file) => !file.isTemplate);

	for (const name of preferred) {
		if (writable.some((file) => file.name === name)) return name;
	}
	// `files` is already ordered most-precedent first, so the first writable
	// entry is the one a framework would actually read.
	if (writable.length > 0) return writable[0].name;
	// Nothing exists yet. `.env` is the one name every loader reads, and a file
	// that does not exist cannot be tracked, so creating it is safe.
	return detection.projectId ? '.env' : null;
}

/** The connection as the project should reach it, with the browsed database. */
function targetOf(connection: DbClientConnection, database?: string): DbClientConnection {
	const named = (database ?? '').trim();
	if (!named || named === connection.database) return connection;
	// A connection with no database of its own browses one, and it is THAT one
	// the project needs. Using the connection's empty field would write a string
	// pointing at the server with no database on the end of it.
	return { ...connection, database: named };
}

function namingFor(
	connection: DbClientConnection,
	info: ReturnType<typeof providerFor>,
	input: { shape: DbEnvShape; prefix?: string; keyMap?: DbEnvRequest['keyMap'] }
): EnvNaming {
	return {
		shape: input.shape,
		prefix: normalizePrefix(
			input.prefix ?? '',
			defaultPrefixFor(connection.driver, input.shape)
		),
		keyMap: input.keyMap,
		altSuffix: info.hints?.altKeySuffix
	};
}

export const dbClientEnv = {
	/** Everything the panel needs to open on the right names and file. */
	async state(
		connection: DbClientConnection,
		scope: EnvScope | null,
		database?: string
	): Promise<DbEnvState> {
		const target = targetOf(connection, database);
		const info = providerFor(connection.id);
		const hasAlternate = alternateAvailable(info);

		const detection = scope
			? await detectEnvUsage({
				root: scope.root,
				projectId: scope.projectId,
				projectName: scope.projectName,
				driver: target.driver
			})
			: EMPTY_DETECTION;

		// Whatever the project already uses wins outright — that is the answer
		// this feature exists to find, and a shape picked over it would be a
		// guess standing in front of a fact.
		const best = detection.existing[0] ?? null;
		const shape: DbEnvShape = best?.shape ?? 'url';
		const prefix =
			best?.prefix ??
			info.hints?.urlPrefix ??
			defaultPrefixFor(target.driver, shape);

		// The file the detected group actually lives in, so an apply updates the
		// copy that wins at runtime rather than adding a second one elsewhere.
		const fileName = suggestFileName(detection, best?.files ?? []);
		const naming = namingFor(target, info, { shape, prefix, keyMap: best?.keyMap });

		return {
			connectionId: connection.id,
			connectionName: connection.name,
			driver: target.driver,
			database: target.database,
			shapes: shapeInfos({
				connection: target,
				naming,
				url: buildConnectionUrl(target),
				hasAlternate
			}),
			detection,
			suggestion: {
				shape,
				prefix: naming.prefix,
				fileName,
				keyMap: best?.keyMap ?? null
			},
			hasAlternate,
			alternateLabel: hasAlternate
				? (info.modeLabels.get(info.hints?.directMode ?? '') ?? 'Direct')
				: null,
			warnings: warningsFor({
				connection: target,
				info,
				includesAlternate: false,
				alternateError: null
			})
		};
	},

	/** What applying would do, without touching the file. */
	async plan(
		connection: DbClientConnection,
		scope: EnvScope | null,
		request: DbEnvRequest
	): Promise<DbEnvPlan> {
		if (request.shape !== 'url' && request.shape !== 'split') {
			throw new Error(`"${request.shape}" is not a shape DB Client can write.`);
		}

		const target = targetOf(connection, request.database);
		const info = providerFor(connection.id);
		const naming = namingFor(target, info, request);

		const wantsAlternate = Boolean(request.includeAlternate) && alternateAvailable(info);
		const alternate = wantsAlternate
			? await resolveAlternateUrl(target, info)
			: { url: null, error: null };

		const vars = renderEnvVars({
			connection: target,
			naming,
			url: buildConnectionUrl(target),
			alternateUrl: alternate.url
		});
		if (vars.length === 0) {
			throw new Error('This connection has nothing to write — give it a host and a database first.');
		}
		for (const entry of vars) {
			if (!isValidEnvKey(entry.key)) {
				throw new Error(`"${entry.key}" is not a valid environment variable name.`);
			}
		}

		const text = `${vars.map((entry) => formatEnvLine(entry.key, entry.value)).join('\n')}\n`;
		const warnings = warningsFor({
			connection: target,
			info,
			includesAlternate: Boolean(alternate.url),
			alternateError: alternate.error
		});

		const fileName = (request.fileName ?? '').trim();
		if (!scope || !fileName) {
			return {
				vars,
				text,
				fileName: null,
				fileExists: false,
				fileTracked: false,
				updated: [],
				appended: [],
				unchanged: [],
				diff: [],
				warnings
			};
		}
		if (!isSafeEnvFileName(fileName)) {
			throw new Error(`"${fileName}" is not a dotenv file in the project root.`);
		}

		const plan = await planEnvWrite({
			root: scope.root,
			fileName,
			vars: varsToRecord(vars)
		});

		return {
			vars,
			text,
			fileName,
			fileExists: plan.exists,
			fileTracked: plan.tracked,
			updated: plan.updated,
			appended: plan.appended,
			unchanged: plan.unchanged,
			diff: diffLines(plan.current, plan.next),
			warnings
		};
	},

	/** Write it. The plan the panel showed is the plan that runs. */
	async apply(
		connection: DbClientConnection,
		scope: EnvScope,
		request: DbEnvRequest
	): Promise<DbEnvApplyResult> {
		const plan = await this.plan(connection, scope, request);
		if (!plan.fileName) {
			throw new Error('Pick a dotenv file before applying.');
		}

		const result = await writeEnvVars({
			root: scope.root,
			fileName: plan.fileName,
			vars: varsToRecord(plan.vars),
			allowTracked: request.allowTracked
		});

		return {
			status: result.status,
			detail: result.detail,
			fileName: result.fileName,
			updated: result.updated,
			appended: result.appended
		};
	},

	/**
	 * Take it back out.
	 *
	 * Rendered again rather than remembered, so an undo removes exactly what the
	 * matching apply wrote. A value replaced in place is restored from the
	 * comment left beside it; a key that was appended is removed ONLY while it
	 * still holds what was written, so a value the user has edited since is
	 * theirs and stays.
	 */
	async remove(
		connection: DbClientConnection,
		scope: EnvScope,
		request: DbEnvRequest
	): Promise<DbEnvApplyResult> {
		const fileName = (request.fileName ?? '').trim();
		if (!fileName || !isSafeEnvFileName(fileName)) {
			throw new Error(`"${fileName}" is not a dotenv file in the project root.`);
		}

		const target = targetOf(connection, request.database);
		const info = providerFor(connection.id);
		const alternate = alternateAvailable(info)
			? await resolveAlternateUrl(target, info).then((result) => result.url)
			: null;

		const vars = renderEnvVars({
			connection: target,
			naming: namingFor(target, info, request),
			url: buildConnectionUrl(target),
			alternateUrl: alternate
		});

		const { changed } = await clearEnvVars({
			root: scope.root,
			fileName,
			keys: vars.map((entry) => entry.key),
			values: varsToRecord(vars)
		});

		return {
			status: changed ? 'written' : 'unchanged',
			detail: null,
			fileName,
			updated: [],
			appended: []
		};
	}
};

function varsToRecord(vars: DbEnvVar[]): Record<string, string> {
	const record: Record<string, string> = {};
	for (const entry of vars) record[entry.key] = entry.value;
	return record;
}
