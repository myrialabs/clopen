/**
 * Containers — following a container's output.
 *
 * `docker logs -f` never returns, which is the one thing the shared
 * `CommandRunner` cannot carry: locally it buffers a command to completion, and
 * remotely it queues commands one at a time on a connection the terminal and
 * file browser share — a follow would sit at the head of that queue forever. So
 * a stream gets its own channel on both transports, and pays for it with hard
 * limits: a bounded number of streams per host, and a bounded ring buffer per
 * stream so a container writing a megabyte a second cannot grow this process's
 * memory without limit.
 *
 * Output is coalesced and flushed on a short interval rather than pushed per
 * chunk. A build log arrives in hundreds of tiny writes, and one WebSocket
 * frame each would cost more than the log is worth.
 */

import type { Client as SshClient, ClientChannel } from 'ssh2';
import { CONTAINER_LOG_BUFFER_LINES } from '$shared/types/containers';
import { LOCAL_HOST_ID } from '$shared/types/host';
import { containerMonitor } from './monitor';
import { assertContainerId } from './actions';
import { containerArgv, detectRuntime } from './runtime';
import { localPlatform, type ProbePlatform } from '../host/runner';
import { detectRemotePlatform } from '../host/runner';
import { shellQuote } from '../ssh/connect';
import { sshClientPool, type SshLease } from '../ssh/client-pool';
import { sshConnectionQueries } from '../database/queries';
import { ws } from '../utils/ws';
import { debug } from '$shared/utils/logger';

/** Lines asked for when a stream opens, so the view is not blank. */
const TAIL_LINES = 500;
/**
 * Streams a single host may have open at once.
 *
 * Bounded for SSH's sake: every follow holds an exec channel, and sshd's
 * `MaxSessions` is ten by default — shared with the terminal, the file browser
 * and the port scan. Three leaves room for all of them.
 */
const MAX_STREAMS_PER_HOST = 3;
/** How often buffered output is pushed to the client. */
const FLUSH_INTERVAL_MS = 120;

interface LogStream {
	id: string;
	hostId: string;
	containerId: string;
	userId: string;
	/** The last N lines, so a reopened view is not empty while it waits. */
	buffer: string[];
	pending: string;
	flushTimer: ReturnType<typeof setInterval> | null;
	stop: () => void;
	stopped: boolean;
}

const streams = new Map<string, LogStream>();

/** One stream per user per container: a second tab joins the first. */
function streamIdFor(userId: string, hostId: string, containerId: string): string {
	return `${userId}:${hostId}:${containerId}`;
}

function countForHost(hostId: string): number {
	let count = 0;
	for (const stream of streams.values()) if (stream.hostId === hostId) count++;
	return count;
}

/**
 * Keep the ring bounded, counting lines rather than bytes so a trim never cuts
 * a line in half. The buffer holds lines without their newlines, so a chunk's
 * first piece continues whatever line the previous chunk left open — output
 * arrives in arbitrary slices, not conveniently at line boundaries.
 */
function appendToBuffer(stream: LogStream, text: string): void {
	const lines = text.split('\n');
	if (stream.buffer.length > 0) {
		stream.buffer[stream.buffer.length - 1] += lines.shift() ?? '';
	}
	for (const line of lines) stream.buffer.push(line);
	if (stream.buffer.length > CONTAINER_LOG_BUFFER_LINES) {
		stream.buffer.splice(0, stream.buffer.length - CONTAINER_LOG_BUFFER_LINES);
	}
}

function push(stream: LogStream, text: string): void {
	if (!text) return;
	appendToBuffer(stream, text);
	stream.pending += text;
}

function flush(stream: LogStream): void {
	if (!stream.pending) return;
	const data = stream.pending;
	stream.pending = '';
	ws.emit.user(stream.userId, 'containers:log-chunk', {
		streamId: stream.id,
		hostId: stream.hostId,
		containerId: stream.containerId,
		data
	});
}

function finish(stream: LogStream, error: string | null): void {
	if (stream.stopped) return;
	stream.stopped = true;
	flush(stream);
	if (stream.flushTimer) clearInterval(stream.flushTimer);
	streams.delete(stream.id);
	ws.emit.user(stream.userId, 'containers:log-chunk', {
		streamId: stream.id,
		hostId: stream.hostId,
		containerId: stream.containerId,
		data: '',
		done: true,
		error
	});
}

export interface StartedLogStream {
	streamId: string;
	/** Whatever the ring already holds, for a view that is joining late. */
	backlog: string;
}

/**
 * Start following a container, or join the stream already following it.
 *
 * The container is verified against a fresh listing first: the id arrived from
 * a client, and a stream is a process held open on someone's machine.
 */
