/**
 * Per-stream materialization of the artifact-framework features that sit
 * alongside Skills — Commands, Subagents, and (global) Instructions.
 *
 * Called at stream start by every engine adapter, right after `syncSkills`, so
 * the newly-added features share the exact same trigger point without each
 * adapter growing three separate calls.
 *
 * GLOBAL scope only: writing project-scoped instructions into a repo's
 * `CLAUDE.md` / `AGENTS.md` touches the working tree, which the project's rules
 * require to be an explicit, user-visible action — never silent at stream start.
 * Each underlying sync swallows its own errors, so this never throws.
 */

import { syncCommands, buildCommandsPromptContext } from '$backend/commands';
import { syncSubagents, buildSubagentsPromptContext } from '$backend/subagents';
import { syncInstructions } from '$backend/instructions';
import { buildSkillsPromptContext } from '$backend/skills';
import type { ArtifactEngine } from '$backend/artifacts';

export async function syncEngineArtifacts(engine: ArtifactEngine, profileId?: number): Promise<void> {
	// Sequential, NOT Promise.all: on synthetic engines (Codex/OpenCode) all three
	// write their own managed block into the SAME memory file (AGENTS.md). Running
	// them concurrently would race the read-modify-write and drop blocks. Each call
	// swallows its own errors, so a failure in one doesn't stop the others.
	//
	// `profileId` scopes Commands/Subagents to the active Profile's bundle (see
	// `backend/profiles`). Instructions are NOT profile-bundled — they always sync
	// their full global set.
	await syncCommands(engine, profileId);
	await syncSubagents(engine, profileId);
	await syncInstructions(engine);
}

/**
 * The combined, profile-scoped Skills + Commands + Subagents preamble that
 * prompt-scoped engines (OpenCode/Codex/Copilot) inject into each turn's prompt.
 *
 * Their runtimes read these artifacts through a channel that is SHARED across
 * sessions and not reliably re-read per turn (a persistent server/client and/or
 * a global memory file), so the on-disk/global-file filter can't express a
 * per-session Profile. Injecting the scoped set into the prompt is the one
 * channel that is genuinely per-session. Returns '' when nothing applies.
 */
export function buildArtifactsPromptContext(profileId?: number): string {
	return [
		buildSkillsPromptContext(profileId),
		buildCommandsPromptContext(profileId),
		buildSubagentsPromptContext(profileId)
	].filter(Boolean).join('\n\n');
}
