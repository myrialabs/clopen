/**
 * Fresh-install default engine bootstrap & repair.
 *
 * Two jobs, both aimed at a user who should never have to know any of this
 * exists:
 *
 *  1. Bootstrap — on a machine where NO engine SDK is installed yet,
 *     auto-install OpenCode (the one free, no-account engine) into the managed
 *     stack dir so first-time users have a working default without any manual
 *     setup. Skipped as soon as ANY engine is present, so it never fights a
 *     user who intentionally removed OpenCode.
 *
 *  2. Repair — OpenCode needs an external CLI binary on top of its SDK
 *     (see engine-cli.ts). Earlier builds installed only the SDK, so machines
 *     bootstrapped by them carry a half-installed engine: Settings → Stack
 *     reported it as ready while the adapter could not spawn it at all. Those
 *     installs are clopen's own doing, so clopen finishes them rather than
 *     asking the user to. The repair is deliberately narrow — the SDK must
 *     already be there and only its CLI missing — so it never pulls in an
 *     engine nobody asked for.
 *
 * Both run in the background at startup through the normal install runner, so
 * the work shows up as a live session in Settings → Stack instead of a silent
 * download; failures are non-fatal (engines stay installable by hand).
 */

import { debug } from '$shared/utils/logger';
import { isEngineSdkInstalled } from './sdk-loader';
import { ENGINE_PACKAGES } from './install-recipes';
import { getRequiredEngineCliSpec, resolveEngineCli } from './engine-cli';
import { awaitInstall, InstallAlreadyRunningError, startInstall, SYSTEM_INSTALL_USER } from './install-runner';

const DEFAULT_ENGINE = 'opencode' as const;

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
 * Install the default engine on a fresh machine, or finish a half-installed one.
 * Idempotent and safe to call at every startup and after a data wipe; it no-ops
 * once the default engine is fully usable, and de-dupes concurrent calls via the
 * in-flight promise.
 */
export function ensureDefaultEngineInstalled(): Promise<void> {
	if (inFlight) return inFlight;
	inFlight = runDefaultEngineInstall().finally(() => {
		inFlight = null;
	});
	return inFlight;
}

/**
 * Why the default engine needs installing, or null when nothing is to be done.
 * "repair" covers the SDK-without-CLI state older builds left behind.
 */
async function pendingInstallReason(): Promise<'bootstrap' | 'repair' | null> {
	if (!ENGINE_SDK_PACKAGES.some(isEngineSdkInstalled)) return 'bootstrap';

	// Some engine is installed, so the fresh-machine bootstrap is done. The
	// default engine may still be half-installed, though — and only its own SDK
	// tells us whether clopen ever installed it in the first place.
	const sdkPkg = ENGINE_PACKAGES[DEFAULT_ENGINE]?.[0];
	if (!sdkPkg || !isEngineSdkInstalled(sdkPkg)) return null;
	if (!getRequiredEngineCliSpec(DEFAULT_ENGINE)) return null;

	return (await resolveEngineCli(DEFAULT_ENGINE)) ? null : 'repair';
}

async function runDefaultEngineInstall(): Promise<void> {
	const reason = await pendingInstallReason();
	if (!reason) return;

	debug.log(
		'engine',
		reason === 'bootstrap'
			? `No engine installed — auto-installing the default engine (${DEFAULT_ENGINE})`
			: `Default engine (${DEFAULT_ENGINE}) is missing its CLI — repairing the install`
	);

	try {
		const session = await startInstall(DEFAULT_ENGINE, SYSTEM_INSTALL_USER);
		// Callers chain work that needs a usable engine (memory picks its
		// extraction model from the engine's catalog), so wait for the run to
		// settle rather than returning as soon as it is spawned.
		await awaitInstall(session.id);
		debug.log('engine', `Default engine ${reason} finished with status "${session.status}"`);
	} catch (error) {
		if (error instanceof InstallAlreadyRunningError) {
			debug.log('engine', `Default engine ${reason} skipped — an install is already running`);
			return;
		}
		debug.warn('engine', `Default engine ${reason} failed (non-fatal)`, error);
	}
}
