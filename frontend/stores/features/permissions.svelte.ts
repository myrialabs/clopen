/**
 * Permissions Store
 *
 * Reactive store for Settings → Permissions. Manages per-engine tool allow/deny
 * rules (global scope) and the tool inventory offered as allow/deny targets.
 * Rules are enforced at each engine's runtime auto-approve hook on the next
 * chat stream (real on Claude/Qwen/Copilot; best-effort on OpenCode/Codex).
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import type { EngineType } from '$shared/types/unified';

export interface PermissionSet {
	scope: 'global' | 'project';
	projectId: string | null;
	engine: EngineType;
	allow: string[];
	deny: string[];
}

export interface EngineInventory {
	engine: EngineType;
	builtin: string[];
	bestEffort: boolean;
}

export interface PermissionInventory {
	engines: EngineInventory[];
	mcp: string[];
	subagent: string[];
}

let sets = $state<PermissionSet[]>([]);
let setsLoaded = $state(false);
let inventory = $state<PermissionInventory | null>(null);
let inventoryLoaded = $state(false);
let hasPendingChanges = $state(false);

/** Empty rule set for an engine that has no stored row yet. */
function emptySet(engine: EngineType): PermissionSet {
	return { scope: 'global', projectId: null, engine, allow: [], deny: [] };
}

export const permissionsStore = {
	get sets() { return sets; },
	get setsLoaded() { return setsLoaded; },
	get inventory() { return inventory; },
	get inventoryLoaded() { return inventoryLoaded; },
	get hasPendingChanges() { return hasPendingChanges; },
	set hasPendingChanges(v: boolean) { hasPendingChanges = v; },

	/** The stored global set for an engine, or an empty one. */
	globalSet(engine: EngineType): PermissionSet {
		return sets.find(s => s.scope === 'global' && s.engine === engine) ?? emptySet(engine);
	},

	async fetchSets(): Promise<PermissionSet[]> {
		if (setsLoaded) return sets;
		return this.refreshSets();
	},

	async refreshSets(): Promise<PermissionSet[]> {
		try {
			const result = await ws.http('permissions:list', {});
			sets = result.sets as PermissionSet[];
			setsLoaded = true;
			return sets;
		} catch (error) {
			debug.error('settings', 'Failed to list permissions:', error);
			sets = [];
			setsLoaded = true;
			return [];
		}
	},

	async fetchInventory(): Promise<PermissionInventory | null> {
		if (inventoryLoaded) return inventory;
		return this.refreshInventory();
	},

	async refreshInventory(): Promise<PermissionInventory | null> {
		try {
			inventory = await ws.http('permissions:inventory', {}) as PermissionInventory;
			inventoryLoaded = true;
			return inventory;
		} catch (error) {
			debug.error('settings', 'Failed to load permission inventory:', error);
			inventory = null;
			inventoryLoaded = true;
			return null;
		}
	},

	async saveGlobal(engine: EngineType, allow: string[], deny: string[]): Promise<void> {
		await ws.http('permissions:save', { scope: 'global', projectId: null, engine, allow, deny });
		hasPendingChanges = true;
		await this.refreshSets();
	},

	reset() {
		sets = [];
		setsLoaded = false;
		inventory = null;
		inventoryLoaded = false;
	}
};
