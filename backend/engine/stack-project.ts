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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
