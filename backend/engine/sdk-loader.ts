/**
 * Engine SDK lazy loader
 *
 * Engine SDKs (Claude Agent SDK, Copilot SDK, Codex SDK, …) are NOT bundled
 * into the clopen global install. They are installed on demand into a directory
 * clopen manages — `~/.clopen/stack/engines` — which keeps them:
 *   - out of the user's global bun store (no PATH pollution, no version clashes),
 *   - out of the user's projects (never touches their package.json/node_modules),
 *   - isolated to clopen and surviving clopen reinstalls.
 * This is the runtime half of the "Stack" concept (Settings → Stack).
 *
 * package.json (devDependencies) remains the single source of truth for the
 * exact pinned version each engine installs; this module only resolves and
 * loads whatever is present in the managed directory. When an SDK is not
 * installed the import throws a typed `EngineSdkNotInstalledError` so a missing
 * engine degrades to "not installed" in the UI instead of crashing the backend.
 */

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { getClopenDir } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';

export type EngineSdkId =
	| 'claude-code'
	| 'copilot'
	| 'codex'
	| 'qwen'
	| 'opencode'
	| 'pi'
	| 'cline'
	| 'cursor';

/**
 * Thrown when an engine's SDK package cannot be resolved at runtime — i.e. the
 * engine has not been installed on demand yet. Carries the engine id and the
 * npm package name so callers can render an actionable "install this engine"
 * message rather than surfacing a raw module-resolution error.
 */
export type EngineSetupReason = 'not-installed' | 'needs-update';

/**
 * Thrown when an engine cannot be used because its SDK is not ready in the
 * managed stack dir: either not installed, or installed at a version other than
 * the one clopen pins (a mandatory update). Carries enough for the UI to render
 * an actionable prompt; the message is also human-readable for the chat error
 * surface. `reason` drives the wording and the target action.
 */
export class EngineNotReadyError extends Error {
	readonly engine: EngineSdkId;
	readonly packageName: string;
	readonly reason: EngineSetupReason;
	readonly installedVersion: string | null;
	readonly requiredVersion: string | null;

	constructor(
		engine: EngineSdkId,
		packageName: string,
		reason: EngineSetupReason,
		installedVersion: string | null,
		requiredVersion: string | null,
		cause?: unknown
	) {
		const detail = reason === 'needs-update'
			? `needs an update (installed ${installedVersion ?? 'unknown'}, ` +
			  `required ${requiredVersion ?? 'unknown'}). Open Settings → Stack to ` +
			  `update it before using this engine.`
			: `is not installed. Open Settings → Stack to install it.`;
		super(`Engine "${engine}" ${detail}`);
		this.name = 'EngineNotReadyError';
		this.engine = engine;
		this.packageName = packageName;
		this.reason = reason;
		this.installedVersion = installedVersion;
		this.requiredVersion = requiredVersion;
		if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
	}
}

/**
 * The clopen-managed directory that on-demand engine SDKs are installed into.
 * It is a self-contained bun project (`node_modules` + a minimal package.json),
 * so a globally-installed clopen never has to touch the user's global store.
 */
export function getStackEnginesDir(): string {
	return join(getClopenDir(), 'stack', 'engines');
}

/** Absolute path of an installed engine package inside the managed dir. */
function stackPackageDir(packageName: string): string {
	return join(getStackEnginesDir(), 'node_modules', packageName);
}

/**
 * Exact versions clopen pins for its dependencies (read from package.json —
 * the single source of truth). An engine SDK installed in the stack dir must
 * match its pinned version, or it is considered out of date and must be updated.
 */
let cachedRequiredVersions: Record<string, string> | null = null;
function requiredVersions(): Record<string, string> {
	if (cachedRequiredVersions) return cachedRequiredVersions;
	try {
		const pkgPath = join(import.meta.dir, '..', '..', 'package.json');
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		cachedRequiredVersions = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
	} catch {
		cachedRequiredVersions = {};
	}
	return cachedRequiredVersions;
}

/** The exact version clopen pins for an SDK package (from package.json), or null. */
export function getRequiredSdkVersion(packageName: string): string | null {
	return requiredVersions()[packageName] ?? null;
}

/** Resolved-module cache so repeat loads of the same SDK are cheap. */
const moduleCache = new Map<string, unknown>();

/**
 * Dynamically import an engine SDK from the managed stack directory, caching the
 * module. Throws `EngineSdkNotInstalledError` when the package is not installed.
 *
 * Type the result via the `T` parameter using `typeof import('<pkg>')`, e.g.:
 *   const { CopilotClient } = await loadEngineSdk<typeof import('@github/copilot-sdk')>(
 *     'copilot', '@github/copilot-sdk'
 *   );
 * Keep all compile-time type references on `import type` so they are erased at
 * runtime and never force resolution of an absent package.
 */
export async function loadEngineSdk<T>(engine: EngineSdkId, packageName: string): Promise<T> {
	const cached = moduleCache.get(packageName);
	if (cached !== undefined) return cached as T;

	// Guard readiness before loading: not installed, or installed at a version
	// other than the one clopen pins (a mandatory update).
	const installed = readEngineSdkVersion(packageName);
	const required = getRequiredSdkVersion(packageName);
	if (installed === null) {
		throw new EngineNotReadyError(engine, packageName, 'not-installed', null, required);
	}
	if (required !== null && installed !== required) {
		throw new EngineNotReadyError(engine, packageName, 'needs-update', installed, required);
	}

	try {
		// Resolve the package's entry point (respecting its `exports`/`main`) from
		// the managed dir, then import by absolute path.
		const entry = Bun.resolveSync(packageName, getStackEnginesDir());
		const mod = (await import(entry)) as T;
		moduleCache.set(packageName, mod);
		return mod;
	} catch (error) {
		debug.warn('engine', `Engine SDK "${packageName}" (${engine}) failed to load`, error);
		throw new EngineNotReadyError(engine, packageName, 'not-installed', installed, required, error);
	}
}

/**
 * Installed version of an engine SDK in the managed stack dir, or null when not
 * installed. Reads package.json directly (bypassing any `exports` map that would
 * hide `./package.json`), so detection is robust across packages.
 */
export function readEngineSdkVersion(packageName: string): string | null {
	try {
		const pkgJsonPath = join(stackPackageDir(packageName), 'package.json');
		const json = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version?: string };
		return json.version ?? null;
	} catch {
		return null;
	}
}

/** Whether an engine's SDK package is installed in the managed stack dir. */
export function isEngineSdkInstalled(packageName: string): boolean {
	return existsSync(join(stackPackageDir(packageName), 'package.json'));
}
