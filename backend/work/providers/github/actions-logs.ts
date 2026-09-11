/**
 * Pulling a failing Actions run's logs into something a prompt can carry.
 *
 * Two decisions worth stating.
 *
 * FAILED JOBS ONLY, VIA THE PER-JOB ENDPOINT. The run-level endpoint hands back
 * a zip of every job's log, including the twelve that passed. Listing the jobs
 * and fetching only the failed ones is one extra request and avoids unzipping
 * megabytes to throw almost all of it away.
 *
 * THE TAIL, NOT THE HEAD. A CI log's first 500 lines are dependency
 * installation; the failure is at the end. Truncating from the front is the one
 * way to produce a log excerpt that contains no information about the failure,
 * so this keeps the tail and says how much it dropped.
 */

import type { CheckLogBundle } from '$shared/types/work';
import { apiBaseOf, githubRequest, GitHubError, type GitHubCredentials } from './client';
import { debug } from '$shared/utils/logger';

/** Total log text handed to the model, across every failed job in the run. */
const TOTAL_LOG_BUDGET = 24 * 1024;
/** Per job, so one catastrophic job cannot crowd out the other three. */
const PER_JOB_BUDGET = 12 * 1024;
const LOG_TIMEOUT_MS = 30_000;

interface GitHubJob {
	id: number;
	name: string;
	conclusion: string | null;
	status: string;
	html_url: string | null;
	steps?: { name: string; conclusion: string | null; number: number }[];
}

/**
 * Fetch one job's log as text.
 *
 * `redirect: 'manual'` is not a detail. GitHub answers with a 302 to a signed
 * storage URL, and that URL carries its own credentials in the query string.
 * Following automatically would replay our `Authorization: Bearer` header at a
 * third-party host — leaking the token to a service that has no business seeing
 * it, and which will reject the request for having two credentials anyway.
 */
async function fetchJobLog(credentials: GitHubCredentials, jobId: number): Promise<string> {
	const url = `${apiBaseOf(credentials)}/actions/jobs/${jobId}/logs`;

	const response = await fetch(url, {
		headers: {
			Accept: 'application/vnd.github+json',
			Authorization: `Bearer ${credentials.token}`,
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'clopen'
		},
		redirect: 'manual',
		signal: AbortSignal.timeout(LOG_TIMEOUT_MS)
	});

	if (response.status >= 300 && response.status < 400) {
		const location = response.headers.get('location');
		if (!location) throw new GitHubError('GitHub returned a redirect with no location', response.status, 'error');
		const followed = await fetch(location, { signal: AbortSignal.timeout(LOG_TIMEOUT_MS) });
		if (!followed.ok) {
			throw new GitHubError(`Could not download the job log (HTTP ${followed.status})`, followed.status, 'error');
		}
		return followed.text();
	}

	if (!response.ok) {
		// Logs expire, and a repo can disable log retention entirely. Both are
		// normal states, not failures of this feature.
		throw new GitHubError(
			response.status === 410
				? 'These logs have expired and are no longer stored by GitHub'
				: `Could not read the job log (HTTP ${response.status})`,
			response.status,
			response.status === 401 ? 'auth' : 'error'
		);
	}

	return response.text();
}

/** Keep the last `limit` bytes, cut on a line boundary, and say what was dropped. */
function keepTail(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	const tail = text.slice(text.length - limit);
	const firstNewline = tail.indexOf('\n');
	const body = firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;
	const droppedLines = text.slice(0, text.length - body.length).split('\n').length;
	return {
		text: `… ${droppedLines} earlier line${droppedLines === 1 ? '' : 's'} omitted …\n${body}`,
		truncated: true
	};
}

/**
 * Actions prefixes every line with an ISO timestamp and wraps output in
 * `##[group]` markers. Both are pure noise in a prompt and together they are
 * roughly a quarter of the bytes, which is a quarter of the budget spent on
 * nothing.
 */
function stripActionsNoise(text: string): string {
	return text
		.split('\n')
		.map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ''))
		.filter((line) => !/^##\[(group|endgroup)\]/.test(line))
		.join('\n')
		.trimEnd();
}

/**
 * Logs for the failed jobs of one run, budgeted and annotated.
 *
 * Returns a bundle even when every job's log has expired: the run name and the
 * list of failed steps still tell the agent what broke, and an empty answer
 * would look like the feature not working.
 */
export async function buildRunLogBundle(
	credentials: GitHubCredentials,
	locator: string,
	runId: string,
	runName: string
): Promise<CheckLogBundle> {
	const jobs = await githubRequest<{ jobs: GitHubJob[] }>(
		credentials,
		`/repos/${locator}/actions/runs/${runId}/jobs?per_page=100`,
		{ noCache: true }
	);

	const failed = (jobs.data?.jobs ?? []).filter(
		(job) => job.conclusion === 'failure' || job.conclusion === 'timed_out'
	);

	if (failed.length === 0) {
		return {
			runId,
			runName,
			text: 'The run reported a failure but no individual job failed — this is usually a cancelled or infrastructure-level failure.',
			truncated: false
		};
	}

	const sections: string[] = [];
	let used = 0;
	let truncated = false;

	for (const job of failed) {
		const failedSteps = (job.steps ?? [])
			.filter((step) => step.conclusion === 'failure')
			.map((step) => step.name);

		const header = failedSteps.length > 0
			? `### Job "${job.name}" — failed at: ${failedSteps.join(', ')}`
			: `### Job "${job.name}" — failed`;

		if (used >= TOTAL_LOG_BUDGET) {
			sections.push(`${header}\n(log omitted — the earlier jobs used the available context)`);
			truncated = true;
			continue;
		}

		let body: string;
		try {
			const raw = stripActionsNoise(await fetchJobLog(credentials, job.id));
			const limit = Math.min(PER_JOB_BUDGET, TOTAL_LOG_BUDGET - used);
			const clipped = keepTail(raw, limit);
			if (clipped.truncated) truncated = true;
			body = clipped.text;
			used += clipped.text.length;
		} catch (error) {
			debug.warn('work', `Could not read log for job ${job.id}:`, error);
			body = `(log unavailable: ${error instanceof Error ? error.message : String(error)})`;
		}

		sections.push(`${header}\n\n\`\`\`\n${body}\n\`\`\``);
	}

	return { runId, runName, text: sections.join('\n\n'), truncated };
}
