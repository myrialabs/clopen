/**
 * Instructions Store
 *
 * Reactive store for Settings → Instructions. Manages the Clopen-managed
 * instruction block for the global scope (and, when given, per project). The
 * block is injected into each engine's memory file (CLAUDE.md / AGENTS.md / …)
 * as a marker-region, so hand-written content is preserved.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

export interface InstructionData {
	scope: 'global' | 'project';
	projectId: string | null;
	content: string;
	enabled: boolean;
	updatedAt: string | null;
	engineFiles: { engine: string; fileName: string }[];
}

let global = $state<InstructionData | null>(null);
let hasPendingChanges = $state(false);

export const instructionsStore = {
	get global() { return global; },
	get hasPendingChanges() { return hasPendingChanges; },
	set hasPendingChanges(v: boolean) { hasPendingChanges = v; },

	async fetchGlobal(): Promise<InstructionData | null> {
		try {
			const result = await ws.http('instructions:get-global', {});
			global = result.instruction;
			return global;
		} catch (error) {
			debug.error('settings', 'Failed to load global instructions:', error);
			return null;
		}
	},

	async saveGlobal(content: string, enabled: boolean): Promise<void> {
		const result = await ws.http('instructions:save-global', { content, enabled });
		global = result.instruction;
		hasPendingChanges = true;
	},

	async fetchProject(projectId: string): Promise<InstructionData | null> {
		try {
			const result = await ws.http('instructions:get-project', { projectId });
			return result.instruction;
		} catch (error) {
			debug.error('settings', 'Failed to load project instructions:', error);
			return null;
		}
	},

	async saveProject(projectId: string, content: string, enabled: boolean): Promise<InstructionData> {
		const result = await ws.http('instructions:save-project', { projectId, content, enabled });
		hasPendingChanges = true;
		return result.instruction;
	},

	reset() {
		global = null;
	}
};
