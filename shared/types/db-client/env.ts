/**
 * db-client — the connection as environment variables.
 *
 * A database is only useful to the project sitting next to it, and the step
 * between "Clopen can reach this" and "my app can reach this" was a user
 * retyping a host, a port, a password and an SSL mode into a dotenv file. This
 * is the vocabulary for closing that gap: what the variables are called, which
 * file they belong in, and what changing that file would do.
 *
 * The naming is the hard part, and it is NOT guessed. Projects split a database
 * across `DB_HOST`/`DB_PASSWORD`, fold it into one `DATABASE_URL`, or call the
 * same thing `POSTGRES_URL` because Vercel does — so the project's own files
 * are read first and what they already use is what gets offered. A preset is
 * the fallback for a project that has nothing yet, not the default answer.
 *
 * VALUES CROSS THIS LINE, unlike every other db-client type. A connection
 * string the user cannot copy is a connection string that solves nothing, so
 * the routes behind these shapes are access-gated instead — see
 * `backend/ws/db-client/env.ts`.
 */

import type { DbDriver } from './connection';

/** One variable holding everything, or one variable per field. */
export type DbEnvShape = 'url' | 'split';

/**
 * What one variable HOLDS, independent of what it is called.
 *
 * The naming picker offers shapes and nothing else. An earlier version offered
 * frameworks — Laravel, Prisma, libpq, Vercel — which was a list of guesses
 * about projects it had already read: the real answer to "what are these
 * called here" comes from `DbEnvExistingGroup`, which carries the project's own
 * key names. A framework in a dropdown is that answer asserted instead.
 */
export type DbEnvRole =
	| 'url'
	| 'altUrl'
	| 'host'
	| 'port'
	| 'user'
	| 'password'
	| 'database'
	| 'sslMode';

/** One of the two shapes, as the picker renders it. */
export interface DbEnvShapeInfo {
	id: DbEnvShape;
	label: string;
	description: string;
	/** The keys it writes, with the current prefix, for the picker to show. */
	sampleKeys: string[];
}

export interface DbEnvVar {
	key: string;
	value: string;
	/** True when the value carries a credential, so the panel masks it. */
	isSecret: boolean;
	/** One short clause, when the variable needs explaining. */
	note?: string | null;
}

export interface DbEnvFileInfo {
	name: string;
	/** Read for its shape, never written — `.env.example` and friends. */
	isTemplate: boolean;
	/** git tracks it, so writing a password into it would commit one. */
	isTracked: boolean;
	/** Lower wins: `.env.local` beats `.env` in Next.js and Vite. */
	precedence: number;
}

/**
 * A naming convention the project is ALREADY using.
 *
 * The whole reason detection exists: offering to update `POSTGRES_URL` where
 * the project has one beats adding a `DATABASE_URL` nothing reads.
 */
export interface DbEnvExistingGroup {
	prefix: string;
	shape: DbEnvShape;
	keys: string[];
	/**
	 * Which of this group's keys holds what.
	 *
	 * The whole point of detection, and what replaced the framework presets: a
	 * project with `DB_USERNAME` gets `DB_USERNAME` written, not a `DB_USER`
	 * beside it that nothing reads.
	 */
	keyMap: Partial<Record<DbEnvRole, string>>;
	/** Which files carry these keys, most-precedent first. */
	files: string[];
	/** True when every occurrence is commented out — a template's documentation. */
	isTemplateOnly: boolean;
	/** How the row reads: "DATABASE_URL · .env.local". */
	label: string;
}

export interface DbEnvDetection {
	/** Null when no project is in scope; the panel then only offers copying. */
	projectId: string | null;
	projectName: string | null;
	files: DbEnvFileInfo[];
	/** What the project already uses, best first. Empty for a fresh project. */
	existing: DbEnvExistingGroup[];
	/** Where the names came from, for the sentence the panel shows. */
	sources: string[];
}

/** Everything the panel needs to open. */
export interface DbEnvState {
	connectionId: string;
	connectionName: string;
	driver: DbDriver;
	/** The database in scope, when the panel was opened inside one. */
	database: string | null;
	shapes: DbEnvShapeInfo[];
	detection: DbEnvDetection;
	/** The shape, names and file the panel opens on. */
	suggestion: {
		shape: DbEnvShape;
		prefix: string;
		fileName: string | null;
		/** The project's own names, when detection found a group to follow. */
		keyMap: Partial<Record<DbEnvRole, string>> | null;
	};
	/** True when the provider can also hand back a direct/unpooled counterpart. */
	hasAlternate: boolean;
	/** What the counterpart is called where it exists — "Direct (unpooled)". */
	alternateLabel: string | null;
	/** Sentences shown above the variables: tunnels, localhost, derived rows. */
	warnings: string[];
}

export type DbEnvDiffKind = 'context' | 'added' | 'removed';

export interface DbEnvDiffLine {
	kind: DbEnvDiffKind;
	text: string;
}

/** What applying would do, worked out without touching the file. */
export interface DbEnvPlan {
	vars: DbEnvVar[];
	/** The rendered fragment, ready to paste. */
	text: string;
	fileName: string | null;
	fileExists: boolean;
	/** git tracks the target, so applying needs an explicit override. */
	fileTracked: boolean;
	/** Keys replaced where the project already had them. */
	updated: string[];
	/** Keys the project lacks, bound for the managed block. */
	appended: string[];
	/** Keys already holding exactly this value. */
	unchanged: string[];
	diff: DbEnvDiffLine[];
	warnings: string[];
}

export interface DbEnvApplyResult {
	status: 'written' | 'unchanged' | 'skipped-tracked' | 'failed';
	/** One sentence, naming what happened and what to do. Null when it worked. */
	detail: string | null;
	fileName: string;
	updated: string[];
	appended: string[];
}

/** What the panel sends for a preview, an apply, or an undo. */
export interface DbEnvRequest {
	connectionId: string;
	projectId?: string;
	/**
	 * The database in scope.
	 *
	 * A connection with no database of its own browses one, and it is THAT one
	 * the project needs a URL for — the connection's own empty field would
	 * produce a string pointing at the server and no database.
	 */
	database?: string;
	shape: DbEnvShape;
	prefix: string;
	/** Exact names to use, overriding what the prefix would produce. */
	keyMap?: Partial<Record<DbEnvRole, string>>;
	fileName?: string;
	/** Include the provider's direct/unpooled counterpart where one exists. */
	includeAlternate?: boolean;
	/** Write even though git tracks the file. The user has to have confirmed. */
	allowTracked?: boolean;
}
