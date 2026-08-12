/**
 * On-demand engine install integrity
 *
 * Engine SDKs are not bundled. `resolveEngineRecipe` builds a `bun add` for the
 * managed stack dir and pins each package to the version `getRequiredSdkVersion`
 * reads out of package.json — the single source of truth.
 *
 * That pinning is silent when it fails. A package listed in ENGINE_PACKAGES but
 * missing from package.json yields `null`, and `engineInstallArgs` falls back to
 * the bare name, so the user installs `@latest` instead of the version clopen
 * was tested against. Nothing errors; the engine just installs something else.
 * Clopen has already been bitten by a floated version this way (typebox, #362),
 * and the blast radius grows with every engine added.
 *
 * `readEngineSdkVersion` compounds it: `loadEngineSdk` only enforces a version
 * match when a required version exists, so an unpinned package also loses the
 * "needs update" check that would otherwise surface the drift in Settings → Stack.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineType } from '$shared/types/unified';
import { ENGINE_PACKAGES, type ToolId } from './install-recipes';
import { ENGINE_SDK } from './engine-setup';
import { getRequiredSdkVersion } from './sdk-loader';

const pkg = JSON.parse(
	readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

/** Every (engine, package) pair clopen installs on demand. */
const enginePackages = Object.entries(ENGINE_PACKAGES).flatMap(([engine, packages]) =>
	(packages ?? []).map(name => ({ engine, name }))
);

describe('on-demand engine SDKs', () => {
	test('the registry is non-empty', () => {
		// Without this, an emptied registry would make the checks below vacuous.
		expect(enginePackages.length).toBeGreaterThan(0);
	});

	test('every engine package is declared in package.json', () => {
		const undeclared = enginePackages
			.filter(({ name }) => declared[name] === undefined)
			.map(({ engine, name }) => `${engine}: "${name}" would install as @latest`);

		expect(undeclared).toEqual([]);
	});

	test('every engine package is pinned to an exact version', () => {
		// A range (^1.2.3) reintroduces the same drift the pin exists to prevent:
		// the published package.json is the only resolution source on a global
		// install, so bun.lock cannot hold the version down for the user.
		const floated = enginePackages
			.filter(({ name }) => !/^\d+\.\d+\.\d+/.test(declared[name] ?? ''))
			.map(({ engine, name }) => `${engine}: "${name}" is "${declared[name]}", not an exact version`);

		expect(floated).toEqual([]);
	});

	test('the readiness check and the installer name the same package', () => {
		// Three registries describe the same fact in different namespaces:
		// ENGINE_SDK (EngineType → the package `checkEngineSetup` probes),
		// ENGINE_PACKAGES (ToolId → what `bun add` installs, first entry being the
		// one clopen imports), and this mapping between the two id spaces.
		//
		// Drift here makes readiness lie rather than fail: the pre-stream check
		// would probe a package nobody installs — reporting an installed engine as
		// missing, or worse, waving through one that cannot load. TypeScript only
		// forces the keys to exist; the values have to be checked.
		const TOOL_FOR_ENGINE: Record<EngineType, ToolId> = {
			'claude-code': 'claude',
			opencode: 'opencode',
			copilot: 'copilot',
			codex: 'codex',
			qwen: 'qwen',
			pi: 'pi',
			cline: 'cline',
			cursor: 'cursor',
		};

		const drift = Object.entries(TOOL_FOR_ENGINE).flatMap(([engine, tool]) => {
			const probed = ENGINE_SDK[engine as EngineType];
			const installed = ENGINE_PACKAGES[tool]?.[0];
			if (installed === undefined) return [`${engine}: no install recipe for tool "${tool}"`];
			return probed === installed
				? []
				: [`${engine}: readiness probes "${probed}" but the recipe installs "${installed}"`];
		});

		expect(drift).toEqual([]);
	});

	test('the resolver agrees with package.json', () => {
		// Guards the seam the recipe actually uses — if getRequiredSdkVersion ever
		// stops reading package.json, the checks above would pass while installs
		// silently floated again.
		for (const { name } of enginePackages) {
			expect(getRequiredSdkVersion(name)).toBe(declared[name]!);
		}
	});
});
