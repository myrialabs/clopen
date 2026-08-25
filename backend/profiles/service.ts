/**
 * Profile service — the bundle layer (Settings → Profiles) and the stream-time
 * resolution consumed by the artifact/MCP sync path.
 *
 * A Profile is a reusable, named set of references to existing artifacts
 * (Skills, Commands, Subagents, MCP Connectors). It NARROWS which of the
 * instance-global artifacts are active for a session, without duplicating any
 * artifact data — `profile_items` only stores slugs.
 *
 * ── Activation resolution ──
 *   effective profile = chat_sessions.profile_id  ??  projects.default_profile_id
 * resolved once at stream start (see {@link resolveActiveProfileId}) and passed
 * down through the existing per-engine sync via `mcpContext.profileId`.
 *
 * ── Presence-per-type filtering ──
 * A profile only constrains the artifact TYPES it actually references. For a
 * given type, {@link artifactFilter} returns:
 *   - `null`  when the profile references NO item of that type → unconstrained
 *     (the sync keeps its normal "all enabled" behaviour — no regression), and
 *     also when there is no active profile at all;
 *   - a `Set<slug>` when the profile references ≥1 item → the sync intersects its
 *     enabled set with these slugs.
 * This means a profile that only curates Commands never silently disables every
 * Skill, and a NULL/absent profile behaves exactly like today.
 */

import { profileQueries, projectQueries, mcpServerQueries } from '$backend/database/queries';
import type { ProfileItemType, ProfileItemInput } from '$backend/database/queries';
import { PROFILE_ITEM_TYPES } from '$backend/database/queries';
import { skillQueries, commandQueries, subagentQueries } from '$backend/database/queries';
import { debug } from '$shared/utils/logger';

/** A profile with its items grouped by type, for the Settings UI. */
export interface ProfileDTO {
	id: number;
	slug: string;
	name: string;
	description: string;
	items: Record<ProfileItemType, string[]>;
	itemCount: number;
	createdAt: string;
	updatedAt: string;
}

/** One selectable artifact in the profile editor. */
export interface ProfileInventoryEntry {
	slug: string;
	name: string;
	enabled: boolean;
}

/** The artifacts a profile can bundle, grouped by type. */
export type ProfileInventory = Record<ProfileItemType, ProfileInventoryEntry[]>;

function emptyItems(): Record<ProfileItemType, string[]> {
	return { skill: [], command: [], subagent: [], mcp: [] };
}

function toDTO(id: number): ProfileDTO | null {
	const row = profileQueries.getById(id);
	if (!row) return null;
	const items = emptyItems();
	for (const item of profileQueries.getItems(id)) {
		if (PROFILE_ITEM_TYPES.includes(item.artifact_type)) items[item.artifact_type].push(item.ref);
	}
	const itemCount = PROFILE_ITEM_TYPES.reduce((n, t) => n + items[t].length, 0);
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		items,
		itemCount,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

/**
 * The effective profile for a stream: the session's explicit choice, else the
 * project's shared default, else none. Returns a numeric profile id or null.
 */
export function resolveActiveProfileId(
	sessionProfileId: number | null | undefined,
	projectId: string | undefined
): number | null {
	if (sessionProfileId != null) return sessionProfileId;
	if (projectId) return projectQueries.getDefaultProfileId(projectId);
	return null;
}

/**
 * The slug allow-set for one artifact type under an active profile, or null when
 * the type is unconstrained (see file header). `profileId == null` → always null.
 */
export function artifactFilter(profileId: number | null | undefined, type: ProfileItemType): Set<string> | null {
	if (profileId == null) return null;
	const refs = profileQueries.getRefsByType(profileId, type);
	return refs.length > 0 ? new Set(refs) : null;
}

export const profileService = {
	/** All profiles (metadata + grouped items) for the admin listing. */
	list(): ProfileDTO[] {
		return profileQueries.getAll().map(r => toDTO(r.id)!).filter(Boolean);
	},

	get(id: number): ProfileDTO | null {
		return toDTO(id);
	},

	create(name: string, description: string, items: ProfileItemInput[]): ProfileDTO {
		const slug = uniqueProfileSlug(name);
		const row = profileQueries.insert({ slug, name, description });
		profileQueries.setItems(row.id, items);
		debug.log('profiles', `🎛️ Created profile "${name}" (${items.length} item(s))`);
		return toDTO(row.id)!;
	},

	update(id: number, name: string, description: string, items: ProfileItemInput[]): ProfileDTO {
		const row = profileQueries.getById(id);
		if (!row) throw new Error('Profile not found');
		profileQueries.updateMeta(id, name, description);
		profileQueries.setItems(id, items);
		debug.log('profiles', `🎛️ Updated profile "${name}" (${items.length} item(s))`);
		return toDTO(id)!;
	},

	remove(id: number): void {
		profileQueries.remove(id);
		debug.log('profiles', `🎛️ Deleted profile #${id}`);
	},

	/** Artifacts selectable in the profile editor, grouped by type. */
	inventory(): ProfileInventory {
		const inv: ProfileInventory = { skill: [], command: [], subagent: [], mcp: [] };
		for (const s of skillQueries.getAll()) inv.skill.push({ slug: s.slug, name: s.name, enabled: s.is_enabled === 1 });
		for (const c of commandQueries.getAll()) inv.command.push({ slug: c.slug, name: c.name, enabled: c.is_enabled === 1 });
		for (const a of subagentQueries.getAll()) inv.subagent.push({ slug: a.slug, name: a.name, enabled: a.is_enabled === 1 });
		// Both external AND built-in (internal) connectors are selectable — a profile
		// can scope Clopen's own tools (e.g. browser-automation) too.
		for (const m of mcpServerQueries.getAll()) {
			inv.mcp.push({ slug: m.slug, name: m.name, enabled: m.is_enabled === 1 });
		}
		return inv;
	},

	/** Lightweight list for the non-admin per-session picker (id + name only). */
	available(): { id: number; slug: string; name: string; description: string }[] {
		return profileQueries.getAll().map(r => ({ id: r.id, slug: r.slug, name: r.name, description: r.description }));
	}
};

function uniqueProfileSlug(name: string): string {
	// Local import to avoid a top-level cycle through the artifacts barrel.
	const base = name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64)
		.replace(/-+$/g, '') || 'profile';
	if (!profileQueries.getBySlug(base)) return base;
	for (let i = 2; i < 1000; i++) {
		const candidate = `${base}-${i}`.slice(0, 64).replace(/-+$/g, '');
		if (!profileQueries.getBySlug(candidate)) return candidate;
	}
	return `${base}-x`;
}
