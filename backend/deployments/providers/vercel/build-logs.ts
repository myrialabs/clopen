/**
 * Build logs — the bundle a prompt carries, and the live follow.
 *
 * THE TAIL, NOT THE HEAD, for exactly the reason the Actions log reader keeps
 * the tail: a build log's first hundreds of lines are dependency installation,
 * and truncating from the front is the one way to produce an excerpt that
 * contains no information about the failure.
 *
 * Only the lines a reader would care about survive. Vercel's event stream also
 * carries `deployment-state`, `metric` and invocation records, which say
 * nothing about why a build broke and would spend the budget saying it.
 */

import type { BuildLogBundle } from '$shared/types/deployments';
import { vercelEventStream, vercelRequest, VercelError, type VercelCredentials } from './client';
import type { VercelEvent } from './types';
import type { LogStreamCallbacks, LogStreamHandle } from '../../types';
import { debug } from '$shared/utils/logger';

/** Log text handed to the model. Roughly the same budget the CI reader uses. */
const LOG_BUDGET = 24 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/** Event types that carry build output a human would read. */
const OUTPUT_TYPES = new Set(['stdout', 'stderr', 'command', 'fatal', 'exit']);

/**
 * A human name for the stage a `deployment-state` event reports.
 *
 * These events are dropped from the log text — they are not output — but they
 * are the only thing that speaks during the quiet parts of a build, so they are
 * forwarded as a phase instead of discarded.
 */
const PHASE_LABELS: Record<string, string> = {
	QUEUED: 'Queued',
	INITIALIZING: 'Initializing',
	BUILDING: 'Building',
	UPLOADING: 'Uploading',
	DEPLOYING: 'Deploying',
	ANALYZING: 'Analyzing',
	READY: 'Ready',
	ERROR: 'Failed',
	CANCELED: 'Cancelled'
};

/** The stage this event reports, or null when it reports none. */
export function phaseOf(event: VercelEvent): string | null {
	if (event.type !== 'deployment-state') return null;
	const info = (event as { info?: { readyState?: string; step?: string; name?: string } }).info
		?? (event.payload as { info?: { readyState?: string; step?: string; name?: string } } | undefined)?.info;

	const state = info?.readyState?.toUpperCase();
	if (state && PHASE_LABELS[state]) return PHASE_LABELS[state];
	// Some events name a build step instead of a state — still more useful than
	// silence, so it is passed through as written.
	return info?.step || null;
}

function textOf(event: VercelEvent): string | null {
	if (!event.type || !OUTPUT_TYPES.has(event.type)) return null;
	const text = event.text ?? event.payload?.text;
	return typeof text === 'string' && text.length > 0 ? text : null;
}

/** Keep the last `limit` bytes, cut on a line boundary, and say what was dropped. */
export function keepTail(text: string, limit: number): { text: string; truncated: boolean } {
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
 * The whole log as one budgeted bundle.
 *
 * Without `follow` the same endpoint answers with a plain JSON array, which is
 * what makes one reader serve both the chat prompt and a finished build's log
 * view. `limit: -1` asks for everything, and the budget above is what actually
 * bounds it.
 */
export async function fetchBuildLogs(
	credentials: VercelCredentials,
	deploymentId: string,
	teamId: string | null
): Promise<BuildLogBundle> {
	const response = await vercelRequest<VercelEvent[]>(
		credentials,
		`/v3/deployments/${encodeURIComponent(deploymentId)}/events`,
		{ query: { builds: 1, limit: -1, direction: 'forward', teamId: teamId ?? undefined } }
	);

	const lines: string[] = [];
	for (const event of response.data ?? []) {
		const text = textOf(event);
		if (text !== null) lines.push(text.replace(/\n$/, ''));
	}

	if (lines.length === 0) {
		return {
			deploymentId,
			// An empty log is a real state, not a failure: Vercel drops build
			// events after a retention window, and a deployment that never began
			// building never wrote any.
			text: 'No build output is stored for this deployment. It may have been skipped, cancelled before the build started, or its logs may have aged out.',
			truncated: false
		};
	}

	const clipped = keepTail(lines.join('\n'), LOG_BUDGET);
	return { deploymentId, text: clipped.text, truncated: clipped.truncated };
}

/**
 * Follow a running build.
 *
 * The response body is newline-delimited JSON that never ends on its own, so
 * the only way out is the abort signal — which is why the handle returned here
 * is the stream manager's sole means of cleaning up. A partial line at the end
 * of a chunk is held back rather than parsed, because network chunk boundaries
 * fall wherever they like and half a JSON object parses as nothing.
 */
export async function streamBuildLogs(
	credentials: VercelCredentials,
	deploymentId: string,
	teamId: string | null,
	callbacks: LogStreamCallbacks
): Promise<LogStreamHandle> {
	const controller = new AbortController();
	const response = await vercelEventStream(credentials, deploymentId, {
		teamId,
		signal: controller.signal
	});

	const body = response.body;
	if (!body) {
		controller.abort();
		throw new VercelError('Vercel returned no log stream', response.status, 'error');
	}

	void pump(body, callbacks, controller);
	return { stop: () => controller.abort() };
}

async function pump(
	body: ReadableStream<Uint8Array>,
	callbacks: LogStreamCallbacks,
	controller: AbortController
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let ended = false;
	let lastPhase: string | null = null;

	const end = (error: string | null): void => {
		if (ended) return;
		ended = true;
		callbacks.onEnd(error);
	};

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			// The last element is whatever came after the final newline: either an
			// empty string or half an event. Either way it waits for more bytes.
			buffer = lines.pop() ?? '';

			const out: string[] = [];
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line) as VercelEvent;

					const phase = phaseOf(event);
					// Only on a CHANGE: these repeat, and re-announcing the same stage
					// would read as progress that is not happening.
					if (phase && phase !== lastPhase) {
						lastPhase = phase;
						callbacks.onPhase?.(phase);
					}

					const text = textOf(event);
					if (text !== null) out.push(text.replace(/\n$/, ''));
				} catch {
					// A line that is not JSON is not worth killing the stream over.
					debug.log('deployments', 'Skipped an unparseable log line');
				}
			}
			if (out.length > 0) callbacks.onChunk(`${out.join('\n')}\n`);
		}
		end(null);
	} catch (error) {
		// An abort is how this stream is meant to finish, so it is not an error.
		if (controller.signal.aborted) end(null);
		else end(error instanceof Error ? error.message : String(error));
	} finally {
		reader.releaseLock();
	}
}

export { FETCH_TIMEOUT_MS };
