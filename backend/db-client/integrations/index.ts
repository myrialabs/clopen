/**
 * Account-backed connections in DB Client.
 *
 * Importing this module is what wires the `database` capability up, so it must
 * be imported for its side effects before any account is connected —
 * `backend/ws/db-client/` does that, the same way the Deployments router is
 * what makes Vercel exist.
 *
 *   projector.ts          link → `db_client_connections` row
 *   links.ts              choosing which remote databases to bring in
 *   supabase-service.ts   the Supabase surface, resolved against a connection
 *
 * Unlike Issues and Deployments this registers a PROJECTOR rather than an
 * adapter, because DB Client owns a table. A connection is a real row that the
 * drivers, the schema tree and the query console read without knowing where it
 * came from; only the badge and the read-only form know, and they learn it from
 * `integration_projections` rather than from a column on the connection.
 */

import { registerAccountProbe, registerProjector } from '$backend/integrations';
import { registerDbProvider } from '../providers/registry';
import { neonDbAdapter } from '../providers/neon/adapter';
import { supabaseDbAdapter } from '../providers/supabase/adapter';
import { dbConnectionProjector } from './projector';
import { dbLinks } from './links';

registerProjector(dbConnectionProjector);
registerDbProvider(supabaseDbAdapter);
registerDbProvider(neonDbAdapter);

// Health for an account whose capability projects no MCP row. Without this the
// hub reports "Nothing to probe yet" forever for a Supabase account — the same
// gap the Issues surface found and the Deployments surface closed the same way.
//
// `dbLinks.probe` answers null when an account has the `database` capability
// switched off, which is what lets Neon register a SECOND probe from the
// worktree manager without the two overwriting each other.
registerAccountProbe('supabase', (accountId) => dbLinks.probe(accountId));
registerAccountProbe('neon', (accountId) => dbLinks.probe(accountId));

export { dbLinks } from './links';
export { dbConnectionProjector } from './projector';
export { resolveSupabaseScope, supabaseSurface } from './supabase-service';
export type { SupabaseScope } from './supabase-service';
