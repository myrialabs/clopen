/**
 * System Tool Install Runner
 *
 * Spawns install recipes via Bun.spawn (non-interactive), streams stdout
 * and stderr to subscribed WebSocket clients, buffers recent output in a
 * bounded ring buffer so late subscribers (or re-connecting clients) can
 * catch up, and supports cancellation.
 *
 * Session model:
 *  - One active session per ToolId (prevents duplicate installs).
 *  - A session survives client navigation: output continues to accumulate
 *    in the ring buffer and the run completes regardless of who is listening.
 *  - After exit, the session remains in memory for RETENTION_MS so the
 *    frontend can retrieve final state (exit code + log), then GC'd.
 *
 * Security: install recipes are constructed server-side only. The client
 * may only pick a tool id; it cannot supply arbitrary command strings.
 */

import { freemem, totalmem } from 'node:os';
import { debug } from '$shared/utils/logger';
import { ws } from '$backend/utils/ws';
import { getCleanSpawnEnv } from '$backend/utils/env';
import { refreshProcessPath } from '$backend/utils/path-enrich';
import { ensureCurlAvailable } from '$backend/utils/static-curl';
import type { Recipe, ToolId } from './install-recipes';
import { resolveRecipe } from './install-recipes';

const RING_BUFFER_LINES = 10_000;
const RETENTION_MS = 5 * 60 * 1000;

export type SessionStatus = 'running' | 'success' | 'failed' | 'cancelled';

interface RingBuffer {
	lines: string[];
	total: number;
}

interface Session {
	id: string;
	tool: ToolId;
	recipe: Recipe;
	proc: ReturnType<typeof Bun.spawn> | null;
	status: SessionStatus;
	exitCode: number | null;
	startedAt: number;
	endedAt: number | null;
	buffer: RingBuffer;
	retentionTimer: ReturnType<typeof setTimeout> | null;
	startedBy: string;
	/** Current partial line per stream (for line-based chunking). */
	pending: { stdout: string; stderr: string };
}

const sessions = new Map<string, Session>();
const activeByTool = new Map<ToolId, string>();

function newRingBuffer(): RingBuffer {
	return { lines: [], total: 0 };
}

function pushLine(buf: RingBuffer, line: string): void {
	buf.lines.push(line);
	buf.total += 1;
	if (buf.lines.length > RING_BUFFER_LINES) {
		buf.lines.splice(0, buf.lines.length - RING_BUFFER_LINES);
	}
}

function scheduleRetention(session: Session): void {
	if (session.retentionTimer) clearTimeout(session.retentionTimer);
	session.retentionTimer = setTimeout(() => {
		sessions.delete(session.id);
		if (activeByTool.get(session.tool) === session.id) {
			activeByTool.delete(session.tool);
		}
	}, RETENTION_MS);
}

function sessionSnapshot(session: Session) {
	return {
		sessionId: session.id,
		tool: session.tool,
		status: session.status,
		exitCode: session.exitCode,
		startedAt: session.startedAt,
		endedAt: session.endedAt,
		totalLines: session.buffer.total,
		recentLines: session.buffer.lines.slice(),
		displayCommand: session.recipe.displayCommand ?? ''
	};
}

function emitStream(session: Session, stream: 'stdout' | 'stderr', chunk: string): void {
	// Buffer partial lines so subscribers receive whole lines at a time.
	const prev = session.pending[stream] + chunk;
	const parts = prev.split(/\r?\n/);
	session.pending[stream] = parts.pop() ?? '';
	for (const line of parts) {
		pushLine(session.buffer, line);
		ws.emit.user(session.startedBy, 'system-tools:install-stream', {
			sessionId: session.id,
			tool: session.tool,
			type: stream,
			line
		});
	}
}

function flushPending(session: Session): void {
	for (const stream of ['stdout', 'stderr'] as const) {
		const remaining = session.pending[stream];
		if (remaining) {
			pushLine(session.buffer, remaining);
			ws.emit.user(session.startedBy, 'system-tools:install-stream', {
				sessionId: session.id,
				tool: session.tool,
				type: stream,
				line: remaining
			});
			session.pending[stream] = '';
		}
	}
}

