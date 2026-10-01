/**
 * Managed stack project bootstrap
 *
 * `~/.clopen/stack/engines` is a minimal bun project. A package.json must exist
 * there before `bun add` runs, or bun walks up the tree and installs into
 * whatever project happens to contain the directory.
 *
 * It must also declare `trustedDependencies`. bun blocks postinstall scripts
 * for untrusted packages, and an engine CLI package ships only a stub — its
 * real binary is copied into place by exactly that postinstall. Without the
 * entry the install still reports success and leaves behind a shell script that
 * prints "postinstall script was not run", which is precisely the half-installed
 * state that used to reach the adapter.
 *
 * Both install paths (the user-triggered runner and the startup bootstrap) go
 * through here, and the file is MERGED rather than only created, so a stack dir
 * written by an older clopen picks the field up on its next install.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '$shared/utils/logger';
import { engineCliTrustedPackages } from './engine-cli';

interface StackPackageJson {
	name?: string;
	private?: boolean;
	version?: string;
	trustedDependencies?: string[];
	[key: string]: unknown;
}

const BASE: StackPackageJson = {
	name: 'clopen-stack-engines',
	private: true,
	version: '0.0.0'
};

function readExisting(path: string): StackPackageJson | null {
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as StackPackageJson;
		}
	} catch {
		// Corrupt file: fall through and rewrite from the base template rather
		// than leaving a package.json bun will choke on.
	}
	return null;
}

/**
 * Ensure `dir` is a bun project that trusts every engine CLI package. Safe to
 * call repeatedly; writes only when the file is missing or would change.
 */
export function ensureStackProject(dir: string): void {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'package.json');

	const existing = readExisting(path);
	const merged: StackPackageJson = { ...BASE, ...(existing ?? {}) };

	const trusted = new Set([...(merged.trustedDependencies ?? []), ...engineCliTrustedPackages()]);
	merged.trustedDependencies = [...trusted].sort();

	const next = JSON.stringify(merged, null, 2) + '\n';
	if (existing !== null && readFileSync(path, 'utf8') === next) return;

	writeFileSync(path, next);
	debug.log('engine', `Stack project package.json ${existing ? 'updated' : 'created'}: ${path}`);
}

/**
 * Dependencies declared in the stack project that clopen no longer installs.
 * `bun add` only ever adds or re-pins, so a package dropped from the engine
 * package list stays declared — and installed — forever without this.
 */
export function staleStackDependencies(dir: string, known: Set<string>): string[] {
	const existing = readExisting(join(dir, 'package.json'));
	const deps = existing?.dependencies;
	if (!deps || typeof deps !== 'object') return [];
	return Object.keys(deps as Record<string, string>).filter(name => !known.has(name)).sort();
}

/** Top-level package names the stack project's bun.lock resolves, or null if unreadable. */
function lockedPackages(dir: string): Set<string> | null {
	try {
		const lock = Bun.JSONC.parse(readFileSync(join(dir, 'bun.lock'), 'utf8')) as { packages?: Record<string, unknown> };
		if (!lock.packages || typeof lock.packages !== 'object') return null;
		// Nested installs are keyed `parent/child` (or `@scope/parent/child`);
		// only the hoisted top level maps onto `node_modules/<name>`.
		return new Set(Object.keys(lock.packages).filter(key => key.split('/').length === (key.startsWith('@') ? 2 : 1)));
	} catch {
		return null;
	}
}

/**
 * Delete package directories under the stack's node_modules that bun.lock no
 * longer resolves, plus `.bin` links left pointing at them.
 *
 * bun never removes them itself: dropping a package that carried per-platform
 * optional dependencies leaves the platform package behind, even through
 * `bun install --force`. Copilot's old CLI left ~330 MB this way. The lockfile
 * is the authority — without a readable one nothing is touched.
 */
export function sweepOrphanedModules(dir: string): string[] {
	const locked = lockedPackages(dir);
	const modules = join(dir, 'node_modules');
	if (!locked || !existsSync(modules)) return [];

	const installed: string[] = [];
	for (const entry of readdirSync(modules)) {
		if (entry.startsWith('.')) continue;
		if (entry.startsWith('@')) {
			for (const name of readdirSync(join(modules, entry))) installed.push(`${entry}/${name}`);
		} else {
			installed.push(entry);
		}
	}

	const removed = installed.filter(name => !locked.has(name)).sort();
	for (const name of removed) {
		rmSync(join(modules, name), { recursive: true, force: true });
	}

	const bin = join(modules, '.bin');
	if (removed.length > 0 && existsSync(bin)) {
		for (const link of readdirSync(bin)) {
			const path = join(bin, link);
			try {
				statSync(path);
			} catch {
				if (lstatSync(path).isSymbolicLink()) rmSync(path, { force: true });
			}
		}
	}

	if (removed.length > 0) debug.log('engine', `Swept orphaned stack packages: ${removed.join(', ')}`);
	return removed;
}
