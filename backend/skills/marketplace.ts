/**
 * Skill marketplace — provider abstraction for browsing and installing skills
 * from external sources.
 *
 * Two providers ship by default:
 *   - `official`  — Anthropic's curated `anthropics/skills` repo. Trusted, small,
 *                   shown by default. Enumerated via one GitHub Git-Trees request;
 *                   SKILL.md + bundled resources are fetched from raw.githubusercontent.
 *   - `community` — the community `claude-skill-registry` lite index (a single
 *                   daily-updated JSON catalog). Broad but third-party, so it sits
 *                   behind a source selector. SKILL.md only (the lite index carries
 *                   no file manifest).
 *
 * Every install resolves to raw SKILL.md text that the skill service validates
 * against the open spec before writing — no provider output is trusted blindly.
 */

import { parseSkillMd } from './spec';
import { debug } from '$shared/utils/logger';

export type ProviderId = 'official' | 'community';

/** A skill as listed in the marketplace browse view. */
export interface MarketplaceSkill {
	/** Provider-scoped id stored as `marketplace_ref`, e.g. `official:pdf-processing`. */
	ref: string;
	provider: ProviderId;
	name: string;
	slug: string;
	description: string;
	stars?: number;
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
const OFFICIAL_REPO = 'anthropics/skills';
const OFFICIAL_BRANCH = 'main';
const COMMUNITY_INDEX_URL = 'https://majiayu000.github.io/claude-skill-registry-core/search-index-lite.json';

const UA = { 'User-Agent': 'Clopen-Skills', Accept: 'application/vnd.github+json' };

function rawUrl(repo: string, branch: string, path: string): string {
	return `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
}

// ---------------------------------------------------------------------------
// Official provider — anthropics/skills
// ---------------------------------------------------------------------------

interface GitTreeEntry { path: string; type: string }

let officialTreeCache: { entries: GitTreeEntry[]; at: number } | null = null;

/** Fetch (and briefly cache) the full repo tree so browse costs one API request. */
async function getOfficialTree(): Promise<GitTreeEntry[]> {
	if (officialTreeCache && Date.now() - officialTreeCache.at < 5 * 60_000) {
		return officialTreeCache.entries;
	}
	const url = `https://api.github.com/repos/${OFFICIAL_REPO}/git/trees/${OFFICIAL_BRANCH}?recursive=1`;
	const res = await fetch(url, { headers: UA });
	if (!res.ok) {
		throw new Error(
			res.status === 403
				? 'GitHub rate limit reached while loading the official skills catalog. Try again shortly.'
				: `Failed to load the official skills catalog (HTTP ${res.status}).`
		);
	}
	const json = await res.json() as { tree?: GitTreeEntry[] };
	const entries = json.tree ?? [];
	officialTreeCache = { entries, at: Date.now() };
	return entries;
}

/** Each skill is the folder directly containing a SKILL.md (under `skills/`). */
function officialSkillDirs(tree: GitTreeEntry[]): { dir: string; name: string }[] {
	const dirs: { dir: string; name: string }[] = [];
	for (const entry of tree) {
		if (entry.type !== 'blob') continue;
		if (!entry.path.startsWith('skills/') || !entry.path.endsWith('/SKILL.md')) continue;
		const dir = entry.path.slice(0, -'/SKILL.md'.length);
		dirs.push({ dir, name: dir.split('/').pop()! });
	}
	return dirs.sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchDescription(dir: string): Promise<string> {
	try {
		const res = await fetch(rawUrl(OFFICIAL_REPO, OFFICIAL_BRANCH, `${dir}/SKILL.md`));
		if (!res.ok) return '';
		return parseSkillMd(await res.text()).frontmatter.description;
	} catch {
		return '';
	}
}

async function listOfficial(query: string, cursor: string | null): Promise<MarketplacePage> {
	const tree = await getOfficialTree();
	const all = officialSkillDirs(tree);
	const q = query.trim().toLowerCase();
	const filtered = q ? all.filter(s => s.name.toLowerCase().includes(q)) : all;
	const offset = cursor ? Number(cursor) || 0 : 0;
	const slice = filtered.slice(offset, offset + PAGE_SIZE);
	// Descriptions are fetched only for the current page to stay responsive.
	const descriptions = await Promise.all(slice.map(s => fetchDescription(s.dir)));
	const skills: MarketplaceSkill[] = slice.map((s, i) => ({
		ref: `official:${s.dir}`,
		provider: 'official',
		name: s.name,
		slug: s.name,
		description: descriptions[i],
		homepage: `https://github.com/${OFFICIAL_REPO}/tree/${OFFICIAL_BRANCH}/${s.dir}`
	}));
	const next = offset + PAGE_SIZE < filtered.length ? String(offset + PAGE_SIZE) : null;
	return { skills, nextCursor: next };
}

async function fetchOfficial(ref: string): Promise<FetchedSkill> {
	const dir = ref.slice('official:'.length);
	const skillRes = await fetch(rawUrl(OFFICIAL_REPO, OFFICIAL_BRANCH, `${dir}/SKILL.md`));
	if (!skillRes.ok) throw new Error(`Could not download SKILL.md (HTTP ${skillRes.status}).`);
	const skillMd = await skillRes.text();
	// Pull any bundled resource files that live under the skill folder so the
	// installed skill is self-contained (scripts/, references/, assets/, …).
	const tree = await getOfficialTree();
	const resourcePaths = tree
		.filter(e => e.type === 'blob' && e.path.startsWith(`${dir}/`) && e.path !== `${dir}/SKILL.md`)
		.map(e => e.path)
		.slice(0, 50);
	const resources: { path: string; content: string }[] = [];
	await Promise.all(resourcePaths.map(async p => {
		try {
			const r = await fetch(rawUrl(OFFICIAL_REPO, OFFICIAL_BRANCH, p));
			if (r.ok) resources.push({ path: p.slice(dir.length + 1), content: await r.text() });
		} catch { /* best-effort */ }
	}));
	return { skillMd, resources };
}

// ---------------------------------------------------------------------------
// Community provider — claude-skill-registry lite index
// ---------------------------------------------------------------------------

interface CommunityEntry { n?: string; d?: string; r?: number; i?: string }

let communityCache: { entries: CommunityEntry[]; at: number } | null = null;

async function getCommunityIndex(): Promise<CommunityEntry[]> {
	if (communityCache && Date.now() - communityCache.at < 10 * 60_000) return communityCache.entries;
	const res = await fetch(COMMUNITY_INDEX_URL, { headers: { 'User-Agent': 'Clopen-Skills' } });
	if (!res.ok) throw new Error(`Failed to load the community skills registry (HTTP ${res.status}).`);
	const json = await res.json() as { skills?: CommunityEntry[] } | CommunityEntry[];
	const entries = Array.isArray(json) ? json : (json.skills ?? []);
	communityCache = { entries, at: Date.now() };
	return entries;
}

/** Resolve a community install path (`owner/repo/path/to/skill`) to a raw SKILL.md URL. */
function communityRawUrl(installPath: string): string | null {
	const parts = installPath.replace(/^https?:\/\/github\.com\//, '').split('/').filter(Boolean);
	if (parts.length < 2) return null;
	const [owner, repo, ...rest] = parts;
	const path = rest.length > 0 ? `${rest.join('/')}/SKILL.md` : 'SKILL.md';
	return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${path}`;
}

async function listCommunity(query: string, cursor: string | null): Promise<MarketplacePage> {
	const entries = await getCommunityIndex();
	const q = query.trim().toLowerCase();
	const filtered = entries.filter(e => {
		if (!e.i || !e.n) return false;
		if (!q) return true;
		return `${e.n} ${e.d ?? ''}`.toLowerCase().includes(q);
	});
	const offset = cursor ? Number(cursor) || 0 : 0;
	const slice = filtered.slice(offset, offset + PAGE_SIZE);
	const skills: MarketplaceSkill[] = slice.map(e => ({
		ref: `community:${e.i}`,
		provider: 'community',
		name: e.n!,
		slug: e.n!,
		description: e.d ?? '',
		stars: e.r,
		homepage: `https://github.com/${e.i!.replace(/^https?:\/\/github\.com\//, '')}`
	}));
	const next = offset + PAGE_SIZE < filtered.length ? String(offset + PAGE_SIZE) : null;
	return { skills, nextCursor: next };
}