async function pipeStream(
	session: Session,
	stream: ReadableStream<Uint8Array> | null,
	kind: 'stdout' | 'stderr'
): Promise<void> {
	if (!stream) return;
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value, { stream: true });
			emitStream(session, kind, chunk);
		}
		const tail = decoder.decode();
		if (tail) emitStream(session, kind, tail);
	} catch (err) {
		debug.warn('path', `[install:${session.id}] stream read error (${kind}):`, err);
	} finally {
		try { reader.releaseLock(); } catch { /* ignore */ }
	}
}

export class InstallAlreadyRunningError extends Error {
	constructor(public sessionId: string, public tool: ToolId) {
		super(`Install already running for ${tool}`);
	}
}

export class InstallNotAutoInstallableError extends Error {
	constructor(public tool: ToolId, public reason: string) {
		super(`Cannot auto-install ${tool}: ${reason}`);
	}
}

function finalizeSession(session: Session, preferredStatus: SessionStatus, exitCode: number): void {
	// `cancelled` (set preemptively by cancelInstall) or earlier failure paths
	// must not be overwritten by the caller's preferred status.
	if (session.status === 'running') {
		session.status = preferredStatus;
	}
	session.exitCode = exitCode;
	session.endedAt = Date.now();
	session.proc = null;

	debug.log('path', `[install:${session.id}] Finished status=${session.status} exit=${exitCode}`);

	ws.emit.user(session.startedBy, 'system-tools:install-finished', {
		sessionId: session.id,
		tool: session.tool,
		status: session.status,
		exitCode: exitCode ?? -1,
		endedAt: session.endedAt
	});

	scheduleRetention(session);
}

async function runStreamedProcess(session: Session, proc: ReturnType<typeof Bun.spawn>): Promise<number> {
	const [, , exitCode] = await Promise.all([
		pipeStream(session, proc.stdout as ReadableStream<Uint8Array>, 'stdout'),
		pipeStream(session, proc.stderr as ReadableStream<Uint8Array>, 'stderr'),
		proc.exited
	]);
	flushPending(session);
	return exitCode;
}

