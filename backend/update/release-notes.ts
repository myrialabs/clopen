/**
 * Clopen's GitHub releases, turned into something a user can read.
 *
 * Release bodies are GitHub's auto-generated notes — one line per pull
 * request, `* fix(db): stop message saves stalling by @someone in <url>` —
 * which is written for the people who build Clopen. Each line becomes a
 * ReleaseChange: the commit type picks the group (New / Improved / Fixed),
 * the scope becomes a tag, the author handle goes and the pull-request URL
 * shrinks to its number. Anything hand-written that is not a change entry is
 * kept as markdown so nothing a maintainer typed is lost.
 */

import type { ReleaseChange, ReleaseChangeKind, ReleaseNote } from '$shared/types/release-notes';
import { stripVersionPrefix } from '$shared/utils/semver';

const RELEASES_URL = 'https://api.github.com/repos/myrialabs/clopen/releases?per_page=30';

const KIND_BY_TYPE: Record<string, ReleaseChangeKind> = {
	feat: 'feature',
	feature: 'feature',
	perf: 'improvement',
	fix: 'fix',
	revert: 'fix'
};

/** `* type(scope)!: summary by @author in https://…/pull/123` — every part after the bullet optional. */
const CHANGE_LINE =
	/^[*-]\s+(?:(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s+)?(?<summary>.+?)(?:\s+by\s+@[\w.-]+)?(?:\s+in\s+<?(?<url>https:\/\/github\.com\/\S+?\/pull\/(?<number>\d+))>?)?\s*$/;

/** `* @someone made their first contribution in https://…` */
const CONTRIBUTOR_LINE = /^[*-]\s+@(?<login>[\w.-]+)\s+made their first contribution/;

const FULL_CHANGELOG_LINE = /^\*\*Full Changelog\*\*:/;
const HEADING = /^#{1,6}\s+(?<title>.+?)\s*$/;

function capitalise(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export function parseChangeLine(line: string): ReleaseChange | null {
	const match = CHANGE_LINE.exec(line.trim());
	if (!match?.groups) return null;
	const { type, scope, bang, summary, url, number } = match.groups;
	const kind = type ? (KIND_BY_TYPE[type] ?? 'other') : 'other';
	return {
		kind,
		...(scope ? { scope } : {}),
		summary: capitalise(summary.trim()),
		breaking: bang === '!',
		...(url ? { pullUrl: url, pullNumber: Number(number) } : {})
	};
}

export function parseReleaseBody(body: string): Pick<ReleaseNote, 'changes' | 'newContributors' | 'notes'> {
	const changes: ReleaseChange[] = [];
	const newContributors: string[] = [];
	const notes: string[] = [];
	let section = '';

	for (const raw of body.replace(/\r\n/g, '\n').split('\n')) {
		const line = raw.trimEnd();
		const heading = HEADING.exec(line.trim());
		if (heading?.groups) {
			section = heading.groups.title.toLowerCase();
			// The generated headings are structure, not content — the UI draws its own.
			if (section === "what's changed" || section === 'new contributors') continue;
			notes.push(line);
			continue;
		}
		if (FULL_CHANGELOG_LINE.test(line.trim())) continue;

		if (section === 'new contributors') {
			const contributor = CONTRIBUTOR_LINE.exec(line.trim());
			if (contributor?.groups) {
				newContributors.push(contributor.groups.login);
				continue;
			}
		}

		if (section === "what's changed" && /^[*-]\s/.test(line.trim())) {
			const change = parseChangeLine(line);
			if (change) {
				changes.push(change);
				continue;
			}
		}

		notes.push(line);
	}

	return { changes, newContributors, notes: notes.join('\n').trim() };
}

interface GitHubRelease {
	tag_name: string;
	html_url: string;
	published_at: string | null;
	body: string | null;
	draft: boolean;
	prerelease: boolean;
}

export function toReleaseNote(release: GitHubRelease): ReleaseNote {
	return {
		version: stripVersionPrefix(release.tag_name),
		tagName: release.tag_name,
		url: release.html_url,
		publishedAt: release.published_at ?? '',
		...parseReleaseBody(release.body ?? '')
	};
}

/**
 * The repository also publishes releases that are not Clopen versions — the
 * Memory Graph's embedding model ships as `embedding-v0.0.1` — so only tags
 * that are an app version count.
 */
const APP_VERSION_TAG = /^v?\d+\.\d+\.\d+$/;

export function isAppRelease(release: Pick<GitHubRelease, 'tag_name' | 'draft' | 'prerelease'>): boolean {
	return !release.draft && !release.prerelease && APP_VERSION_TAG.test(release.tag_name);
}

/** Newest first, published app releases only. */
export async function fetchReleaseNotes(): Promise<ReleaseNote[]> {
	const response = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
	if (!response.ok) {
		throw new Error(`GitHub API returned ${response.status}`);
	}
	const releases = await response.json() as GitHubRelease[];
	return releases.filter(isAppRelease).map(toReleaseNote);
}