export async function startLogStream(
	hostId: string,
	containerId: string,
	userId: string
): Promise<StartedLogStream> {
	assertContainerId(containerId);

	const id = streamIdFor(userId, hostId, containerId);
	const existing = streams.get(id);
	// Rejoined with the newlines the buffer strips, or the whole backlog would
	// arrive as one enormous line.
	if (existing) return { streamId: id, backlog: existing.buffer.join('\n') };

	const container = await containerMonitor.findContainer(hostId, containerId);
	if (!container) throw new Error('That container no longer exists on this host.');

	if (countForHost(hostId) >= MAX_STREAMS_PER_HOST) {
		throw new Error(
			`Already following ${MAX_STREAMS_PER_HOST} logs on this host. Close one before opening another.`
		);
	}

	const stream: LogStream = {
		id,
		hostId,
		containerId,
		userId,
		buffer: [],
		pending: '',
		flushTimer: null,
		stop: () => undefined,
		stopped: false
	};
	streams.set(id, stream);

	stream.flushTimer = setInterval(() => flush(stream), FLUSH_INTERVAL_MS);
	stream.flushTimer.unref?.();

	try {
		if (hostId === LOCAL_HOST_ID) await followLocal(stream);
		else await followRemote(stream);
	} catch (error) {
		finish(stream, error instanceof Error ? error.message : String(error));
		throw error;
	}

	debug.log('containers', `following logs for ${container.name} on ${hostId}`);
	return { streamId: id, backlog: '' };
}

/** The argv both transports run, once the runtime is known. */
async function logArgv(
	hostId: string,
	containerId: string,
	platform: ProbePlatform
): Promise<string[]> {
	const info = await containerMonitor.withHost(hostId, (runner) =>
		detectRuntime(hostId, runner, platform)
	);
	if (info.problem !== 'none' || !info.runtime) {
		throw new Error('This host has no container runtime available right now.');
	}
	return containerArgv(info.runtime, platform, [
		'logs',
		'--follow',
		'--tail',
		String(TAIL_LINES),
		containerId
	]);
}

async function followLocal(stream: LogStream): Promise<void> {
	const platform = localPlatform();
	const argv = await logArgv(stream.hostId, stream.containerId, platform);

	const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
	stream.stop = () => {
		try {
			child.kill();
		} catch {
			// Already gone.
		}
	};

	// `docker logs` writes a container's stdout and stderr to its own two
	// streams; a reader wants them interleaved exactly as the container wrote
	// them, so both are pumped into the same buffer.
	void pump(child.stdout, stream);
	void pump(child.stderr, stream);
	void child.exited.then((code) => {
		finish(stream, code === 0 || stream.stopped ? null : `The log command exited with status ${code}.`);
	});
}

async function pump(readable: ReadableStream<Uint8Array> | null, stream: LogStream): Promise<void> {
	if (!readable) return;
	const decoder = new TextDecoder();
	const reader = readable.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done || stream.stopped) return;
			if (value) push(stream, decoder.decode(value, { stream: true }));
		}
	} catch (error) {
		debug.log('containers', 'log stream ended:', error);
	} finally {
		reader.releaseLock();
	}
}

async function followRemote(stream: LogStream): Promise<void> {
	const connection = sshConnectionQueries.get(stream.hostId);
	if (!connection) throw new Error('That SSH host no longer exists.');

	const platform = await containerMonitor.withHost(stream.hostId, (runner) =>
		detectRemotePlatform(stream.hostId, runner)
	);
	const argv = await logArgv(stream.hostId, stream.containerId, platform);
	// Its own lease, not the shared queued runner: this channel never closes on
	// its own, and everything behind it in that queue would wait forever.
	const lease = await sshClientPool.acquire(stream.hostId);

	try {
		const channel = await openExec(lease.client, argv.map(shellQuote).join(' '));
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			lease.release();
		};

		stream.stop = () => {
			try {
				channel.close();
			} catch {
				// Already gone.
			}
			release();
		};

		const decoder = new TextDecoder();
		channel.on('data', (chunk: Buffer) => push(stream, decoder.decode(chunk, { stream: true })));
		channel.stderr.on('data', (chunk: Buffer) => push(stream, decoder.decode(chunk, { stream: true })));
		channel.on('close', () => {
			release();
			finish(stream, null);
		});
		channel.on('error', (error: Error) => {
			release();
			finish(stream, error.message);
		});
	} catch (error) {
		lease.release();
		throw error;
	}
}

function openExec(client: SshClient, command: string): Promise<ClientChannel> {
	return new Promise((resolve, reject) => {
		client.exec(command, (error, channel) => {
			if (error) reject(error);
			else resolve(channel);
		});
	});
}

/** Stop one stream, if it belongs to this user. */
export function stopLogStream(streamId: string, userId: string): void {
	const stream = streams.get(streamId);
	if (!stream || stream.userId !== userId) return;
	stream.stop();
	finish(stream, null);
}

/** Stop every stream a user holds, when their socket goes away. */
export function stopLogStreamsForUser(userId: string): void {
	for (const stream of [...streams.values()]) {
		if (stream.userId === userId) {
			stream.stop();
			finish(stream, null);
		}
	}
}

/** Stop everything, when the process is shutting down. */
export function stopAllLogStreams(): void {
	for (const stream of [...streams.values()]) {
		stream.stop();
		finish(stream, null);
	}
}

/** Stop every stream on a host, when its connection is edited or deleted. */
export function stopLogStreamsForHost(hostId: string): void {
	for (const stream of [...streams.values()]) {
		if (stream.hostId === hostId) {
			stream.stop();
			finish(stream, null);
		}
	}
}
