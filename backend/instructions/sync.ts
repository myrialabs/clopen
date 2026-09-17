/**
 * Engine sync for Instructions — writes the managed instruction block into each
 * engine's memory file as a marker-region (`<!-- CLOPEN:INSTRUCTIONS:START … -->`).
 * Global scope always applies; project scope applies to the repo memory file
 * when a project is being streamed.
 *
 * Ownership is MARKER-REGION: only the delimited block is Clopen's; the rest of
 * `CLAUDE.md` / `AGENTS.md` (hand-written by the user) is preserved verbatim.
 * Writing into a project's `CLAUDE.md` touches the repo working tree, so callers
 * pass the repo path explicitly — this is never silent guesswork.
 *
 * Never throws — a stream never breaks because instructions couldn't sync.
 */

import { instructionQueries } from '$backend/database/queries';
import { debug } from '$shared/utils/logger';
import { resolveArtifact, writeManagedBlock, markersFor, readsGlobalMemoryFile, type ArtifactEngine } from '$backend/artifacts';

const MARKERS = markersFor('INSTRUCTIONS');

/**
 * The global instruction block for PER-SESSION injection into the prompt of an
 * engine that reads no memory file (Cline, Cursor — in-process SDKs that build
 * their own system prompt from the workspace).
 *
 * Those engines used to get the block written to an `AGENTS.md` inside their
 * isolated config dir, which nothing ever opened: Instructions simply did not
 * apply there. Returns '' when there is no enabled global block.
 */
export function buildInstructionsPromptContext(): string {
	const row = instructionQueries.getGlobal();
	if (!row || row.is_enabled !== 1) return '';
	const content = row.content.trim();
	if (!content) return '';
	return ['# Project Instructions', '', 'Always-on directives from this Clopen instance:', '', content].join('\n');
}

/**
 * Sync the global (and, when a project is provided, project) instruction block
 * into one engine's memory file(s).
 */
export async function syncInstructions(
	engine: ArtifactEngine,
	project?: { id: string; path: string }
): Promise<void> {
	try {
		// Global scope → engine's isolated global memory file, but ONLY for engines
		// that actually read one. Writing `AGENTS.md` into Cline's or Cursor's
		// config dir produced a file no runtime opens, which is worse than doing
		// nothing: it looked like Instructions were applied when they were not.
		// Those engines receive the block through the prompt instead (see
		// {@link buildInstructionsPromptContext}).
		if (readsGlobalMemoryFile(engine)) {
			const global = instructionQueries.getGlobal();
			const globalTarget = resolveArtifact('instruction', { engine, scope: 'global' }).locateEffective({ engine, scope: 'global' });
			const globalBlock = global && global.is_enabled === 1 ? global.content : '';
			if (globalTarget) await writeManagedBlock(globalTarget, globalBlock, MARKERS);
		}

		// Project scope → repo memory file (touches the working tree).
		if (project) {
			const row = instructionQueries.getForProject(project.id);
			const projectTarget = resolveArtifact('instruction', { engine, scope: 'project', projectPath: project.path }).locateEffective({
				engine,
				scope: 'project',
				projectPath: project.path
			});
			const projectBlock = row && row.is_enabled === 1 ? row.content : '';
			// Only write when there is a managed block to add/update or a prior one to
			// clear — avoids creating an empty repo memory file for nothing.
			if (projectTarget && (projectBlock || row)) {
				await writeManagedBlock(projectTarget, projectBlock, MARKERS);
			}
		}

		debug.log('instructions', `📝 Synced instructions → ${engine}${project ? ' (+project)' : ''}`);
	} catch (error) {
		debug.warn('instructions', `⚠️ Instruction sync for ${engine} failed (continuing without):`, error);
	}
}
