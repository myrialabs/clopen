/**
 * Instruction service — reads/writes the Clopen-managed instruction block for
 * the single global scope and per project. The content is materialized into each
 * engine's memory file as a MARKER-REGION (see `sync.ts`), so hand-written parts
 * of `CLAUDE.md` / `AGENTS.md` are never touched.
 *
 * This is distinct from Skills/Commands/Subagents (which are discrete
 * installable artifacts): Instructions is one managed block of prose per scope.
 * No prior "memory" feature exists in the app, so there is nothing to duplicate.
 */

import { instructionQueries } from '$backend/database/queries';
import { ARTIFACT_ENGINES, memoryFileName, type ArtifactEngine } from '$backend/artifacts';

export interface InstructionDTO {
	scope: 'global' | 'project';
	projectId: string | null;
	content: string;
	enabled: boolean;
	updatedAt: string | null;
	/** Per-engine memory file the block is injected into (for UI transparency). */
	engineFiles: { engine: ArtifactEngine; fileName: string }[];
}

function engineFiles(): { engine: ArtifactEngine; fileName: string }[] {
	return ARTIFACT_ENGINES.map(engine => ({ engine, fileName: memoryFileName(engine) }));
}

export const instructionService = {
	getGlobal(): InstructionDTO {
		const row = instructionQueries.getGlobal();
		return {
			scope: 'global',
			projectId: null,
			content: row?.content ?? '',
			enabled: row ? row.is_enabled === 1 : true,
			updatedAt: row?.updated_at ?? null,
			engineFiles: engineFiles()
		};
	},

	saveGlobal(content: string, enabled: boolean): InstructionDTO {
		instructionQueries.upsert('global', null, content, enabled);
		return this.getGlobal();
	},

	getForProject(projectId: string): InstructionDTO {
		const row = instructionQueries.getForProject(projectId);
		return {
			scope: 'project',
			projectId,
			content: row?.content ?? '',
			enabled: row ? row.is_enabled === 1 : true,
			updatedAt: row?.updated_at ?? null,
			engineFiles: engineFiles()
		};
	},

	saveForProject(projectId: string, content: string, enabled: boolean): InstructionDTO {
		instructionQueries.upsert('project', projectId, content, enabled);
		return this.getForProject(projectId);
	}
};
