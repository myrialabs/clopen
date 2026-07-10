/**
 * Commands Store
 *
 * Reactive store for Settings → Commands. Manages user-defined custom slash
 * command prompts (create / edit / import) and surfaces on-disk detection.
 * Commands are `.md` files in Clopen's canonical store; each engine materializes
 * the enabled set at stream start (native commands dir for Claude, a synthetic
 * preamble for the rest).
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import type { EngineValueMap } from '$frontend/stores/features/artifacts';

export interface InstalledCommand {
	id: number;
	slug: string;
	name: string;
	description: string;
	argumentHint: string | null;
	/** Per-engine model override (EngineType → model id; absent = inherit). */
	modelByEngine: EngineValueMap;
	source: 'custom' | 'imported';
	enabled: boolean;
	present: boolean;
	createdAt: string;
}

export interface DetectedArtifactEntry {
	slug: string;
	name: string;
	description: string;
	path: string;
	managed: boolean;
	adoptable: boolean;
}

export interface DetectedGroup {
	engine: string;
	detected: DetectedArtifactEntry[];
}

export interface AvailableCommand {
	slug: string;
	name: string;
	description: string;
	argumentHint: string | null;
}

export interface CommandPayload {
	name: string;
	description: string;
	argumentHint?: string | null;
	modelByEngine?: EngineValueMap;
	body: string;
}

let installed = $state<InstalledCommand[]>([]);
let installedLoaded = $state(false);
let detected = $state<DetectedGroup[]>([]);
let available = $state<AvailableCommand[]>([]);
let hasPendingChanges = $state(false);

export const commandsStore = {
	get installed() { return installed; },
	get installedLoaded() { return installedLoaded; },
	get detected() { return detected; },
	/** Enabled commands for the chat "/" picker (non-admin surface). */
	get available() { return available; },
	get hasPendingChanges() { return hasPendingChanges; },
	set hasPendingChanges(v: boolean) { hasPendingChanges = v; },

	/**
	 * `profileId`/`projectId` narrow the result to the session's active profile
	 * (mirrors the engine sync's stream-time filtering), same as `syncCommands`.
	 */
	async fetchAvailable(profileId?: number | null, projectId?: string): Promise<AvailableCommand[]> {
		try {
			const result = await ws.http('commands:available', { profileId, projectId });
			available = result.commands;
		} catch (error) {
			debug.error('settings', 'Failed to load available commands:', error);
			available = [];
		}
		return available;
	},

	async fetchInstalled(): Promise<InstalledCommand[]> {
		if (installedLoaded) return installed;
		return this.refreshInstalled();
	},

	async refreshInstalled(): Promise<InstalledCommand[]> {
		try {
			const result = await ws.http('commands:list', {});
			installed = result.commands;
			installedLoaded = true;
			return installed;
		} catch (error) {
			debug.error('settings', 'Failed to list commands:', error);
			installed = [];
			installedLoaded = true;
			return [];
		}
	},

	async getDetail(id: number): Promise<{ command: InstalledCommand; body: string }> {
		return ws.http('commands:get', { id });
	},

	async create(payload: CommandPayload): Promise<InstalledCommand> {
		const result = await ws.http('commands:create', payload);
		await this.refreshInstalled();
		await this.fetchAvailable();
		return result.command;
	},

	async update(id: number, payload: CommandPayload): Promise<InstalledCommand> {
		const result = await ws.http('commands:update', { id, ...payload });
		await this.refreshInstalled();
		await this.fetchAvailable();
		return result.command;
	},

	async parseImport(text: string): Promise<{ name: string; description: string; argumentHint: string | null; modelByEngine: EngineValueMap; body: string }> {
		return ws.http('commands:parse-import', { text });
	},

	async import(text: string, name?: string): Promise<InstalledCommand> {
		const result = await ws.http('commands:import', { text, name });
		await this.refreshInstalled();
		await this.fetchAvailable();
		return result.command;
	},

	async toggle(id: number, enabled: boolean): Promise<void> {
		await ws.http('commands:toggle', { id, enabled });
		await this.refreshInstalled();
		await this.refreshDetected();
		await this.fetchAvailable();
	},

	async remove(id: number): Promise<void> {
		await ws.http('commands:delete', { id });
		await this.refreshInstalled();
		await this.refreshDetected();
		await this.fetchAvailable();
	},

	async refreshDetected(): Promise<void> {
		try {
			const result = await ws.http('commands:detect', {});
			detected = result.groups;
		} catch (error) {
			debug.error('settings', 'Failed to detect commands:', error);
			detected = [];
		}
	},

	reset() {
		installed = [];
		installedLoaded = false;
		detected = [];
	}
};
