/**
 * Profiles Store
 *
 * Reactive store for Settings → Profiles — reusable bundles that reference
 * existing artifacts (Skills, Commands, Subagents, MCP Connectors) by slug, plus
 * an optional per-engine permission overlay. A profile is activated per-session
 * (see the picker) and resolved at stream start against the project's shared
 * default. Nothing here duplicates artifact data.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

export type ProfileItemType = 'skill' | 'command' | 'subagent' | 'mcp';

export interface ProfileItems {
	skill: string[];
	command: string[];
	subagent: string[];
	mcp: string[];
}

export interface Profile {
	id: number;
	slug: string;
	name: string;
	description: string;
	items: ProfileItems;
	itemCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface ProfileInventoryEntry {
	slug: string;
	name: string;
	enabled: boolean;
}

export type ProfileInventory = Record<ProfileItemType, ProfileInventoryEntry[]>;

export interface ProfilePermissionOverlay {
	engine: string;
	allow: string[];
	deny: string[];
}

export interface ProfilePayload {
	name: string;
	description: string;
	items: ProfileItems;
}

export interface AvailableProfile {
	id: number;
	slug: string;
	name: string;
	description: string;
}

let profiles = $state<Profile[]>([]);
let loaded = $state(false);
let inventory = $state<ProfileInventory | null>(null);
// Lightweight list for the non-admin per-session picker.
let available = $state<AvailableProfile[]>([]);
let availableLoaded = $state(false);

function itemsToArray(items: ProfileItems): { artifactType: ProfileItemType; ref: string }[] {
	const out: { artifactType: ProfileItemType; ref: string }[] = [];
	(['skill', 'command', 'subagent', 'mcp'] as ProfileItemType[]).forEach(type => {
		for (const ref of items[type]) out.push({ artifactType: type, ref });
	});
	return out;
}

export const profilesStore = {
	get profiles() { return profiles; },
	get loaded() { return loaded; },
	get inventory() { return inventory; },
	get available() { return available; },

	// ── Per-session picker (non-admin) ─────────────────────────────────────────
	async fetchAvailable(force = false): Promise<AvailableProfile[]> {
		if (availableLoaded && !force) return available;
		try {
			const result = await ws.http('profiles:available', {});
			available = result.profiles;
			availableLoaded = true;
		} catch (error) {
			debug.error('settings', 'Failed to list available profiles:', error);
		}
		return available;
	},

	async projectDefault(projectId: string): Promise<number | null> {
		try {
			const result = await ws.http('profiles:project-default', { projectId });
			return result.profileId;
		} catch (error) {
			debug.error('settings', 'Failed to read project default profile:', error);
			return null;
		}
	},

	async setProjectDefault(projectId: string, profileId: number | null): Promise<void> {
		await ws.http('profiles:set-project-default', { projectId, profileId });
	},

	async fetch(): Promise<Profile[]> {
		if (loaded) return profiles;
		return this.refresh();
	},

	async refresh(): Promise<Profile[]> {
		try {
			const result = await ws.http('profiles:list', {});
			profiles = result.profiles;
			loaded = true;
			availableLoaded = false; // picker list may be stale after any admin mutation
			return profiles;
		} catch (error) {
			debug.error('settings', 'Failed to list profiles:', error);
			profiles = [];
			loaded = true;
			return [];
		}
	},

	async fetchInventory(): Promise<ProfileInventory> {
		const result = await ws.http('profiles:inventory', {});
		inventory = result;
		return result;
	},

	async get(id: number): Promise<Profile> {
		const result = await ws.http('profiles:get', { id });
		return result.profile;
	},

	async create(payload: ProfilePayload): Promise<Profile> {
		const result = await ws.http('profiles:create', {
			name: payload.name,
			description: payload.description,
			items: itemsToArray(payload.items)
		});
		await this.refresh();
		return result.profile;
	},

	async update(id: number, payload: ProfilePayload): Promise<Profile> {
		const result = await ws.http('profiles:update', {
			id,
			name: payload.name,
			description: payload.description,
			items: itemsToArray(payload.items)
		});
		await this.refresh();
		return result.profile;
	},

	async remove(id: number): Promise<void> {
		await ws.http('profiles:delete', { id });
		await this.refresh();
	},

	// ── Per-profile permission overlay ─────────────────────────────────────────
	async getPermissions(id: number): Promise<ProfilePermissionOverlay[]> {
		const result = await ws.http('profiles:get-permissions', { id });
		return result.sets;
	},

	async savePermissions(id: number, engine: string, allow: string[], deny: string[]): Promise<void> {
		await ws.http('profiles:save-permissions', { id, engine, allow, deny });
	},

	reset() {
		profiles = [];
		loaded = false;
		inventory = null;
		available = [];
		availableLoaded = false;
	}
};
