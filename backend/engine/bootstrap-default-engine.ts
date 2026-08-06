/**
 * Fresh-install default engine bootstrap.
 *
 * On a machine where NO engine SDK is installed yet, auto-install OpenCode —
 * the one free, no-account engine — into the managed stack dir so first-time
 * users have a working default without any manual setup (wizard or otherwise).
 * Runs in the background at startup; failures are non-fatal (engines remain
 * installable from Settings → Stack). Skipped as soon as ANY engine is present,
 * so it never fights a user who intentionally removed OpenCode.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '$shared/utils/logger';
import { getCleanSpawnEnv } from '$backend/utils/env';
import { isEngineSdkInstalled } from './sdk-loader';
import { resolveRecipe } from './install-recipes';

const ENGINE_SDK_PACKAGES = [
	'@anthropic-ai/claude-agent-sdk',
	'@github/copilot-sdk',
	'@openai/codex-sdk',
	'@qwen-code/sdk',
	'@opencode-ai/sdk',
	'@earendil-works/pi-coding-agent',
	'@cline/sdk',
	'@cursor/sdk',
];

/**
 * Tracks an in-flight install so concurrent callers share one run — but only
 * while it's running. A permanent "already started" latch would wrongly skip a
 * legitimate reinstall after "Clear All Data" wipes ~/.clopen/stack/engines on
 * the live process; gating on the in-flight promise instead lets a later call
 * re-evaluate `isEngineSdkInstalled` once the previous run has settled.
 */
let inFlight: Promise<void> | null = null;

/**
 * Install OpenCode on a fresh machine (no engine SDK present). Idempotent and
 * safe to call at every startup and after a data wipe; it no-ops once any engine
 * exists, and de-dupes concurrent calls via the in-flight promise.
 */
export function ensureDefaultEngineInstalled(): Promise<void> {
	if (inFlight) return inFlight;
	inFlight = runDefaultEngineInstall().finally(() => {
		inFlight = null;
	});
	return inFlight;
}

async function runDefaultEngineInstall(): Promise<void> {
	if (ENGINE_SDK_PACKAGES.some(isEngineSdkInstalled)) return;

	const recipe = await resolveRecipe('opencode');
	if (!recipe.command || !recipe.cwd) return;

	// Ensure the managed dir is a minimal bun project before `bun add` runs.
	mkdirSync(recipe.cwd, { recursive: true });
	const pkgJsonPath = join(recipe.cwd, 'package.json');
	if (!existsSync(pkgJsonPath)) {
		writeFileSync(
			pkgJsonPath,
			JSON.stringify({ name: 'clopen-stack-engines', private: true, version: '0.0.0' }, null, 2) + '\n'
		);
	}

	debug.log('engine', `Auto-installing default engine (OpenCode): ${recipe.displayCommand}`);
	try {
		const proc = Bun.spawn(recipe.command, {
			cwd: recipe.cwd,
			env: getCleanSpawnEnv(),
			stdout: 'ignore',
			stderr: 'ignore',
			stdin: 'ignore',
		});
		const code = await proc.exited;
		debug.log('engine', `Default engine (OpenCode) auto-install exited with code ${code}`);
	} catch (error) {
		debug.warn('engine', 'Default engine auto-install failed (non-fatal)', error);
	}
}
