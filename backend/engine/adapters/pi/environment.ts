/**
 * Environment / directory isolation for the Pi engine.
 *
 * Pi is an IN-PROCESS SDK (`@earendil-works/pi-coding-agent`) — there is no CLI
 * subprocess and no env var to redirect a home dir. Instead every `ModelRuntime`
 * / `AgentSession` we build is pointed at an ISOLATED agent dir so Clopen never
 * reads or writes the user's real `~/.pi/agent`. Credentials do NOT live in that
 * dir's `auth.json`; they live in the `engine_accounts` table and are served to
 * the runtime through a DB-backed `CredentialStore` (see ./credential.ts).
 */

import { join } from 'node:path';
import { getEngineUserConfigDir } from '$backend/utils/paths';

/** Isolated agent dir: `{clopenDir}/engine/pi/user/`. Mirrors §10.19 isolation. */
export function getPiAgentDir(): string {
	return getEngineUserConfigDir('pi');
}

/** Isolated custom-models file (`models.json`) — optional, may not exist. */
export function getPiModelsPath(): string {
	return join(getPiAgentDir(), 'models.json');
}

/** Isolated dynamic-catalog cache (`models-store.json`). */
export function getPiModelsStorePath(): string {
	return join(getPiAgentDir(), 'models-store.json');
}

/** Isolated sessions dir — Pi persists session JSONL trees here. */
export function getPiSessionsDir(): string {
	return join(getPiAgentDir(), 'sessions');
}
