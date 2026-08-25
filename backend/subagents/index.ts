/**
 * Subagents — public facade. Settings → Subagents manages reusable specialized
 * agent definitions, materialized into each engine at stream start.
 */

export { subagentService } from './service';
export type { SubagentDTO, SubagentInputFields } from './service';
export { syncSubagents, syncSubagentsAllEngines, buildSubagentsPromptContext, buildOpenCodeInlineAgents } from './sync';
export type { OpenCodeInlineAgent } from './sync';
export { detectSubagents } from './detect';