function formatBytes(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	if (mb < 1024) return `${mb.toFixed(0)} MB`;
	return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * Build a human-readable hint for non-zero exit codes that likely indicate
 * an environmental problem (OOM kill, external termination) rather than a
 * recipe bug. Returns null when no specific guidance applies.
 *
 * Shells propagate signals as `128 + signum`: 137 = SIGKILL (OOM killer on
 * Linux), 143 = SIGTERM. On a cancelled session we skip the hint — the UI
 * already labels the run as "Cancelled".
 */
function explainFailure(exitCode: number, cancelled: boolean): string | null {
	if (cancelled) return null;
	if (exitCode === 137) {
		const total = formatBytes(totalmem());
		const free = formatBytes(freemem());
		return [
			'',
			'⚠ Exit 137 — the process was killed (SIGKILL), almost always by the kernel out-of-memory killer.',
			`  System memory: total=${total}, free=${free}.`,
			'  Common causes: low-RAM VPS / container / WSL without enough swap. Installer subprocesses can briefly peak at several hundred MB of memory.',
			'  Remedies: add swap, raise the container memory limit, or run the install command in a shell with more memory, then retry.'
		].join('\n');
	}
	if (exitCode === 143) {
		return '\n⚠ Exit 143 — the process received SIGTERM (external termination). Possible causes: systemd/container shutdown, manual kill, or an orchestrator timeout.';
	}
	return null;
}

async function runInstall(session: Session, env: Record<string, string>): Promise<void> {
	const { recipe } = session;
	let proc: ReturnType<typeof Bun.spawn>;

	// Ensure curl is available when the recipe shells out to it. Prepends
	// the static-curl directory to PATH when a managed binary is staged.
	if (recipe.requiresCurl) {
		try {
			const curlDir = await ensureCurlAvailable((event) => {
				emitStream(session, 'stdout', `» curl: ${event.message}\n`);
			});
			if (curlDir) {
				env.PATH = `${curlDir}${process.platform === 'win32' ? ';' : ':'}${env.PATH ?? ''}`;
			}
		} catch (err) {
			emitStream(session, 'stderr', `curl setup failed: ${err instanceof Error ? err.message : String(err)}\n`);
			finalizeSession(session, 'failed', -1);
			return;
		}

		// Cancel may have fired while curl was being staged.
		if (session.status !== 'running') {
			finalizeSession(session, session.status, -1);
			return;
		}
	}

	const spawnArgs = recipe.shell
		? [recipe.shell.program, ...recipe.shell.args, ...recipe.command!]
		: recipe.command!;

	debug.log('path', `[install:${session.id}] Spawning: ${spawnArgs.join(' ')}`);

	try {
		proc = Bun.spawn(spawnArgs, {
			stdout: 'pipe',
			stderr: 'pipe',
			stdin: 'ignore',
			env
		});
	} catch (err) {
		emitStream(session, 'stderr', `spawn failed: ${err instanceof Error ? err.message : String(err)}\n`);
		finalizeSession(session, 'failed', -1);
		return;
	}

	session.proc = proc;

	const exitCode = await runStreamedProcess(session, proc);
	if (exitCode !== 0) {
		const hint = explainFailure(exitCode, session.status === 'cancelled');
		if (hint) emitStream(session, 'stderr', hint + '\n');
	}
	finalizeSession(session, exitCode === 0 ? 'success' : 'failed', exitCode);
}

export async function startInstall(tool: ToolId, userId: string): Promise<Session> {
	await refreshProcessPath();

	const existing = activeByTool.get(tool);
	if (existing) {
		const session = sessions.get(existing);
		if (session && session.status === 'running') {
			throw new InstallAlreadyRunningError(existing, tool);
		}
	}

	const recipe = await resolveRecipe(tool);
	if (!recipe.autoInstallable || !recipe.command) {
		throw new InstallNotAutoInstallableError(tool, recipe.unavailableReason ?? 'Not auto-installable on this platform');
	}

	const id = crypto.randomUUID();
	const env = { ...getCleanSpawnEnv(), ...(recipe.env ?? {}) };

	const session: Session = {
		id,
		tool,
		recipe,
		proc: null,
		status: 'running',
		exitCode: null,
		startedAt: Date.now(),
		endedAt: null,
		buffer: newRingBuffer(),
		retentionTimer: null,
		startedBy: userId,
		pending: { stdout: '', stderr: '' }
	};

	sessions.set(id, session);
	activeByTool.set(tool, id);

	// Initial marker line so clients see something immediately.
	const banner = `$ ${recipe.displayCommand ?? ''}`;
	emitStream(session, 'stdout', banner + '\n');

	// Broadcast the session-started event so clients that subscribe mid-run can attach.
	ws.emit.user(userId, 'system-tools:install-started', {
		sessionId: id,
		tool,
		displayCommand: recipe.displayCommand ?? '',
		startedAt: session.startedAt
	});

	runInstall(session, env).catch((err) => {
		debug.error('path', `[install:${id}] runner crash:`, err);
		emitStream(session, 'stderr', `runner crash: ${err instanceof Error ? err.message : String(err)}\n`);
		finalizeSession(session, 'failed', -1);
	});

	return session;
}

export function cancelInstall(sessionId: string): boolean {
	const session = sessions.get(sessionId);
	if (!session || session.status !== 'running') return false;
	session.status = 'cancelled';
	// `proc` may be null during the static-curl download phase; runInstall
	// re-checks status after each await and finalizes accordingly.
	if (session.proc) {
		try {
			session.proc.kill();
		} catch {
			// Already dead — the exited promise will resolve regardless.
		}
	}
	return true;
}

export function getSession(sessionId: string) {
	const session = sessions.get(sessionId);
	return session ? sessionSnapshot(session) : null;
}

export function getSessionOwner(sessionId: string): string | null {
	return sessions.get(sessionId)?.startedBy ?? null;
}

export function getActiveSessionForTool(tool: ToolId) {
	const id = activeByTool.get(tool);
	if (!id) return null;
	const session = sessions.get(id);
	return session ? sessionSnapshot(session) : null;
}

export function listActiveSessions() {
	return Array.from(sessions.values()).map(sessionSnapshot);
}
