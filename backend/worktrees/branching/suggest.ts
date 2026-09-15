/**
 * Working out, unprompted, which database a project's worktrees should copy.
 *
 * This is what turns the feature from "configure it first" into "tick the box".
 * A project that uses a database already says so in its `.env`, and Clopen
 * already has a connection list — so the binding a user would otherwise build
 * by hand, from a picker of servers and a picker of databases, is derivable
 * from two things already on disk.
 *
 * MATCHED, NEVER INVENTED. A URL that corresponds to no saved connection
 * produces no suggestion: Clopen would have the address but not the password,
 * and offering to copy a database it cannot open would be an offer that fails
 * at the moment of use. The user adds the connection in DB Client once, and the
 * suggestion appears by itself afterwards.
 */

import path from 'path';
import fs from 'fs/promises';
import { dbClientConnectionQueries } from '$backend/database/queries';
import { listEnvFileEntries, parseDotenv } from '$backend/env-files';
import { DEFAULT_PORTS } from '$backend/db-client/connection-url';
import { canBranchFrom, cloneSupport } from '$backend/db-client/cloning';
import type { DbClientConnection, DbDriver } from '$shared/types/db-client';
import type { BranchSuggestion } from '$shared/types/worktree-branching';
import { debug } from '$shared/utils/logger';

export type { BranchSuggestion };

const DRIVER_NAMES: Record<DbDriver, string> = {
	postgres: 'PostgreSQL',
	mysql: 'MySQL',
	sqlite: 'SQLite',
	mongodb: 'MongoDB',
	redis: 'Redis',
	mssql: 'SQL Server'
};

/** Which driver a URL scheme belongs to. */
const DRIVER_OF_SCHEME: Record<string, DbDriver> = {
	postgres: 'postgres',
	postgresql: 'postgres',
	mysql: 'mysql',
	mysql2: 'mysql',
	mongodb: 'mongodb',
	'mongodb+srv': 'mongodb',
	redis: 'redis',
	rediss: 'redis',
	mssql: 'mssql',
	sqlserver: 'mssql',
	sqlite: 'sqlite',
	file: 'sqlite'
};

interface ParsedUrl {
	driver: DbDriver;
	host: string;
	port: number | null;
	database: string;
}

/**
 * A connection URL, reduced to the four things matching needs.
 *
 * Deliberately not `new URL()` alone: SQLite's `file:./dev.db` has no host and
 * no authority, and Mongo's `mongodb+srv://` has no port. Both are ordinary
 * here, so each is handled rather than dropped.
 */
function parseUrl(raw: string): ParsedUrl | null {
	const match = /^([a-z][a-z0-9+.-]*):/i.exec(raw.trim());
	if (!match) return null;
	const driver = DRIVER_OF_SCHEME[match[1].toLowerCase()];
	if (!driver) return null;

	if (driver === 'sqlite') {
		const file = raw.trim().replace(/^[a-z][a-z0-9+.-]*:(\/\/)?/i, '');
		return file ? { driver, host: '', port: null, database: file } : null;
	}

	try {
		const url = new URL(raw.trim());
		return {
			driver,
			host: url.hostname,
			port: url.port ? Number(url.port) : null,
			database: decodeURIComponent(url.pathname.replace(/^\//, ''))
		};
	} catch {
		return null;
	}
}

/** `localhost` and `127.0.0.1` are the same machine and must match each other. */
function normalizeHost(host: string): string {
	const lower = host.toLowerCase();
	if (lower === '127.0.0.1' || lower === '::1' || lower === '0.0.0.0') return 'localhost';
	return lower;
}

function portOf(driver: DbDriver, port: number | null): number | null {
	return port ?? DEFAULT_PORTS[driver];
}

/**
 * The saved connection this URL is pointing at, if Clopen has one.
 *
 * The DATABASE is not part of the match. A project's `.env` names one database
 * on a server, and the connection in DB Client may have been saved against
 * another on the same server — they are still the same credential, and the
 * database is what the suggestion then proposes to copy.
 */
function matchConnection(parsed: ParsedUrl): DbClientConnection | null {
	for (const connection of dbClientConnectionQueries.list()) {
		if (connection.driver !== parsed.driver) continue;
		if (!canBranchFrom(connection)) continue;
		if (connection.options?.worktreeBranch) continue;

		if (parsed.driver === 'sqlite') {
			if (path.resolve(connection.database ?? '') === path.resolve(parsed.database)) {
				return connection;
			}
			continue;
		}

		if (normalizeHost(connection.host ?? '') !== normalizeHost(parsed.host)) continue;
		if (portOf(parsed.driver, connection.port) !== portOf(parsed.driver, parsed.port)) continue;
		return connection;
	}
	return null;
}

/**
 * What this project's worktrees should copy, or null.
 *
 * The files are read most-precedent first and the first usable answer wins, so
 * a `DATABASE_URL` in `.env.local` beats the one in `.env` — the same order the
 * project's own framework reads them in, which is the only order that can be
 * right.
 *
 * Templates are read too. `.env.example` names the variable without a live
 * value, so it cannot be matched to a connection — but it is where the VARIABLE
 * NAME comes from on a fresh clone, and that is half of what the binding needs.
 */
export async function suggestBranchSource(root: string): Promise<BranchSuggestion | null> {
	let files;
	try {
		files = await listEnvFileEntries(root);
	} catch {
		return null;
	}

	for (const file of files) {
		if (file.isTemplate) continue;

		let content: string;
		try {
			content = await fs.readFile(path.join(root, file.name), 'utf-8');
		} catch {
			continue;
		}

		for (const assignment of parseDotenv(content)) {
			if (assignment.commented || !assignment.value) continue;

			const parsed = parseUrl(assignment.value);
			if (!parsed) continue;

			// SQLite's path is relative to the project, not to Clopen's cwd.
			if (parsed.driver === 'sqlite' && !path.isAbsolute(parsed.database)) {
				parsed.database = path.resolve(root, parsed.database);
			}

			const connection = matchConnection(parsed);
			if (!connection) {
				debug.log(
					'worktree',
					`${assignment.key} in ${file.name} names a database Clopen has no connection for`
				);
				continue;
			}

			const parentRef =
				parsed.driver === 'sqlite'
					? parsed.database
					: parsed.database || connection.database || '';
			if (!parentRef) continue;

			return {
				sourceKind: 'connection',
				sourceId: connection.id,
				sourceLabel: connection.name,
				providerName: DRIVER_NAMES[connection.driver],
				parentRef,
				parentName: parsed.driver === 'sqlite' ? path.basename(parentRef) : parentRef,
				envVar: assignment.key,
				envFile: file.name,
				notice: cloneSupport(connection.driver).notice
			};
		}
	}

	return null;
}
