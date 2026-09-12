/**
 * Following a running build's logs.
 *
 * A follow is an HTTP response that never ends, which is the one thing an
 * ordinary request path cannot carry — it would read the body to completion and
 * block forever. So it gets its own manager, and pays for that with hard
 * limits: a bounded number of concurrent streams, a bounded ring buffer per
 * stream, and an owner whose socket closing takes the stream with it.
 *
 * Output is coalesced and flushed on a short interval rather than pushed per
 * chunk, the same way container logs are. A build emits hundreds of tiny
 * writes, and one WebSocket frame each would cost more than the log is worth.
 *
 * One stream per user per deployment: a second tab watching the same build
 * joins the first rather than opening a second follow against the provider.
 */

import { deployService } from './service';
import { getDeployAdapter } from './registry';
import { ws } from '$backend/utils/ws';
import { debug } from '$shared/utils/logger';

/** Lines held for a viewer that joins a build already in progress. */
const BUFFER_LINES = 2_000;
/**
 * Streams one user may hold at once.
 *
 * Bounded because each one is an open socket against a metered API, and a user
 * who opens six builds in six tabs should not silently hold six follows.
 */
const MAX_STREAMS_PER_USER = 4;
/** How often buffered output is pushed to the client. */
const FLUSH_INTERVAL_MS = 150;

interface BuildLogStream {
	id: string;
	userId: string;
	deploymentId: string;
	buffer: string[];
	pending: string;
	/** Stage the provider last reported, rendered above the log. */
	phase: string | null;
	flushTimer: ReturnType<typeof setInterval> | null;
	stop: () => void;
	stopped: boolean;
}

const streams = new Map<string, BuildLogStream>();

function streamIdFor(userId: string, accountId: string, deploymentId: string): string {
	return `${userId}:${accountId}:${deploymentId}`;
}

function countForUser(userId: string): number {
	let count = 0;
	for (const stream of streams.values()) if (stream.userId === userId) count++;
	return count;
}

/**
 * Keep the ring bounded, counting lines rather than bytes so a trim never cuts
 * a line in half. Chunks arrive at arbitrary boundaries, so the first piece of
 * one continues whatever line the previous chunk left open.
 */
function appendToBuffer(stream: BuildLogStream, text: string): void {
	const lines = text.split('\n');
	if (stream.buffer.length > 0) {
		stream.buffer[stream.buffer.length - 1] += lines.shift() ?? '';
	}
	for (const line of lines) stream.buffer.push(line);
	if (stream.buffer.length > BUFFER_LINES) {
		stream.buffer.splice(0, stream.buffer.length - BUFFER_LINES);
	}
}

function flush(stream: BuildLogStream): void {
	if (!stream.pending) return;
	const data = stream.pending;
	stream.pending = '';
	ws.emit.user(stream.userId, 'deployments:log-chunk', {
		streamId: stream.id,
		deploymentId: stream.deploymentId,
		data,
		...(stream.phase && { phase: stream.phase })
	});
}

function finish(stream: BuildLogStream, error: string | null): void {
	if (stream.stopped) return;
	stream.stopped = true;
	flush(stream);
	if (stream.flushTimer) clearInterval(stream.flushTimer);
	streams.delete(stream.id);
	ws.emit.user(stream.userId, 'deployments:log-chunk', {
		streamId: stream.id,
		deploymentId: stream.deploymentId,
		data: '',
		done: true,
		error
	});
}

export interface StartedBuildLogStream {
	streamId: string;
	/** Whatever the ring already holds, for a viewer joining late. */
	backlog: string;
}

/**
 * Start following a build, or join the stream already following it.
 *
 * The capability is checked before anything is opened: a provider without
 * `streamLogs` must fall back to the fetched bundle on the client, and
 * discovering that after a socket is open is a stream that immediately ends.
 */
export async function startBuildLogStream(
	projectId: string,
	accountId: string,
	deploymentId: string,
	userId: string
): Promise<StartedBuildLogStream> {
	const id = streamIdFor(userId, accountId, deploymentId);
	const existing = streams.get(id);
	// Rejoined with the newlines the buffer strips, or the whole backlog would
	// arrive as one enormous line.
	if (existing) return { streamId: id, backlog: existing.buffer.join('\n') };

	const { adapter, context } = deployService.require(projectId, accountId);
	if (!adapter.capabilities.streamLogs || !adapter.streamLogs) {
		throw new Error(`${context.account.label} does not stream build logs`);
	}

	if (countForUser(userId) >= MAX_STREAMS_PER_USER) {
		throw new Error(
			`Already following ${MAX_STREAMS_PER_USER} builds. Close one before opening another.`
		);
	}

	const stream: BuildLogStream = {
		id,
		userId,
		deploymentId,
		buffer: [],
		pending: '',
		phase: null,
		flushTimer: null,
		stop: () => undefined,
		stopped: false
	};
	streams.set(id, stream);

	stream.flushTimer = setInterval(() => flush(stream), FLUSH_INTERVAL_MS);
	stream.flushTimer.unref?.();

	try {
		const handle = await adapter.streamLogs(context, deploymentId, {
			onChunk: (text) => {
				if (stream.stopped) return;
				appendToBuffer(stream, text);
				stream.pending += text;
			},
			onPhase: (phase) => {
				if (stream.stopped) return;
				stream.phase = phase;
				// Pushed immediately rather than on the flush interval: a phase
				// change is the only sign of life during the stretches of a build
				// that print nothing, so holding it back defeats its purpose.
				ws.emit.user(stream.userId, 'deployments:log-chunk', {
					streamId: stream.id,
					deploymentId: stream.deploymentId,
					data: '',
					phase
				});
			},
			onEnd: (error) => finish(stream, error)
		});
		stream.stop = handle.stop;
	} catch (error) {
		finish(stream, error instanceof Error ? error.message : String(error));
		throw error;
	}

	debug.log('deployments', `Following build logs for ${deploymentId}`);
	return { streamId: id, backlog: '' };
}

/** Stop one stream, if it belongs to this user. */
export function stopBuildLogStream(streamId: string, userId: string): void {
	const stream = streams.get(streamId);
	if (!stream || stream.userId !== userId) return;
	stream.stop();
	finish(stream, null);
}

/** Stop every stream a user holds, when their socket goes away. */
export function stopBuildLogStreamsForUser(userId: string): void {
	for (const stream of [...streams.values()]) {
		if (stream.userId === userId) {
			stream.stop();
			finish(stream, null);
		}
	}
}

/** Stop everything, when the process is shutting down. */
export function stopAllBuildLogStreams(): void {
	for (const stream of [...streams.values()]) {
		stream.stop();
		finish(stream, null);
	}
}

/** Exported for the adapter-capability check in tests. */
export { getDeployAdapter };
