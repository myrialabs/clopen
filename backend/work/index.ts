/**
 * The Issues & PRs surface.
 *
 * Work items — issues, pull requests and the CI attached to them — for the
 * current project, behind one provider-agnostic interface. GitHub is the first
 * provider; GitLab, Gitea, Forgejo, Linear, Jira and PostHog are meant to be a
 * file in `providers/` and a line below.
 *
 *   types.ts         the adapter contract
 *   registry.ts      provider id → adapter
 *   bindings.ts      which remote project this project is looking at
 *   service.ts       the operations every route goes through
 *   start-work.ts    work item → worktree + branch + session + first prompt
 *   pull-requests.ts branch → pull request, with an AI-drafted description
 *   prompts.ts       the text this surface sends into a chat session
 *
 * Importing this module is what wires a provider up, so it must be imported for
 * its side effects before any route runs — `backend/ws/issues/` does that.
 */

import { registerAccountProbe } from '$backend/integrations';
import { registerWorkProvider } from './registry';
import { githubWorkAdapter } from './providers/github/adapter';
import { workService } from './service';

registerWorkProvider(githubWorkAdapter);

// Health for accounts whose capability projects no MCP row. Without this the
// hub would report "Nothing to probe yet" for a GitHub account forever.
registerAccountProbe('github', (accountId, projectId) => workService.probe(accountId, projectId));

export { workService } from './service';
export { getWorkAdapter, listWorkAdapters, registerWorkProvider } from './registry';
export { readBinding, resolveBinding, suggestLocators, toBindingInfo } from './bindings';
export { startWork, renderBranchName, applyConfiguredTransition } from './start-work';
export {
	buildPullRequestContext,
	draftPullRequestDescription,
	pushPullRequestHead
} from './pull-requests';
export { buildCheckLogPrompt, buildStartWorkPrompt } from './prompts';
export type { WorkContext, WorkProviderAdapter, ResolvedBinding, UnboundContext } from './types';
