/**
 * Skills Store
 *
 * Reactive store for Settings → Skills. Manages user-managed Agent Skills
 * (create / import / install) and browsing the skill marketplace. Skills are
 * SKILL.md folders in Clopen's canonical store; each engine materializes the
 * enabled set at stream start (native skills dir for Claude/Copilot, a synthetic
 * preamble for the rest).
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

export type SkillSource = 'custom' | 'imported' | 'marketplace';

export interface InstalledSkill {
	id: number;
	slug: string;
	name: string;
	description: string;
	source: SkillSource;
	marketplaceRef: string | null;
	version: string | null;
	license: string | null;
	enabled: boolean;
	present: boolean;
	createdAt: string;
}

export interface MarketplaceSkill {
	ref: string;
	name: string;
	slug: string;
	description: string;
	stars?: number;
	verified?: boolean;
	homepage?: string;
}

/** A pasted/uploaded SKILL.md normalised for review before import. */
export interface ParsedSkillPreview {
	name: string;
	description: string;
	license: string | null;
	body: string;
	warnings: string[];
}

export interface CreateSkillPayload {
	name: string;
	description: string;
	body: string;
	license?: string;
}

let installed = $state<InstalledSkill[]>([]);
let installedLoaded = $state(false);

let catalog = $state<MarketplaceSkill[]>([]);
let catalogCursor = $state<string | null>(null);
let catalogSearch = $state('');
let catalogLoading = $state(false);
let catalogLoadingFresh = $state(false);
let catalogError = $state<string | null>(null);

let hasPendingChanges = $state(false);

// Monotonic id used to discard superseded/cancelled catalog requests.
let catalogReqId = 0;

export const skillsStore = {
	get installed() { return installed; },
	get installedLoaded() { return installedLoaded; },
	get catalog() { return catalog; },
	get catalogCursor() { return catalogCursor; },
	get catalogSearch() { return catalogSearch; },
	get catalogLoading() { return catalogLoading; },
	get catalogLoadingFresh() { return catalogLoadingFresh; },
	get catalogError() { return catalogError; },
	set catalogError(v: string | null) { catalogError = v; },
	get hasPendingChanges() { return hasPendingChanges; },
	set hasPendingChanges(v: boolean) { hasPendingChanges = v; },

	/** Set of marketplace refs already installed (for "Installed" badges in Browse). */
	get installedRefs(): Set<string> {
		return new Set(installed.map(s => s.marketplaceRef).filter((r): r is string => !!r));
	},

	// ========================================================================
	// Installed skills
	// ========================================================================

	async fetchInstalled(): Promise<InstalledSkill[]> {
		if (installedLoaded) return installed;
		return this.refreshInstalled();
	},

	async refreshInstalled(): Promise<InstalledSkill[]> {
		try {
			const result = await ws.http('skills:list', {});
			installed = result.skills;
			installedLoaded = true;
			return installed;
		} catch (error) {
			debug.error('settings', 'Failed to list skills:', error);
			installed = [];
			installedLoaded = true;
			return [];
		}
	},

	/** Fetch one skill plus its SKILL.md body (for the editor). */
	async getDetail(id: number): Promise<{ skill: InstalledSkill; body: string }> {
		return ws.http('skills:get', { id });
	},

	async create(payload: CreateSkillPayload): Promise<InstalledSkill> {
		const result = await ws.http('skills:create', payload);
		await this.refreshInstalled();
		return result.skill;
	},

	async update(id: number, payload: CreateSkillPayload): Promise<InstalledSkill> {
		const result = await ws.http('skills:update', { id, ...payload });
		await this.refreshInstalled();
		return result.skill;
	},

	/** Normalise pasted/uploaded SKILL.md text into a reviewable preview. */
	async parseImport(text: string): Promise<ParsedSkillPreview> {
		return ws.http('skills:parse-import', { text });
	},

	async import(text: string): Promise<InstalledSkill> {
		const result = await ws.http('skills:import', { text });
		await this.refreshInstalled();
		return result.skill;
	},

	async toggle(id: number, enabled: boolean): Promise<void> {
		await ws.http('skills:toggle', { id, enabled });
		await this.refreshInstalled();
	},

	async remove(id: number): Promise<void> {
		await ws.http('skills:delete', { id });
		await this.refreshInstalled();
	},

	// ========================================================================
	// Marketplace
	// ========================================================================

	/** Fetch a marketplace skill's details (name/description/license/body) for the install modal. */
	async marketplaceDetail(ref: string): Promise<{ name: string; description: string; license: string | null; body: string }> {
		return ws.http('skills:marketplace-detail', { ref });
	},

	async install(ref: string, override?: { name?: string; description?: string; license?: string | null; body?: string }): Promise<InstalledSkill> {
		const result = await ws.http('skills:install', { ref, ...override });
		await this.refreshInstalled();
		return result.skill;
	},

	async searchCatalog(search: string): Promise<void> {
		catalogSearch = search;
		catalogCursor = null;
		await this.loadCatalog(false);
	},

	async loadMoreCatalog(): Promise<void> {
		if (!catalogCursor) return;
		await this.loadCatalog(true);
	},

	cancelSearch(): void {
		catalogReqId++;
		catalogLoading = false;
		catalogLoadingFresh = false;
	},

	async loadCatalog(append: boolean): Promise<void> {
		const reqId = ++catalogReqId;
		catalogLoading = true;
		if (!append) catalogLoadingFresh = true;
		catalogError = null;
		try {
			const result = await ws.http('skills:catalog', {
				search: catalogSearch || undefined,
				cursor: append ? (catalogCursor ?? undefined) : undefined
			});
			if (reqId !== catalogReqId) return; // superseded or cancelled
			catalog = append ? [...catalog, ...result.skills] : result.skills;
			catalogCursor = result.nextCursor;
		} catch (error) {
			if (reqId !== catalogReqId) return;
			debug.error('settings', 'Failed to load skills catalog:', error);
			catalogError = error instanceof Error ? error.message : 'Failed to reach the skills marketplace';
			if (!append) catalog = [];
		} finally {
			if (reqId === catalogReqId) {
				catalogLoading = false;
				catalogLoadingFresh = false;
			}
		}
	},

	reset() {
		installed = [];
		installedLoaded = false;
		catalog = [];
		catalogCursor = null;
		catalogSearch = '';
		catalogLoading = false;
		catalogError = null;
	}
};
