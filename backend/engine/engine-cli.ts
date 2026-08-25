/**
 * Engine CLI binaries
 *
 * Several engines are not pure SDKs: behind the npm package sits a real
 * executable that clopen (or the SDK itself) has to spawn. Those binaries live
 * inside the managed stack dir — never on PATH — which is where clopen kept
 * getting this wrong. Code that needed one reached for `Bun.which`, found
 * nothing on a machine without a global install, and reported an engine as
 * missing that Settings → Stack had just installed:
 *
 *   - Open Code: `@opencode-ai/sdk` is an HTTP client with no binary at all, so
 *     the adapter could not spawn `opencode serve` and NO model could be picked.
 *     Its CLI ships as a separate package, installed alongside the SDK.
 *   - Codex and Claude Code: their SDKs bundle a CLI as an optional platform
 *     dependency and locate it themselves, so streaming works — but clopen's own
 *     sign-in flows (`codex login`, `claude setup-token`) and the Codex engine
 *     status card looked on PATH and declared the CLI missing.
 *
 * This module is the single source of truth for that second artifact: which
 * package carries the binary, where it lands, and which version it must match.
 * Status, the readiness gate, the adapters and the sign-in flows all resolve
 * through `resolveEngineCli`, so what clopen reports is what clopen can run.
 *
 * Resolution order (first candidate that actually runs wins):
 *   1. the binary inside the managed stack dir — version-matched to the pinned
 *      SDK, so it is preferred over anything else,
 *   2. the platform package one level down — the same binary, reached when a
 *      postinstall was blocked and the package's own `bin/` holds a stub,
 *   3. whatever is on PATH — a CLI the user installed themselves.
 *
 * Every candidate is verified by running `--version` before it is handed out:
 * a postinstall stub exits 1, and a plain x64 build on a pre-AVX2 CPU dies on
 * startup. Both must fall through rather than reach a spawn site.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '$shared/utils/logger';
import { resolveBinaryWithRefresh } from '$backend/utils/cli';
import { getStackEnginesDir, getRequiredSdkVersion } from './sdk-loader';
import type { ToolId } from './install-recipes';

/** How long a candidate gets to answer `--version` before it is discarded. */
const PROBE_TIMEOUT_MS = 15_000;

export interface EngineCliSpec {
	/** Binary name as it appears on PATH. */
	binaryName: string;
	/**
	 * Package whose pinned version governs this CLI's version. For a bundled CLI
	 * that is the SDK itself; for Open Code it is the SDK the separate CLI
	 * package is released in lockstep with.
	 */
	versionSource: string;
	/**
	 * Extra package `bun add` must install for this CLI, when the SDK does not
	 * bring the binary itself. Omitted for CLIs bundled as a platform optional
	 * dependency of the SDK — those arrive with the engine install already.
	 */
	installPackage?: string;
	/**
	 * True when the engine cannot run at all without this binary. Such an engine
	 * counts as installed only once the CLI resolves. A bundled CLI is false:
	 * the SDK locates it internally through its own module graph, so a failure
	 * to find it here only affects clopen's own spawn sites.
	 */
	required: boolean;
	/** Candidate paths inside the stack dir's node_modules, best first. */
	candidates: (modulesDir: string) => string[];
}

const isWindows = process.platform === 'win32';

/** `<name>` on posix, `<name>.exe` on Windows. */
function exe(name: string): string {
	return isWindows ? `${name}.exe` : name;
}

// ─── Open Code ───────────────────────────────────────────────────────────────

const OPENCODE_PLATFORMS: Record<string, string> = {
	darwin: 'darwin',
	linux: 'linux',
	win32: 'windows'
};

/**
 * Open Code's platform packages, in the order its own postinstall would pick
 * them. bun installs the plain build matching our `os`/`cpu`/`libc`, so that is
 * normally the only one present; the `-baseline` (no AVX2) and `-musl` variants
 * are listed because the postinstall pulls them in on hosts where the plain
 * build cannot run, and we must find them there too.
 */
