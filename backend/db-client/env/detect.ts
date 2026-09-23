/**
 * Reading a project's own naming convention instead of guessing one.
 *
 * This is the part that answers the actual complaint: some projects fold a
 * database into `DATABASE_URL`, some split it across `DB_HOST`/`DB_PASSWORD`,
 * some call it `POSTGRES_URL` because Vercel does, and a tool that picks one
 * writes a variable nothing reads. So the files the project already has are
 * read first, and what they already use is what gets offered — the preset list
 * is for a project with nothing in it.
 *
 * THREE SOURCES, in descending authority:
 *
 *  1. The dotenv files a project LOADS. What is there is what is true.
 *  2. `.env.example` and friends. Usually the only record of the names a
 *     project expects, and the reason `parseDotenv` keeps commented
 *     assignments: half those files document optional settings as `# REDIS_URL=`.
 *     Read, never written — writing a live password into a committed file is
 *     the opposite of the point.
 *  3. `prisma/schema.prisma` and `drizzle.config.*`, which name the variable
 *     they read even when no dotenv file exists yet. A fresh clone with a
 *     schema and no `.env` is the common case, and it is the one where guessing
 *     would be worst.
 *
 * Nothing here is authoritative about the DATABASE — only about what the
 * project calls one. A group whose keys all sit in a template is marked as
 * such, because updating documentation is not the same as configuring an app.
 */

import fs from 'fs/promises';
import path from 'path';
import {
	envFilePrecedence,
	isTrackedInGit,
	listEnvFileEntries,
	parseDotenv
} from '$backend/env-files';
import type {
	DbDriver,
	DbEnvDetection,
	DbEnvExistingGroup,
	DbEnvFileInfo,
	DbEnvRole,
	DbEnvShape
} from '$shared/types/db-client';
import { debug } from '$shared/utils/logger';

/** A value that is unmistakably a database connection string. */
const URL_VALUE = /^(postgres(ql)?|mysql2?|mongodb(\+srv)?|rediss?|mssql|sqlserver|libsql|sqlite|file):/i;

/** libpq reads these six on its own, with no prefix to speak of. */
const LIBPQ_KEY = /^PG(HOST|PORT|USER|PASSWORD|DATABASE|SSLMODE)$/;

/** The field names a split convention uses. */
const SPLIT_ROLE =
	/^(.+?)_(HOST|PORT|USER|USERNAME|PASSWORD|PASS|NAME|DATABASE|DB|SSLMODE|SSL_MODE|SCHEMA|CONNECTION)$/;

/** Names for a second endpoint of the SAME database, not a second database. */
const ALTERNATE_SUFFIXES = ['_URL_UNPOOLED', '_URL_NON_POOLING', '_PRISMA_URL', '_URL_NO_SSL'];

/**
 * A database Clopen must never offer to overwrite.
 *
 * Prisma's shadow database is a SEPARATE, disposable database it creates
 * migrations against. Pointing it at the real one would let a migration diff
 * run against production data.
 */
const DENY_KEYS = new Set(['SHADOW_DATABASE_URL']);

/** Prefix words that mean "this is about a database". */
const DB_WORDS = new Set([
	'DB',
	'DATABASE',
	'POSTGRES',
	'POSTGRESQL',
	'PG',
	'MYSQL',
	'MARIADB',
	'MONGO',
	'MONGODB',
	'REDIS',
	'MSSQL',
	'SQLSERVER',
	'SQL',
	'SQLITE',
	'TURSO',
	'NEON',
	'SUPABASE',
	'PLANETSCALE'
]);

/** Config files that name the variable they read. */
const CODE_SOURCES = [
	'prisma/schema.prisma',
	'drizzle.config.ts',
	'drizzle.config.mts',
	'drizzle.config.js',
	'drizzle.config.mjs',
	'drizzle.config.cjs'
];

function looksLikeDatabase(prefix: string): boolean {
	if (DB_WORDS.has(prefix)) return true;
	const last = prefix.split('_').pop() ?? '';
	return DB_WORDS.has(last);
}

/**
 * Which field a split convention's word names.
 *
 * `CONNECTION` and `SCHEMA` map to nothing on purpose. Laravel's
 * `DB_CONNECTION=pgsql` names the DRIVER, and a project that has it already has
 * it right — rewriting it would be changing something the user did not ask
 * about to a value that cannot differ.
 */
const ROLE_OF_WORD: Record<string, DbEnvRole | null> = {
	HOST: 'host',
	PORT: 'port',
	USER: 'user',
	USERNAME: 'user',
	PASSWORD: 'password',
	PASS: 'password',
	NAME: 'database',
	DATABASE: 'database',
	DB: 'database',
	SSLMODE: 'sslMode',
	SSL_MODE: 'sslMode',
	CONNECTION: null,
	SCHEMA: null
};

interface Classification {
	prefix: string;
	shape: DbEnvShape;
	/** True when the NAME alone says this is a database. */
	strong: boolean;
	/** The field this key holds. */
	role: DbEnvRole | null;
	/** The word the split key ended in, for deciding whether a group is real. */
	word: string | null;
}

