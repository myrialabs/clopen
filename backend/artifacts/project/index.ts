/**
 * Project artifacts — a repository's own skills, subagents, instructions and
 * MCP servers (`.agents/`, `.claude/`, `AGENTS.md`, …), surfaced in Settings,
 * delivered to the engines that don't read them natively, and edited in place.
 *
 *   - `sources.ts` — which repo locations exist and which engines read each one
 *   - `scan.ts`    — what a repo carries + per-engine coverage
 *   - `bridge.ts`  — per-stream delivery of the `bridged` part
 *   - `edit.ts`    — the only writer into the repository
 */

export { PROJECT_SOURCES, PROJECT_WRITE_PATHS, sourcesOf, sourceById } from './sources';
export type { ProjectSource, ProjectArtifactKind, ProjectSourceLayout } from './sources';
export { scanProject, parseProjectMcpJson, hashContent } from './scan';
export type {
	ProjectScan,
	ProjectItem,
	ProjectInstructionFile,
	ProjectMcpFile,
	ProjectMcpServer,
	ProjectPermissionsFile,
	EngineCoverage,
	CoverageMap
} from './scan';
export { resolveProjectBridge, buildProjectPromptContext, ensureClaudeProjectPlugin, emptyBridge } from './bridge';
export type { ProjectBridge, BridgedSkill, BridgedSubagent, PromptContextParts } from './bridge';
export {
	readProjectFile,
	saveProjectSkill,
	deleteProjectSkill,
	saveProjectSubagent,
	deleteProjectSubagent,
	copyToAgents,
	readAgentsMd,
	saveAgentsMd,
	saveProjectMcp
} from './edit';
export type { ProjectSkillInput, ProjectSubagentInput, AgentsMdState } from './edit';