function opencodePlatformPackages(): string[] {
	const platform = OPENCODE_PLATFORMS[process.platform] ?? process.platform;
	const arch = process.arch;
	const base = `opencode-${platform}-${arch}`;

	if (platform === 'linux') {
		return arch === 'x64'
			? [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
			: [base, `${base}-musl`];
	}
	return arch === 'x64' ? [base, `${base}-baseline`] : [base];
}

// ─── Codex ───────────────────────────────────────────────────────────────────

/** Rust target triples Codex vendors its binary under, keyed by platform-arch. */
const CODEX_TARGET_TRIPLES: Record<string, string> = {
	'linux-x64': 'x86_64-unknown-linux-musl',
	'linux-arm64': 'aarch64-unknown-linux-musl',
	'darwin-x64': 'x86_64-apple-darwin',
	'darwin-arm64': 'aarch64-apple-darwin',
	'win32-x64': 'x86_64-pc-windows-msvc',
	'win32-arm64': 'aarch64-pc-windows-msvc'
};

/** `@openai/codex-<platform>-<arch>/vendor/<triple>/bin/codex` — the CLI's own layout. */
function codexCandidates(modules: string): string[] {
	const key = `${process.platform}-${process.arch}`;
	const triple = CODEX_TARGET_TRIPLES[key];
	if (!triple) return [];
	return [join(modules, '@openai', `codex-${key}`, 'vendor', triple, 'bin', exe('codex'))];
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

/**
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]/claude`. The musl
 * build is a separate package on Linux and is the one bun installs on Alpine,
 * so both names are tried.
 */
function claudeCandidates(modules: string): string[] {
	const base = `claude-agent-sdk-${process.platform}-${process.arch}`;
	const names = process.platform === 'linux' ? [base, `${base}-musl`] : [base];
	return names.map(name => join(modules, '@anthropic-ai', name, exe('claude')));
}

/**
 * Engines whose runtime needs an executable, and where to find it. Engines
 * absent from this registry run entirely in process (Cline, Pi, Cursor) or let
 * their SDK spawn a bundled entrypoint clopen never has to locate (Copilot,
 * Qwen, both resolved module-relative inside the stack dir).
 */
export const ENGINE_CLI: Partial<Record<ToolId, EngineCliSpec>> = {
	opencode: {
		binaryName: 'opencode',
		versionSource: '@opencode-ai/sdk',
		installPackage: 'opencode-ai',
		// Without it the adapter cannot spawn `opencode serve`, so the engine is
		// unusable — this is the one CLI that gates the engine's install state.
		required: true,
		candidates: modules => [
			// The postinstall writes `bin/opencode.exe` on every platform, not just
			// Windows — the extension is part of the shipped layout, not a guess.
			join(modules, 'opencode-ai', 'bin', 'opencode.exe'),
			...opencodePlatformPackages().map(pkg => join(modules, pkg, 'bin', exe('opencode')))
		]
	},
	codex: {
		binaryName: 'codex',
		versionSource: '@openai/codex-sdk',
		required: false,
		candidates: codexCandidates
	},
	claude: {
		binaryName: 'claude',
		versionSource: '@anthropic-ai/claude-agent-sdk',
		required: false,
		candidates: claudeCandidates
	}
};

/** The CLI spec for a tool, or null when the engine needs no external binary. */
export function getEngineCliSpec(tool: ToolId): EngineCliSpec | null {
	return ENGINE_CLI[tool] ?? null;
}

/** The CLI spec only when a missing binary makes the engine unusable. */
export function getRequiredEngineCliSpec(tool: ToolId): EngineCliSpec | null {
	const spec = ENGINE_CLI[tool];
	return spec?.required ? spec : null;
}

/**
 * Packages whose postinstall must be allowed to run inside the managed stack
 * dir. bun blocks lifecycle scripts for untrusted dependencies, and a CLI
 * package can ship a stub whose postinstall copies the real binary into place.
 */
export function engineCliTrustedPackages(): string[] {
	return Object.values(ENGINE_CLI)
		.map(spec => spec.installPackage)
		.filter((pkg): pkg is string => pkg !== undefined);
}

/** Version this CLI must match — the pin its version source carries. */
export function getRequiredCliVersion(spec: EngineCliSpec): string | null {
	return getRequiredSdkVersion(spec.versionSource);
}

/** `<package>@<version>` install argument, or null when the SDK bundles the CLI. */
export function engineCliInstallArg(spec: EngineCliSpec): string | null {
	if (!spec.installPackage) return null;
	const version = getRequiredCliVersion(spec);
	return version ? `${spec.installPackage}@${version}` : spec.installPackage;
}

export interface ResolvedEngineCli {
	/** Absolute path of a binary that answered `--version`. */
	path: string;
	/** Version it reported, or null when the output was unparseable. */
	version: string | null;
	/** Where it came from: clopen's managed stack dir, or the user's PATH. */
	source: 'stack' | 'path';
}

const resolved = new Map<ToolId, ResolvedEngineCli>();
const inFlight = new Map<ToolId, Promise<ResolvedEngineCli | null>>();

/**
 * Drop cached resolutions. Only needed when a binary is replaced in place at a
 * path that already resolved — a missing file is detected on the next call.
 */
export function invalidateEngineCliCache(tool?: ToolId): void {
	if (tool) resolved.delete(tool);
	else resolved.clear();
}

/** Run `<binary> --version`; returns null when it cannot run or exits non-zero. */
async function probeBinary(path: string): Promise<{ version: string | null } | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const proc = Bun.spawn([path, '--version'], {
			stdout: 'pipe',
			stderr: 'ignore',
			stdin: 'ignore',
			signal: controller.signal
		});
		const [stdout, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			proc.exited
		]);
		if (exitCode !== 0) return null;
		const first = stdout.trim().split('\n')[0]?.trim() ?? '';
		return { version: first || null };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function doResolve(tool: ToolId, spec: EngineCliSpec): Promise<ResolvedEngineCli | null> {
	const modules = join(getStackEnginesDir(), 'node_modules');

	const candidates: ResolvedEngineCli[] = spec.candidates(modules).map(path => ({
		path,
		version: null,
		source: 'stack' as const
	}));

	const onPath = await resolveBinaryWithRefresh(spec.binaryName);
	if (onPath) candidates.push({ path: onPath, version: null, source: 'path' });

	for (const candidate of candidates) {
		if (!existsSync(candidate.path)) continue;
		const probe = await probeBinary(candidate.path);
		if (!probe) {
			debug.warn('engine', `${spec.binaryName} candidate did not run, skipping: ${candidate.path}`);
			continue;
		}
		const hit: ResolvedEngineCli = { ...candidate, version: probe.version };
		resolved.set(tool, hit);
		debug.log(
			'engine',
			`Resolved ${spec.binaryName} CLI from ${hit.source}: ${hit.path}` +
			(hit.version ? ` (v${hit.version})` : '')
		);
		return hit;
	}

	debug.warn('engine', `No usable ${spec.binaryName} CLI found (stack dir or PATH)`);
	return null;
}

/**
 * Resolve a runnable CLI for an engine, or null when none is usable. Returns
 * null immediately for engines that need no external binary — callers can treat
 * "no spec" and "spec satisfied" alike by checking `getEngineCliSpec` first.
 *
 * Successful resolutions are cached (probing spawns a large binary) and
 * revalidated by existence on every call; failures are not cached, so a repair
 * install becomes visible as soon as it lands.
 */
export async function resolveEngineCli(tool: ToolId): Promise<ResolvedEngineCli | null> {
	const spec = ENGINE_CLI[tool];
	if (!spec) return null;

	const cached = resolved.get(tool);
	if (cached) {
		if (existsSync(cached.path)) return cached;
		resolved.delete(tool);
	}

	const pending = inFlight.get(tool);
	if (pending) return pending;

	const p = doResolve(tool, spec).finally(() => { inFlight.delete(tool); });
	inFlight.set(tool, p);
	return p;
}