function classify(key: string, value: string): Classification | null {
	const upper = key.toUpperCase();
	if (DENY_KEYS.has(upper)) return null;

	if (LIBPQ_KEY.test(upper)) {
		const word = upper.slice(2);
		return {
			prefix: 'PG',
			shape: 'split',
			strong: true,
			role: ROLE_OF_WORD[word] ?? null,
			word
		};
	}

	// Prisma's direct endpoint belongs to the DATABASE_URL beside it; on its own
	// it would show up as a group called "DIRECT", which is not a thing.
	if (upper === 'DIRECT_URL') {
		return { prefix: 'DATABASE', shape: 'url', strong: true, role: 'altUrl', word: null };
	}

	for (const suffix of ALTERNATE_SUFFIXES) {
		if (upper.endsWith(suffix) && upper.length > suffix.length) {
			return {
				prefix: upper.slice(0, -suffix.length),
				shape: 'url',
				strong: true,
				role: 'altUrl',
				word: null
			};
		}
	}

	const urlMatch = /^(.*?)(_URL|_URI|_DSN)$/.exec(upper);
	if (urlMatch) {
		const prefix = urlMatch[1] || upper;
		const strong = looksLikeDatabase(prefix);
		// A name that says nothing is accepted only when the VALUE does. That is
		// what catches `MY_STORE_URL=postgres://…` without also catching
		// `NEXT_PUBLIC_API_URL`.
		if (!strong && !URL_VALUE.test(value)) return null;
		return { prefix, shape: 'url', strong, role: 'url', word: null };
	}

	const splitMatch = SPLIT_ROLE.exec(upper);
	if (splitMatch) {
		const word = splitMatch[2];
		return {
			prefix: splitMatch[1],
			shape: 'split',
			strong: looksLikeDatabase(splitMatch[1]),
			role: ROLE_OF_WORD[word] ?? null,
			word
		};
	}

	return null;
}

interface Draft {
	prefix: string;
	shape: DbEnvShape;
	keys: Map<string, { commented: boolean }>;
	/** role → the key this project actually uses for it. */
	keyMap: Partial<Record<DbEnvRole, string>>;
	roles: Set<string>;
	files: string[];
	/** Files where at least one of these keys is live rather than commented. */
	liveFiles: string[];
	sources: Set<string>;
	strong: boolean;
}

/**
 * A split group is only real when its name says so, or when it has enough
 * fields that nothing else explains it.
 *
 * Without the second half, `NEXT_PUBLIC_SITE_NAME` and `SMTP_HOST` would each
 * become a one-key "database". With it, a project using `STORE_HOST`,
 * `STORE_USER` and `STORE_PASSWORD` is still recognised.
 */
function isRealSplitGroup(draft: Draft): boolean {
	if (draft.strong) return true;
	const hasEndpoint = draft.roles.has('HOST') || draft.roles.has('DATABASE') || draft.roles.has('NAME');
	return hasEndpoint && draft.roles.size >= 3;
}

async function readIfPresent(root: string, relative: string): Promise<string | null> {
	try {
		return await fs.readFile(path.join(root, relative), 'utf-8');
	} catch {
		return null;
	}
}

/** Variable names a config file reads, with no value to go on. */
function keysReferencedIn(relative: string, content: string): string[] {
	const found = new Set<string>();

	if (relative.endsWith('.prisma')) {
		for (const match of content.matchAll(/env\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)/g)) {
			found.add(match[1]);
		}
		return [...found];
	}

	const patterns = [
		/(?:process\.env|Bun\.env|import\.meta\.env)\.([A-Za-z_][A-Za-z0-9_]*)/g,
		/(?:process\.env|Bun\.env|import\.meta\.env)\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g
	];
	for (const pattern of patterns) {
		for (const match of content.matchAll(pattern)) found.add(match[1]);
	}
	return [...found];
}

/** Prefix words that name a specific engine rather than "a database". */
const DRIVER_WORDS: Record<DbDriver, string[]> = {
	postgres: ['POSTGRES', 'POSTGRESQL', 'PG', 'SUPABASE', 'NEON'],
	mysql: ['MYSQL', 'MARIADB'],
	mongodb: ['MONGO', 'MONGODB'],
	redis: ['REDIS'],
	mssql: ['MSSQL', 'SQLSERVER'],
	sqlite: ['SQLITE', 'TURSO']
};

/**
 * Score a group so the panel opens on the right one.
 *
 * A live value outranks everything: a group documented only in `.env.example`
 * describes what the project wants, while a live one describes what it is
 * doing.
 *
 * Then the ENGINE, read off the prefix. A project with both `REDIS_URL` and
 * `POSTGRES_URL` has two groups and only one of them belongs to the connection
 * being written, so naming another engine is a penalty rather than merely not a
 * bonus — without that, a Redis connection opens on the Postgres group and the
 * first thing the user sees is an offer to overwrite it. `DB` and `DATABASE`
 * name no engine and stay neutral, which is correct: they could be either.
 */
