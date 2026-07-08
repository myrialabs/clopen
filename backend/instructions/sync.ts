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
import { resolveArtifact, writeManagedBlock, markersFor, type ArtifactEngine } from '$backend/artifacts';

const MARKERS = markersFor('INSTRUCTIONS');

/**
 * Sync the global (and, when a project is provided, project) instruction block
 * into one engine's memory file(s).
 */
export async function syncInstructions(
	engine: ArtifactEngine,
	project?: { id: string; path: string }
): Promise<void> {
	try {
		// Global scope → engine's isolated global memory file.
		const global = instructionQueries.getGlobal();
		const globalTarget = resolveArtifact('instruction', { engine, scope: 'global' }).locateEffective({ engine, scope: 'global' });
		const globalBlock = global && global.is_enabled === 1 ? global.content : '';
		if (globalTarget) await writeManagedBlock(globalTarget, globalBlock, MARKERS);

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