async function fetchCommunity(ref: string): Promise<FetchedSkill> {
	const installPath = ref.slice('community:'.length);
	const url = communityRawUrl(installPath);
	if (!url) throw new Error('This community skill has no resolvable SKILL.md location.');
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Could not download SKILL.md (HTTP ${res.status}).`);
	return { skillMd: await res.text(), resources: [] };
}

// ---------------------------------------------------------------------------
// Public facade
// ---------------------------------------------------------------------------

export const SKILL_PROVIDERS: { id: ProviderId; label: string }[] = [
	{ id: 'official', label: 'Official' },
	{ id: 'community', label: 'Community' }
];

/** Browse a provider's catalog (paginated, name/description filtered). */
export async function listMarketplaceSkills(
	provider: ProviderId,
	query: string,
	cursor: string | null
): Promise<MarketplacePage> {
	debug.log('skills', `🛒 marketplace list ${provider} q="${query}" cursor=${cursor ?? '-'}`);
	return provider === 'community' ? listCommunity(query, cursor) : listOfficial(query, cursor);
}

/** Download a skill's SKILL.md (+ resources) from its provider for installation. */
export async function fetchMarketplaceSkill(ref: string): Promise<FetchedSkill> {
	if (ref.startsWith('community:')) return fetchCommunity(ref);
	if (ref.startsWith('official:')) return fetchOfficial(ref);
	throw new Error(`Unknown marketplace reference: ${ref}`);
}
