/**
 * Per-stream materialization of the artifact-framework features that sit
 * alongside Skills — Subagents and (global) Instructions — plus the cleanup of
 * artifacts earlier versions wrote for the now-merged Commands feature.
 *
 * Called at stream start by every engine adapter, right after `syncSkills`, so
 * the features share the exact same trigger point without each adapter growing
 * separate calls.
 *
 * GLOBAL scope only: writing project-scoped instructions into a repo's
 * `CLAUDE.md` / `AGENTS.md` touches the working tree, which the project's rules
 * require to be an explicit, user-visible action — never silent at stream start.
 * Each underlying sync swallows its own errors, so this never throws.
 */

import { syncSubagents, buildSubagentsPromptContext } from '$backend/subagents';
import { syncInstructions, buildInstructionsPromptContext } from '$backend/instructions';
import { buildSkillsPromptContext, stripLegacyCommandArtifacts } from '$backend/skills';
import { readsGlobalMemoryFile, type ArtifactEngine } from '$backend/artifacts';

export async function syncEngineArtifacts(engine: ArtifactEngine, profileId?: number): Promise<void> {
	// Sequential, NOT Promise.all: on synthetic engines (Codex/OpenCode) these
	// write their own managed block into the SAME memory file (AGENTS.md). Running
	// them concurrently would race the read-modify-write and drop blocks. Each call
	// swallows its own errors, so a failure in one doesn't stop the others.
	//
	// `profileId` scopes Subagents to the active Profile's bundle (see
	// `backend/profiles`). Instructions are NOT profile-bundled — they always sync
	// their full global set.
	await stripLegacyCommandArtifacts(engine);
	await syncSubagents(engine, profileId);
	await syncInstructions(engine);
}

/**
 * The combined, profile-scoped artifact preamble that prompt-scoped engines
 * inject into each turn's prompt.
 *
 * Their runtimes read artifacts through a channel that is SHARED across sessions
 * and not reliably re-read per turn (a persistent server/client and/or a global
 * memory file), so the on-disk/global-file filter can't express a per-session
 * Profile. Injecting the scoped set into the prompt is the one channel that is
 * genuinely per-session. Returns '' when nothing applies.
 *
 * `engine` decides whether Instructions ride along. Codex/Copilot/OpenCode read
 * the memory file `syncInstructions` writes, so adding them here would say the
 * same thing twice. Cline and Cursor read no such file — for them the prompt is
 * the ONLY channel, and before this parameter existed their Instructions were
 * written to a file nothing opened and silently never applied.
 */
export function buildArtifactsPromptContext(engine: ArtifactEngine, profileId?: number): string {
	return [
		readsGlobalMemoryFile(engine) ? '' : buildInstructionsPromptContext(),
		buildSkillsPromptContext(profileId),
		buildSubagentsPromptContext(engine, profileId)
	].filter(Boolean).join('\n\n');
}
