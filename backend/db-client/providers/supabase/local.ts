/**
 * Adopting a local Supabase CLI project.
 *
 * A repository that someone has run `supabase init` in already answers the two
 * questions the link dialog would ask — which project this is, and where the
 * local stack listens — and making the user copy them out of a file sitting in
 * their own working tree is the kind of retyping this surface exists to remove.
 *
 * The config is parsed with a deliberately small reader rather than a TOML
 * dependency. Only three values are wanted (`project_id`, and the `[db]` and
 * `[api]` ports), all of them scalars at a known depth, and pulling in a parser
 * for that means one more package whose Bun compatibility has to be kept true.
 * The reader is section-aware precisely because `port` appears under several
 * sections and taking the first one would report the API port as the database's.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { debug } from '$shared/utils/logger';

/** The credentials `supabase start` always uses. They are fixed by the CLI. */
export const LOCAL_DB_USER = 'postgres';
export const LOCAL_DB_PASSWORD = 'postgres';
export const LOCAL_DB_NAME = 'postgres';
export const LOCAL_DB_HOST = '127.0.0.1';
const LOCAL_DB_DEFAULT_PORT = 54322;

export interface SupabaseLocalProject {
	/** Project ref from `project_id`, which the CLI writes at init time. */
	ref: string;
	configPath: string;
	dbPort: number;
	/** Where `supabase/migrations` lives, whether or not it has any files. */
	migrationsDir: string;
	functionsDir: string;
}

/** Strip a TOML scalar down to its value. */
function unquote(raw: string): string {
	const trimmed = raw.trim().replace(/\s*#.*$/, '').trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

interface ParsedConfig {
	projectId: string | null;
	dbPort: number | null;
}

/**
 * Read the handful of values that matter.
 *
 * Section-aware: `port` is set under `[api]`, `[db]`, `[studio]` and more, so a
 * flat scan would pick whichever came first and be confidently wrong.
 */
export function parseSupabaseConfig(contents: string): ParsedConfig {
	let section = '';
	let projectId: string | null = null;
	let dbPort: number | null = null;

	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;

		if (line.startsWith('[')) {
			section = line.replace(/^\[+|\]+$/g, '');
			continue;
		}

		const equals = line.indexOf('=');
		if (equals === -1) continue;
		const key = line.slice(0, equals).trim();
		const value = unquote(line.slice(equals + 1));

		if (!section && key === 'project_id') projectId = value || null;
		if (section === 'db' && key === 'port') {
			const port = Number(value);
			if (Number.isFinite(port) && port > 0) dbPort = port;
		}
	}

	return { projectId, dbPort };
}

/**
 * Detect a Supabase CLI project in a working tree.
 *
 * Returns null rather than throwing for every ordinary reason a project has no
 * Supabase in it — this is called speculatively whenever the panel opens, and a
 * missing file is the common case, not a fault.
 */
export async function detectLocalSupabase(projectRoot: string): Promise<SupabaseLocalProject | null> {
	if (!projectRoot) return null;
	const configPath = join(projectRoot, 'supabase', 'config.toml');

	let contents: string;
	try {
		contents = await readFile(configPath, 'utf-8');
	} catch {
		return null;
	}

	try {
		const parsed = parseSupabaseConfig(contents);
		if (!parsed.projectId) return null;
		return {
			ref: parsed.projectId,
			configPath,
			dbPort: parsed.dbPort ?? LOCAL_DB_DEFAULT_PORT,
			migrationsDir: join(projectRoot, 'supabase', 'migrations'),
			functionsDir: join(projectRoot, 'supabase', 'functions')
		};
	} catch (error) {
		debug.warn('db-client', `Could not read ${configPath}:`, error);
		return null;
	}
}

/** The connection a detected local stack would become, ready to prefill a form. */
export function localConnectionInput(local: SupabaseLocalProject) {
	return {
		name: `Supabase (local) — ${local.ref}`,
		driver: 'postgres' as const,
		host: LOCAL_DB_HOST,
		port: local.dbPort,
		username: LOCAL_DB_USER,
		password: LOCAL_DB_PASSWORD,
		database: LOCAL_DB_NAME,
		sslMode: 'disable' as const,
		// The marker the panel recognises. A local stack has no account and
		// therefore no projection, so this options entry is the only thing that
		// tells DB Client the Supabase surface applies to it.
		options: { supabase: { ref: local.ref, local: true } }
	};
}
