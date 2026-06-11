import type { ToolId } from './install-recipes';

export interface UpdateCheckResult {
	latestVersion: string | null;
	/** true = newer available, false = already latest, null = could not determine */
	hasUpdate: boolean | null;
}

type VersionSource =
	| { type: 'npm'; pkg: string }
	| { type: 'homebrew-formula'; formula: string }
	| { type: 'github-release'; repo: string }
	| { type: 'chrome-for-testing' };

const SOURCES: Record<ToolId, VersionSource> = {
	claude:   { type: 'npm',               pkg:     '@anthropic-ai/claude-code' },
	opencode: { type: 'npm',               pkg:     'opencode-ai' },
	copilot:  { type: 'npm',               pkg:     '@github/copilot' },
	codex:    { type: 'npm',               pkg:     '@openai/codex' },
	qwen:     { type: 'npm',               pkg:     '@qwen-code/qwen-code' },
	git:      { type: 'homebrew-formula',  formula: 'git' },
	chrome:   { type: 'chrome-for-testing' },
};

// ─── version helpers ──────────────────────────────────────────────────────────

function extractVersion(str: string): string | null {
	const m = str.match(/(\d+(?:\.\d+)+)/);
	return m ? m[1] : null;
}

function versionGt(a: string, b: string): boolean {
	const av = a.split('.').map(Number);
	const bv = b.split('.').map(Number);
	const len = Math.max(av.length, bv.length);
	for (let i = 0; i < len; i++) {
		if ((av[i] ?? 0) > (bv[i] ?? 0)) return true;
		if ((av[i] ?? 0) < (bv[i] ?? 0)) return false;
	}
	return false;
}

// ─── fetchers ─────────────────────────────────────────────────────────────────

async function fetchNpmLatest(pkg: string): Promise<string | null> {
	try {
		const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`, {
			headers: { Accept: 'application/json' },
			signal: AbortSignal.timeout(10_000)
		});
		if (!res.ok) return null;
		const json = await res.json() as { version?: unknown };
		return typeof json.version === 'string' ? json.version : null;
	} catch {
		return null;
	}
}

/**
 * Homebrew formula API — no auth, no rate limit, tracks upstream releases
 * tightly. Used as the primary source for git since the GitHub API has a
 * low unauthenticated rate limit.
 */
async function fetchHomebrewLatest(formula: string): Promise<string | null> {
	try {
		const res = await fetch(`https://formulae.brew.sh/api/formula/${encodeURIComponent(formula)}.json`, {
			headers: { Accept: 'application/json' },
			signal: AbortSignal.timeout(10_000)
		});
		if (!res.ok) return null;
		const json = await res.json() as { versions?: { stable?: unknown } };
		const v = json.versions?.stable;
		return typeof v === 'string' ? v : null;
	} catch {
		return null;
	}
}

async function fetchGitHubLatest(repo: string): Promise<string | null> {
	try {
		const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
			headers: {
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': 'clopen-version-checker'
			},
			signal: AbortSignal.timeout(10_000)
		});
		if (!res.ok) return null;
		const json = await res.json() as { tag_name?: unknown };
		const tag = json.tag_name;
		if (typeof tag !== 'string') return null;
		return tag.startsWith('v') ? tag.slice(1) : tag;
	} catch {
		return null;
	}
}

async function fetchChromeLatest(): Promise<string | null> {
	try {
		const res = await fetch(
			'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json',
			{ signal: AbortSignal.timeout(10_000) }
		);
		if (!res.ok) return null;
		const json = await res.json() as { channels?: { Stable?: { version?: unknown } } };
		const v = json.channels?.Stable?.version;
		return typeof v === 'string' ? v : null;
	} catch {
		return null;
	}
}

// ─── public API ───────────────────────────────────────────────────────────────

export async function checkToolUpdate(
	tool: ToolId,
	installedVersion: string | null
): Promise<UpdateCheckResult> {
	const source = SOURCES[tool];

	let latestVersion: string | null;
	switch (source.type) {
		case 'npm':
			latestVersion = await fetchNpmLatest(source.pkg);
			break;
		case 'homebrew-formula':
			latestVersion = await fetchHomebrewLatest(source.formula);
			break;
		case 'github-release':
			latestVersion = await fetchGitHubLatest(source.repo);
			break;
		case 'chrome-for-testing':
			latestVersion = await fetchChromeLatest();
			break;
	}

	if (!latestVersion) return { latestVersion: null, hasUpdate: null };
	if (!installedVersion) return { latestVersion, hasUpdate: null };

	const current = extractVersion(installedVersion);
	if (!current) return { latestVersion, hasUpdate: null };

	return { latestVersion, hasUpdate: versionGt(latestVersion, current) };
}
