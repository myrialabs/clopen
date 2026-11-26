/**
 * The GitLab REST client, shared by the hosting adapter and the Issues & PRs
 * adapter so both read one server root and one error vocabulary.
 *
 * `Authorization: Bearer` works for personal, project, group and OAuth tokens
 * alike, so nothing downstream needs to know how the account signed in.
 */

import type { WorkRateLimit } from '$shared/types/work';
import { hostRequest, rateLimitFrom, type HostRequestOptions } from '../http';
import { normaliseBaseUrl } from '../urls';

export const GITLAB_WEB_BASE = 'https://gitlab.com';

export function gitlabWebBase(credentials: Record<string, string>): string {
	return normaliseBaseUrl(credentials.baseUrl) || GITLAB_WEB_BASE;
}

export function gitlabApiBase(credentials: Record<string, string>): string {
	return `${gitlabWebBase(credentials)}/api/v4`;
}

/** A project path as the API wants it in a URL segment: `group%2Fsub%2Fname`. */
export function projectRef(locator: string): string {
	return encodeURIComponent(locator);
}

export interface GitLabResponse<T> {
	data: T;
	rateLimit: WorkRateLimit | null;
	nextPage: number | null;
	total: number | null;
}

export async function gitlabRequest<T>(
	credentials: Record<string, string>,
	path: string,
	options: HostRequestOptions = {}
): Promise<GitLabResponse<T>> {
	const url = path.startsWith('http') ? path : `${gitlabApiBase(credentials)}${path}`;
	const response = await hostRequest<T>('GitLab', url, {
		...options,
		headers: { Authorization: `Bearer ${credentials.token ?? ''}`, ...options.headers }
	});
	const next = response.headers.get('x-next-page');
	const total = response.headers.get('x-total');
	return {
		data: response.data,
		rateLimit: rateLimitFrom(response.headers),
		nextPage: next ? Number(next) : null,
		total: total ? Number(total) : null
	};
}

/** Follow `x-next-page` up to `maxPages`. */
export async function gitlabPaged<T>(
	credentials: Record<string, string>,
	path: string,
	maxPages = 3
): Promise<T[]> {
	const items: T[] = [];
	const joiner = path.includes('?') ? '&' : '?';
	let page: number | null = 1;
	for (let fetched = 0; fetched < maxPages && page; fetched += 1) {
		const response: GitLabResponse<T[]> = await gitlabRequest<T[]>(credentials, `${path}${joiner}per_page=100&page=${page}`);
		items.push(...(response.data ?? []));
		page = response.nextPage;
	}
	return items;
}
