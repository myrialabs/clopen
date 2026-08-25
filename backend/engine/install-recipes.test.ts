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
 *
 * Engine CLIs (engine-cli.ts) are pinned one step removed — through their SDK's
 * version, since a platform binary has no business in devDependencies — and
 * they only work if bun is allowed to run their postinstall. Both of those are
 * silent failures too: an unpinned CLI floats to @latest, and an untrusted one
 * installs a stub that fails at the first spawn.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineType } from '$shared/types/unified';
import { ENGINE_PACKAGES, engineInstallArgs, type ToolId } from './install-recipes';
import { ENGINE_SDK, TOOL_FOR_ENGINE } from './engine-setup';
import { getRequiredSdkVersion } from './sdk-loader';
import { ENGINE_CLI, engineCliTrustedPackages, getRequiredCliVersion } from './engine-cli';
import { ensureStackProject } from './stack-project';

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
		const expectedToolForEngine: Record<EngineType, ToolId> = {
			'claude-code': 'claude',
			opencode: 'opencode',
			copilot: 'copilot',
			codex: 'codex',
			qwen: 'qwen',
			pi: 'pi',
			cline: 'cline',
			cursor: 'cursor',
		};

		// The mapping ships in engine-setup (readiness and status both resolve a
		// tool id through it); this independent copy is what detects a silent edit.
		expect(TOOL_FOR_ENGINE).toEqual(expectedToolForEngine);

		const drift = Object.entries(expectedToolForEngine).flatMap(([engine, tool]) => {
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

describe('on-demand engine CLIs', () => {
	const cliEntries = Object.entries(ENGINE_CLI).map(([tool, spec]) => ({ tool: tool as ToolId, spec }));

	test('the registry is non-empty', () => {
		// Open Code is the one engine that needs a CLI; an emptied registry would
		// make every check below vacuous and re-open the bug it exists to prevent.
		expect(cliEntries.length).toBeGreaterThan(0);
	});

	test('every CLI is pinned through a declared, exact SDK version', () => {
		// A CLI is not in package.json (it is a platform binary weighing hundreds
		// of megabytes), so its version rides on the SDK it ships with or is
		// released in lockstep with. If that source is missing or floated, a
		// separately-installed CLI lands at @latest against a pinned SDK.
		const unpinned = cliEntries
			.filter(({ spec }) => !/^\d+\.\d+\.\d+/.test(declared[spec.versionSource] ?? ''))
			.map(({ tool, spec }) => `${tool}: pins via "${spec.versionSource}" (${declared[spec.versionSource]})`);

		expect(unpinned).toEqual([]);

		for (const { spec } of cliEntries) {
			expect(getRequiredCliVersion(spec)).toBe(declared[spec.versionSource]!);
		}
	});

	test('the installer installs a separate CLI alongside the SDK', () => {
		// Installing the SDK alone is exactly the half-install that reported
		// "installed" in Settings → Stack and then failed at the first spawn.
		// CLIs bundled with their SDK need no extra package and must not add one.
		for (const { tool, spec } of cliEntries) {
			const args = engineInstallArgs(tool);
			if (spec.installPackage) {
				expect(args).toContain(`${spec.installPackage}@${declared[spec.versionSource]}`);
			} else {
				expect(args).toEqual(ENGINE_PACKAGES[tool]!.map(name => `${name}@${declared[name]}`));
			}
		}
	});

	test('only an engine-blocking CLI gates the install state', () => {
		// `required` decides whether a missing binary makes Settings → Stack report
		// the engine as not installed. Marking a bundled CLI required would flip a
		// working engine to "not installed" the moment our own path guess drifts
		// from the SDK's; leaving Open Code's optional would restore the original
		// bug, where an unspawnable engine reported itself ready.
		const required = cliEntries.filter(({ spec }) => spec.required).map(({ tool }) => tool);
		expect(required).toEqual(['opencode']);
	});

	test('the managed dir trusts every CLI postinstall', () => {
		// bun blocks postinstall scripts for untrusted packages, and these CLIs
		// ship a stub whose postinstall copies the real binary into place.
		const dir = mkdtempSync(join(tmpdir(), 'clopen-stack-'));
		ensureStackProject(dir);

		const created = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { trustedDependencies?: string[] };
		expect(created.trustedDependencies).toEqual(engineCliTrustedPackages().sort());
	});

	test('an older managed dir is upgraded in place', () => {
		// Machines bootstrapped by earlier builds already have a package.json
		// without the field; merging (not just creating) is what repairs them.
		const dir = mkdtempSync(join(tmpdir(), 'clopen-stack-'));
		writeFileSync(
			join(dir, 'package.json'),
			JSON.stringify({ name: 'clopen-stack-engines', private: true, version: '0.0.0', dependencies: { '@opencode-ai/sdk': '1.18.18' } })
		);

		ensureStackProject(dir);

		const merged = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
			dependencies?: Record<string, string>;
			trustedDependencies?: string[];
		};
		expect(merged.dependencies).toEqual({ '@opencode-ai/sdk': '1.18.18' });
		for (const pkg of engineCliTrustedPackages()) {
			expect(merged.trustedDependencies).toContain(pkg);
		}
	});
});
