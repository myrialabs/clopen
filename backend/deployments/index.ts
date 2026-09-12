/**
 * The Deployments surface.
 *
 * Deployments for the current project — list, state, build logs, and the URL a
 * build is reachable at — behind one provider-agnostic interface. Vercel is the
 * first provider; Netlify, Railway, Fly.io, Render, Coolify/Dokploy and
 * Cloudflare Pages are meant to be a directory in `providers/` and a line below.
 *
 *   types.ts        the adapter contract
 *   registry.ts     provider id → adapter
 *   bindings.ts     which remote project this project deploys to
 *   service.ts      the operations every route goes through
 *   log-streams.ts  following a running build
 *   prompts.ts      the text this surface sends into a chat session
 *
 * Importing this module is what wires a provider up, so it must be imported for
 * its side effects before any route runs — `backend/ws/deployments/` does that.
 */

import { registerAccountProbe } from '$backend/integrations';
import { registerDeployProvider } from './registry';
import { vercelDeployAdapter } from './providers/vercel/adapter';
import { deployService } from './service';

registerDeployProvider(vercelDeployAdapter);

// Health for accounts whose capability projects no MCP row. Without this the
// hub would report "Nothing to probe yet" for a Vercel account forever — the
// same gap the Issues surface found and closed.
registerAccountProbe('vercel', (accountId, projectId) => deployService.probe(accountId, projectId));

export { deployService } from './service';
export { getDeployAdapter, listDeployAdapters, registerDeployProvider } from './registry';
export {
	readDeployBinding,
	resolveDeployBinding,
	suggestTargets,
	toDeployBindingInfo
} from './bindings';
export {
	startBuildLogStream,
	stopAllBuildLogStreams,
	stopBuildLogStream,
	stopBuildLogStreamsForUser
} from './log-streams';
export { buildDeployFailurePrompt } from './prompts';
export type {
	DeployContext,
	DeployProviderAdapter,
	DeploymentQuery,
	ResolvedDeployBinding,
	UnboundDeployContext
} from './types';
