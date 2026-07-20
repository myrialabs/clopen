/**
 * Pi session persistence + fork-on-resume.
 *
 * Pi persists each session as a JSONL tree. We keep those files in Clopen's
 * ISOLATED sessions dir (never `~/.pi/agent/sessions`) by always passing an
 * explicit `sessionDir` to `SessionManager`, encoded per project so concurrent
 * projects don't collide.
 *
 * Every resume FORKS (README §10.10): Clopen's multi-branch checkpoints require
 * each resumed turn to produce a brand-new session id so the source branch's
 * history is never mutated. Pi exposes a native `SessionManager.forkFrom()`, so
 * this is a first-class copy — no manual JSONL patching.
 */

import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { getPiSessionsDir } from './environment';
import { debug } from '$shared/utils/logger';

/** Per-project isolated session dir under Clopen's Pi config dir. */
export function getPiSessionDir(projectPath: string): string {
	return join(getPiSessionsDir(), projectPath.replace(/[^a-zA-Z0-9]/g, '-'));
}

/**
 * Build the `SessionManager` for a stream. When `resume` names an existing
 * session, fork from it (new id, source untouched); otherwise start fresh.
 */
export async function resolvePiSessionManager(projectPath: string, resume?: string): Promise<SessionManager> {
	const sessionDir = getPiSessionDir(projectPath);
	if (resume) {
		try {
			const infos = await SessionManager.list(projectPath, sessionDir);
			const match = infos.find(info => info.id === resume);
			if (match) {
				const forked = SessionManager.forkFrom(match.path, projectPath, sessionDir);
				debug.log('engine', `Pi resumed session ${resume} → fork ${forked.getSessionId()}`);
				return forked;
			}
			debug.warn('engine', `Pi resume: session ${resume} not found on disk, starting fresh`);
		} catch (error) {
			debug.warn('engine', `Pi resume failed (${error instanceof Error ? error.message : String(error)}), starting fresh`);
		}
	}
	return SessionManager.create(projectPath, sessionDir);
}