function scoreOf(group: DbEnvExistingGroup, driver: DbDriver, bestPrecedence: number): number {
	let score = 0;
	if (!group.isTemplateOnly) score += 100;

	const words = group.prefix.split('_');
	if (words.some((word) => DRIVER_WORDS[driver].includes(word))) score += 30;
	else if (
		Object.entries(DRIVER_WORDS).some(
			([id, list]) => id !== driver && words.some((word) => list.includes(word))
		)
	) {
		score -= 60;
	}

	score += (3 - Math.min(bestPrecedence, 3)) * 5;
	score += Math.min(group.keys.length, 6);
	return score;
}

export async function detectEnvUsage(input: {
	root: string;
	projectId: string | null;
	projectName: string | null;
	driver: DbDriver;
}): Promise<DbEnvDetection> {
	const entries = await listEnvFileEntries(input.root);

	const files: DbEnvFileInfo[] = await Promise.all(
		entries.map(async (entry) => ({
			name: entry.name,
			isTemplate: entry.isTemplate,
			isTracked: await isTrackedInGit(input.root, entry.name),
			precedence: envFilePrecedence(entry.name)
		}))
	);

	const drafts = new Map<string, Draft>();
	const sources = new Set<string>();
	const precedenceOf = new Map<string, number>();

	const remember = (
		key: string,
		value: string,
		options: { file: string | null; commented: boolean; source: string }
	): void => {
		const classification = classify(key, value);
		if (!classification) return;

		const id = `${classification.shape}:${classification.prefix}`;
		const draft: Draft = drafts.get(id) ?? {
			prefix: classification.prefix,
			shape: classification.shape,
			keys: new Map(),
			keyMap: {},
			roles: new Set(),
			files: [],
			liveFiles: [],
			sources: new Set(),
			strong: false
		};

		const upper = key.toUpperCase();
		const seen = draft.keys.get(upper);
		// A key live anywhere is live: `.env` holding a real value outranks the
		// commented copy in `.env.example`.
		draft.keys.set(upper, { commented: (seen?.commented ?? true) && options.commented });
		if (classification.word) draft.roles.add(classification.word);
		// FIRST writer wins, and the files arrive most-precedent first — so a key
		// live in `.env.local` is the name offered even when `.env.example`
		// documents a different spelling for the same role.
		if (classification.role && !draft.keyMap[classification.role]) {
			draft.keyMap[classification.role] = upper;
		}
		draft.strong = draft.strong || classification.strong;
		draft.sources.add(options.source);
		if (options.file) {
			if (!draft.files.includes(options.file)) draft.files.push(options.file);
			if (!options.commented && !draft.liveFiles.includes(options.file)) {
				draft.liveFiles.push(options.file);
			}
		}

		drafts.set(id, draft);
		sources.add(options.source);
	};

	for (const file of files) {
		const content = await readIfPresent(input.root, file.name);
		if (content === null) continue;
		for (const assignment of parseDotenv(content)) {
			remember(assignment.key, assignment.value, {
				file: file.name,
				// A template's live-looking line is still documentation: the value in
				// `.env.example` is a placeholder, not a configuration.
				commented: assignment.commented || file.isTemplate,
				source: file.name
			});
		}
	}

	for (const relative of CODE_SOURCES) {
		const content = await readIfPresent(input.root, relative);
		if (content === null) continue;
		for (const key of keysReferencedIn(relative, content)) {
			// No value and no file: this says what the project READS, which is
			// exactly the name to offer, but it configures nothing by itself.
			remember(key, '', { file: null, commented: true, source: relative });
		}
	}

	const existing: DbEnvExistingGroup[] = [];
	for (const draft of drafts.values()) {
		if (draft.shape === 'split' && !isRealSplitGroup(draft)) continue;
		if (draft.shape === 'url' && !draft.strong && draft.files.length === 0) continue;

		const keys = [...draft.keys.keys()].sort();
		const orderedFiles = [...draft.files].sort(
			(a, b) => envFilePrecedence(a) - envFilePrecedence(b) || a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
		);
		const isTemplateOnly = draft.liveFiles.length === 0;
		const where = orderedFiles[0] ?? [...draft.sources][0] ?? 'this project';

		const group: DbEnvExistingGroup = {
			prefix: draft.prefix,
			shape: draft.shape,
			keys,
			keyMap: draft.keyMap,
			files: orderedFiles,
			isTemplateOnly,
			label: `${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ` +${keys.length - 3}` : ''} · ${where}`
		};
		existing.push(group);
		precedenceOf.set(
			`${group.shape}:${group.prefix}`,
			orderedFiles.length > 0 ? envFilePrecedence(orderedFiles[0]) : 3
		);
	}

	existing.sort(
		(a, b) =>
			scoreOf(b, input.driver, precedenceOf.get(`${b.shape}:${b.prefix}`) ?? 3) -
			scoreOf(a, input.driver, precedenceOf.get(`${a.shape}:${a.prefix}`) ?? 3)
	);

	debug.log(
		'db-client',
		`env detection found ${existing.length} group(s) across ${sources.size} source(s) in ${input.root}`
	);

	return {
		projectId: input.projectId,
		projectName: input.projectName,
		files,
		existing,
		sources: [...sources]
	};
}
