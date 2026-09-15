/**
 * Worktree database branching.
 *
 * Importing this module is what wires the `worktree-branching` capability up,
 * so it must be imported for its side effects before any worktree is created —
 * `backend/ws/worktrees/` does that, the same way the Deployments router is
 * what makes Vercel exist.
 *
 *   engine.ts       WHERE a worktree's database comes from, behind one interface
 *   registry.ts     provider id → adapter, for the providers that branch natively
 *   naming.ts       the deterministic names leak detection depends on
 *   suggest.ts      the binding a project's own `.env` already implies
 *   projector.ts    an account's branches → `db_client_connections` rows
 *   service.ts      attach, detach, the binding, and the orphans
 *
 * NOT A NEON FEATURE, despite Neon being the only provider with a `registry.ts`
 * entry. A worktree needs a database of its own, and branching is one way to
 * get one: `engine.ts` also copies any database DB Client can reach, using that
 * engine's own primitives (`$backend/db-client/cloning.ts`). Local Postgres,
 * MySQL, SQLite and Supabase all work through that path.
 *
 * The dotenv write lives in `$backend/env-files`, shared with DB Client's
 * "apply to .env": both features put a connection string into a project's
 * environment, and one implementation of the managed block, the tracked-file
 * refusal and the precedence order is the only way the two cannot disagree.
 *
 * Like DB Client and unlike Issues and Deployments this registers a PROJECTOR
 * as well as an adapter, because a branch is a real database worth looking at:
 * without the projection a user could see that their agent had run migrations
 * and have no way to inspect what those migrations did.
 */

import { registerAccountProbe, registerProjector } from '$backend/integrations';
import { registerBranchProvider } from './registry';
import { neonBranchAdapter } from './providers/neon';
import { worktreeBranchProjector } from './projector';
import { worktreeBranching } from './service';

registerProjector(worktreeBranchProjector);
registerBranchProvider(neonBranchAdapter);

// Neon declares BOTH `database` and `worktree-branching`, so two surfaces
// register a probe for the same provider. `registerAccountProbe` keeps a LIST
// per provider for exactly this case: each probe answers null when the
// capability it speaks for is switched off, and the first real answer wins. A
// map would have let whichever module loaded last replace the other's silently.
registerAccountProbe('neon', (accountId) => worktreeBranching.probe(accountId));

export { worktreeBranching } from './service';
export { registerBranchProvider, getBranchProvider, listBranchProviders } from './registry';
export { worktreeBranchProjector } from './projector';
export { branchDatabaseNameFor, branchNameFor, isClopenBranchName, isClopenDatabaseName, slugifyForBranch } from './naming';
export { listBranchSources, resolveEngine, resolveEngineForBranch } from './engine';
export type { BranchEngine, BranchPrincipal } from './engine';
export { suggestBranchSource } from './suggest';
export type { BranchProviderAdapter, BranchProviderContext } from './types';
