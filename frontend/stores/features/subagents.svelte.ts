/**
 * Subagents Store
 *
 * Reactive store for Settings → Subagents. Manages user-defined specialized
 * agent definitions (Skills-shaped + tool allowlist / model override) and
 * surfaces on-disk detection. Each engine materializes the enabled set at stream
 * start (native agents dir for Claude, a synthetic preamble for the rest).
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import type { DetectedGroup } from './commands.svelte';
import type { EngineValueMap } from '$frontend/stores/features/artifacts';

export interface InstalledSubagent {
	id: number;
	slug: string;
	name: string;
	description: string;
	/** Per-engine tool allowlist (EngineType → comma list; absent = all tools). */
	toolsByEngine: EngineValueMap;
	/** Per-engine model override (EngineType → model id; absent = inherit). */
	modelByEngine: EngineValueMap;
	source: 'custom' | 'imported';
	enabled: boolean;
	present: boolean;
	createdAt: string;
}

export interface SubagentPayload {
	name: string;
	description: string;
	toolsByEngine?: EngineValueMap;
	modelByEngine?: EngineValueMap;
	body: string;
}

let installed = $state<InstalledSubagent[]>([]);
let installedLoaded = $state(false);
let detected = $state<DetectedGroup[]>([]);
let hasPendingChanges = $state(false);

export const subagentsStore = {
	get installed() { return installed; },
	get installedLoaded() { return installedLoaded; },
	get detected() { return detected; },
	get hasPendingChanges() { return hasPendingChanges; },
	set hasPendingChanges(v: boolean) { hasPendingChanges = v; },

	async fetchInstalled(): Promise<InstalledSubagent[]> {
		if (installedLoaded) return installed;
		return this.refreshInstalled();
	},

	async refreshInstalled(): Promise<InstalledSubagent[]> {
		try {
			const result = await ws.http('subagents:list', {});
			installed = result.subagents;
			installedLoaded = true;
			return installed;
		} catch (error) {
			debug.error('settings', 'Failed to list subagents:', error);
			installed = [];
			installedLoaded = true;
			return [];
		}
	},

	async getDetail(id: number): Promise<{ subagent: InstalledSubagent; body: string }> {
		return ws.http('subagents:get', { id });
	},

	async create(payload: SubagentPayload): Promise<InstalledSubagent> {
		const result = await ws.http('subagents:create', payload);
		await this.refreshInstalled();
		return result.subagent;
	},

	async update(id: number, payload: SubagentPayload): Promise<InstalledSubagent> {
		const result = await ws.http('subagents:update', { id, ...payload });
		await this.refreshInstalled();
		return result.subagent;
	},

	async import(text: string, name?: string): Promise<InstalledSubagent> {
		const result = await ws.http('subagents:import', { text, name });
		await this.refreshInstalled();
		return result.subagent;
	},

	async toggle(id: number, enabled: boolean): Promise<void> {
		await ws.http('subagents:toggle', { id, enabled });
		await this.refreshInstalled();
		await this.refreshDetected();
	},

	async remove(id: number): Promise<void> {
		await ws.http('subagents:delete', { id });
		await this.refreshInstalled();
		await this.refreshDetected();
	},

	async refreshDetected(): Promise<void> {
		try {
			const result = await ws.http('subagents:detect', {});
			detected = result.groups;
		} catch (error) {
			debug.error('settings', 'Failed to detect subagents:', error);
			detected = [];
		}
	},

	reset() {
		installed = [];
		installedLoaded = false;
		detected = [];
	}
};
