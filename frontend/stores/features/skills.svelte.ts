/**
 * Skills Store
 *
 * Reactive store for Settings → Skills. One feature covering both ways a
 * reusable prompt gets invoked: by the MODEL (`auto` trigger, chosen from the
 * description) and by the USER (`slash` trigger, typed as `/<slug>` in chat).
 * The separate Commands menu folded in here — see migration 079.
 *
 * Skills are SKILL.md folders in Clopen's canonical store; each engine
 * materializes the active set at stream start (native skills dir where one
 * exists, a per-turn prompt preamble otherwise), while `/slash` invocations are
 * expanded by Clopen itself so they behave identically on every engine.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

export type SkillSource = 'custom' | 'imported' | 'marketplace';

/** How a skill can be invoked. */
export type SkillTrigger = 'auto' | 'slash';

export interface InstalledSkill {
	id: number;
	slug: string;
	name: string;
	description: string;
	source: SkillSource;
	marketplaceRef: string | null;
	version: string | null;
	license: string | null;
	/** `auto` (model-invoked), `slash` (user-invoked), or both. Never empty. */
	triggers: SkillTrigger[];
	/** Argument hint shown beside `/slug` in the chat picker. */
	argumentHint: string | null;
	/** Sibling slugs force-loaded whenever this skill runs. */
	uses: string[];
	enabled: boolean;
	present: boolean;
	createdAt: string;
}

/** One slash-invocable skill as offered by the chat "/" picker. */
export interface AvailableSkill {
	slug: string;
	name: string;
	description: string;
	argumentHint: string | null;
}

/** A skill discovered on disk (managed copy, or an adoptable real one). */
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
	triggers: SkillTrigger[];
	argumentHint: string | null;
	uses: string[];
	body: string;
	warnings: string[];
}

export interface CreateSkillPayload {
	/** Machine id. Accepted on create only; `update` ignores it. */
	slug?: string;
	name: string;
	description: string;
	body: string;
	license?: string;
	triggers?: SkillTrigger[];
	argumentHint?: string | null;
	uses?: string[];
}

let installed = $state<InstalledSkill[]>([]);
let installedLoaded = $state(false);
let detected = $state<DetectedGroup[]>([]);
let available = $state<AvailableSkill[]>([]);

let catalog = $state<MarketplaceSkill[]>([]);
let catalogCursor = $state<string | null>(null);
let catalogSearch = $state('');
let catalogLoading = $state(false);
let catalogLoadingFresh = $state(false);
let catalogError = $state<string | null>(null);

// Monotonic id used to discard superseded/cancelled catalog requests.
let catalogReqId = 0;

export const skillsStore = {
	get installed() { return installed; },
	get installedLoaded() { return installedLoaded; },
	get detected() { return detected; },
	/** Slash-invocable skills for the chat "/" picker (non-admin surface). */
	get available() { return available; },
	get catalog() { return catalog; },
	get catalogCursor() { return catalogCursor; },
	get catalogSearch() { return catalogSearch; },
	get catalogLoading() { return catalogLoading; },
	get catalogLoadingFresh() { return catalogLoadingFresh; },
	get catalogError() { return catalogError; },
	set catalogError(v: string | null) { catalogError = v; },

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

	/**
	 * `profileId`/`projectId` narrow the result to the session's active profile
	 * (mirrors the engine's stream-time filtering), so the "/" picker shows
	 * exactly what an invocation would actually resolve to.
	 */
	async fetchAvailable(profileId?: number | null, projectId?: string): Promise<AvailableSkill[]> {
		try {
			const result = await ws.http('skills:available', { profileId, projectId });
			available = result.skills;
		} catch (error) {
			debug.error('settings', 'Failed to load available skills:', error);
			available = [];
		}
		return available;
	},

	async refreshDetected(): Promise<void> {
		try {
			const result = await ws.http('skills:detect', {});
			detected = result.groups;
		} catch (error) {
			debug.error('settings', 'Failed to detect skills:', error);
			detected = [];
		}
	},

	/** Link an adoptable on-disk skill into Clopen's isolated engine dir. */
	async adopt(engine: string, slug: string, path: string): Promise<void> {
		await ws.http('skills:adopt', { engine, slug, path });
		await this.refreshDetected();
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
		await this.fetchAvailable();
		return result.skill;
	},

	async update(id: number, payload: CreateSkillPayload): Promise<InstalledSkill> {
		const result = await ws.http('skills:update', { id, ...payload });
		await this.refreshInstalled();
		await this.fetchAvailable();
		return result.skill;
	},

	/** Normalise pasted/uploaded SKILL.md text into a reviewable preview. */
	async parseImport(text: string): Promise<ParsedSkillPreview> {
		return ws.http('skills:parse-import', { text });
	},

	async import(text: string, name?: string): Promise<InstalledSkill> {
		const result = await ws.http('skills:import', { text, name });
		await this.refreshInstalled();
		await this.fetchAvailable();
		return result.skill;
	},

	async toggle(id: number, enabled: boolean): Promise<void> {
		await ws.http('skills:toggle', { id, enabled });
		await this.refreshInstalled();
		await this.fetchAvailable();
	},

	async remove(id: number): Promise<void> {
		await ws.http('skills:delete', { id });
		await this.refreshInstalled();
		await this.fetchAvailable();
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
		detected = [];
		available = [];
		catalog = [];
		catalogCursor = null;
		catalogSearch = '';
		catalogLoading = false;
		catalogError = null;
	}
};
