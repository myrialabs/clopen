/**
 * The `supabase/config.toml` reader.
 *
 * Worth testing because the mistake it exists to avoid is silent: `port` is set
 * under half a dozen sections in a real config, and a flat scan reports the API
 * port as the database's. The connection then fails with "server does not
 * support SSL" or a protocol error, neither of which points at the config.
 */

import { describe, it, expect } from 'bun:test';
import { parseSupabaseConfig } from './local';

/** Trimmed from a real `supabase init` config, keeping the order it writes. */
const REAL_CONFIG = `
# A string used to distinguish different Supabase projects on the same host.
project_id = "acme-web"

[api]
enabled = true
port = 54321
schemas = ["public", "graphql_public"]

[db]
# Port to use for the local database URL.
port = 54322
shadow_port = 54320
major_version = 15

[db.pooler]
enabled = false
port = 54329

[studio]
enabled = true
port = 54323
`;

describe('parseSupabaseConfig', () => {
	it('reads the project id and the database port', () => {
		const parsed = parseSupabaseConfig(REAL_CONFIG);
		expect(parsed.projectId).toBe('acme-web');
		expect(parsed.dbPort).toBe(54322);
	});

	it('does not mistake the api port for the database port', () => {
		// `[api]` comes FIRST in the file the CLI writes, so a reader that takes
		// the first `port` it sees is wrong on every real project.
		expect(parseSupabaseConfig(REAL_CONFIG).dbPort).not.toBe(54321);
	});

	it('does not read a nested section as its parent', () => {
		// `[db.pooler]` is not `[db]`. Treating it as one would pick up 54329.
		expect(parseSupabaseConfig(REAL_CONFIG).dbPort).not.toBe(54329);
	});

	it('ignores comments and trailing comments', () => {
		const parsed = parseSupabaseConfig(`
# project_id = "commented-out"
project_id = "real-one" # the actual value
`);
		expect(parsed.projectId).toBe('real-one');
	});

	it('accepts single quotes and bare values', () => {
		expect(parseSupabaseConfig(`project_id = 'quoted'`).projectId).toBe('quoted');
		expect(parseSupabaseConfig(`project_id = bare`).projectId).toBe('bare');
	});

	it('reports nothing for a config with no project id', () => {
		const parsed = parseSupabaseConfig(`[db]\nport = 54322\n`);
		expect(parsed.projectId).toBe(null);
		expect(parsed.dbPort).toBe(54322);
	});

	it('rejects a port that is not a number rather than storing NaN', () => {
		expect(parseSupabaseConfig(`[db]\nport = "auto"\n`).dbPort).toBe(null);
	});
});
