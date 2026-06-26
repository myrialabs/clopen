/**
 * Skill marketplace — browse and install skills from the community registry.
 *
 * Source: the `claude-skill-registry` lite index — a single daily-updated JSON
 * catalog hosted as a static file on GitHub Pages. It crawls public GitHub repos
 * for SKILL.md files under `.claude/skills`, scores them, and ships the top
 * ~5000. Being a static file (not the GitHub API) it has no rate limit.
 *
 * The catalog is filtered, deduped, and ordered (verified first, then by stars);
 * `verified` reflects the index's security/install signals. Every install
 * resolves to raw SKILL.md text that the skill service validates against the
 * open spec before writing — no registry output is trusted blindly.
 */

import { debug } from '$shared/utils/logger';

/** A skill as listed in the marketplace browse view. */
export interface MarketplaceSkill {
	/** Install-scoped id stored as `marketplace_ref`, e.g. `community:owner/repo/path`. */
	ref: string;
	name: string;
	slug: string;
	description: string;
	stars?: number;
	/** Passed the registry's automated security/install review. */
	verified?: boolean;
	homepage?: string;
}

export interface MarketplacePage {
	skills: MarketplaceSkill[];
	nextCursor: string | null;
}

/** SKILL.md text plus any bundled resource files, ready for the service to write. */
export interface FetchedSkill {
	skillMd: string;
	resources: { path: string; content: string }[];
}

const PAGE_SIZE = 30;
const COMMUNITY_INDEX_URL = 'https://majiayu000.github.io/claude-skill-registry-core/search-index-lite.json';

/**
 * A lite-index entry. The index uses full keys (`name`/`description`/`install`/
 * `stars`/…); `verified` is derived from its security/install signals.
 */
interface CommunityEntry {
	name?: string;
	description?: string;
	install?: string;
	branch?: string;
	stars?: number;
	security_status?: string;
	install_status?: string;
}

let communityCache: { entries: CommunityEntry[]; at: number } | null = null;

async function getCommunityIndex(): Promise<CommunityEntry[]> {
	if (communityCache && Date.now() - communityCache.at < 10 * 60_000) return communityCache.entries;
	const res = await fetch(COMMUNITY_INDEX_URL, { headers: { 'User-Agent': 'Clopen-Skills' } });
	if (!res.ok) throw new Error(`Failed to load the skills registry (HTTP ${res.status}).`);
	const json = await res.json() as { skills?: CommunityEntry[] } | CommunityEntry[];
	const entries = Array.isArray(json) ? json : (json.skills ?? []);
	communityCache = { entries, at: Date.now() };
	return entries;
}

/**
 * Split an install path into `[owner, repo, ...folder]`, dropping a trailing
 * `SKILL.md` — index entries are inconsistent: some point at the folder, some
 * at the file itself.
 */
function installParts(installPath: string): string[] {
	const parts = installPath.replace(/^https?:\/\/github\.com\//, '').split('/').filter(Boolean);
	if (parts[parts.length - 1] === 'SKILL.md') parts.pop();
	return parts;
}

/** A usable skill name — some entries are labelled `unknown`; fall back to the folder. */
function skillName(e: CommunityEntry): string {
	if (e.name && e.name !== 'unknown') return e.name;
	const parts = installParts(e.install ?? '');
	return parts[parts.length - 1] || 'unknown';
}

/** Build a browseable GitHub URL for a community install path (`owner/repo/path`). */
function homepageUrl(installPath: string, branch?: string): string {
	const [owner, repo, ...rest] = installParts(installPath);
	const base = `https://github.com/${owner}/${repo}`;
	return rest.length > 0 ? `${base}/tree/${branch || 'HEAD'}/${rest.join('/')}` : base;
}

function mapSkill(e: CommunityEntry): MarketplaceSkill {
	const name = skillName(e);
	return {
		ref: `community:${e.install}`,
		name,
		slug: name,
		description: e.description ?? '',
		stars: e.stars,
		verified: e.security_status === 'passed' && e.install_status === 'known_good',
		homepage: homepageUrl(e.install!, e.branch)
	};
}

/** Resolve a community install path (`owner/repo/path/to/skill`) to a raw SKILL.md URL. */
function rawSkillUrl(installPath: string): string | null {
	const [owner, repo, ...rest] = installParts(installPath);
	if (!owner || !repo) return null;
	const path = rest.length > 0 ? `${rest.join('/')}/SKILL.md` : 'SKILL.md';
	return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${path}`;
}

/**
 * Collapse entries that are the same skill in the same repo but copied into
 * several folders (e.g. `development/`, `.claude/skills/`, `data/`). Same name
 * across *different* repos is kept — those are distinct implementations.
 */
function dedupe(entries: CommunityEntry[]): CommunityEntry[] {
	const isCanonical = (install?: string) => (install?.includes('/.claude/skills/') ? 0 : 1);
	const best = new Map<string, CommunityEntry>();
	for (const e of entries) {
		if (!e.install) continue;
		const parts = installParts(e.install);
		if (parts.length < 2) continue;
		const key = `${parts[0]}/${parts[1]}::${skillName(e).toLowerCase()}`;
		const current = best.get(key);
		if (!current || isCanonical(e.install) < isCanonical(current.install)) best.set(key, e);
	}
	return [...best.values()];
}

// ---------------------------------------------------------------------------
// Public facade
// ---------------------------------------------------------------------------

/**
 * Browse the catalog (paginated, name/description filtered). Verified skills
 * sort first, then by stars.
 */
export async function listMarketplaceSkills(
	query: string,
	cursor: string | null
): Promise<MarketplacePage> {
	debug.log('skills', `🛒 marketplace list q="${query}" cursor=${cursor ?? '-'}`);
	let skills = dedupe(await getCommunityIndex()).map(mapSkill);

	const q = query.trim().toLowerCase();
	if (q) skills = skills.filter(s => `${s.name} ${s.description}`.toLowerCase().includes(q));
	skills.sort((a, b) =>
		(a.verified ? 0 : 1) - (b.verified ? 0 : 1) ||
		(b.stars ?? 0) - (a.stars ?? 0) ||
		a.name.localeCompare(b.name)
	);

	const offset = cursor ? Number(cursor) || 0 : 0;
	const page = skills.slice(offset, offset + PAGE_SIZE);
	const next = offset + PAGE_SIZE < skills.length ? String(offset + PAGE_SIZE) : null;
	return { skills: page, nextCursor: next };
}

/** Download a skill's SKILL.md from the registry for installation. */
export async function fetchMarketplaceSkill(ref: string): Promise<FetchedSkill> {
	if (!ref.startsWith('community:')) throw new Error(`Unknown marketplace reference: ${ref}`);
	const url = rawSkillUrl(ref.slice('community:'.length));
	if (!url) throw new Error('This skill has no resolvable SKILL.md location.');
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Could not download SKILL.md (HTTP ${res.status}).`);
	return { skillMd: await res.text(), resources: [] };
}
