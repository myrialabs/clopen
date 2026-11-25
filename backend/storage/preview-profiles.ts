/**
 * Preview Browser profiles: one Chrome user-data dir per workspace, named
 * `<scope slug>-<sha256(scope key) prefix>` with a `.cookies` file beside it.
 *
 * A workspace is a project or one of its worktrees (`makeScopeKey`), so every
 * profile that belongs to something that still exists can be named exactly;
 * anything else in the folder is left over from a deleted project or worktree,
 * or from a tab opened without a workspace.
 *
 * Chrome must not be running on a profile while its files are removed. Profiles
 * with a live browser are skipped by every operation here except a full wipe,
 * which closes the browser first (`browserPool.clearBrowsingData`).
 */

import fs from 'node:fs/promises';
import { join } from 'node:path';
import { projectQueries, worktreeQueries } from '$backend/database/queries';
import { browserPool, profileDirName, profilesRoot } from '$backend/preview/browser/browser-pool';
import { makeScopeKey } from '$shared/utils/workspace-scope';
import { debug } from '$shared/utils/logger';
import { measurePath, removePath } from './fs-size';

/**
 * What Chrome's own "Cached images and files" clears, plus the GPU and shader
 * caches it rebuilds on launch. Cookies, local storage, IndexedDB and service
 * worker registrations are site data and are NOT here — removing them signs the
 * user out, which only a full wipe may do.
 */
const CACHE_DIRS_IN_PROFILE = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Service Worker/ScriptCache'];
const CACHE_DIRS_AT_ROOT = ['GPUPersistentCache', 'GraphiteDawnCache', 'GrShaderCache', 'ShaderCache', 'component_crx_cache', 'extensions_crx_cache'];

export interface ProfileDir {
	name: string;
	path: string;
	bytes: number;
	cacheBytes: number;
	mtimeMs: number;
	/** The workspace this profile belongs to, when it still exists. */
	scope: { projectId: string; worktreeId: string | null } | null;
	running: boolean;
}

/** Profile folders (Default plus any other Chrome profile) inside a user-data dir. */
async function chromeProfiles(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries
			.filter(entry => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)))
			.map(entry => join(dir, entry.name));
	} catch {
		return [];
	}
}

function cachePaths(dir: string, profiles: string[]): string[] {
	return [
		...CACHE_DIRS_AT_ROOT.map(name => join(dir, name)),
		...profiles.flatMap(profile => CACHE_DIRS_IN_PROFILE.map(name => join(profile, name)))
	];
}

function knownScopes(): Map<string, { projectId: string; worktreeId: string | null }> {
	const scopes = new Map<string, { projectId: string; worktreeId: string | null }>();
	for (const project of projectQueries.getAll()) {
		scopes.set(profileDirName(makeScopeKey(project.id)), { projectId: project.id, worktreeId: null });
		for (const worktree of worktreeQueries.getByProjectId(project.id)) {
			scopes.set(profileDirName(makeScopeKey(project.id, worktree.id)), { projectId: project.id, worktreeId: worktree.id });
		}
	}
	return scopes;
}

function runningDirNames(): Set<string> {
	return new Set(browserPool.getRunningBrowsers().map(entry => profileDirName(entry.profileKey)));
}

export async function listProfileDirs(signal?: AbortSignal): Promise<ProfileDir[]> {
	const root = profilesRoot();
	let entries: import('node:fs').Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const scopes = knownScopes();
	const running = runningDirNames();
	const dirs: ProfileDir[] = [];
	for (const entry of entries) {
		if (signal?.aborted) break;
		if (!entry.isDirectory()) continue;
		const path = join(root, entry.name);
		const profiles = await chromeProfiles(path);
		let cacheBytes = 0;
		for (const cache of cachePaths(path, profiles)) cacheBytes += (await measurePath(cache)).bytes;
		const cookies = await fs.stat(`${path}.cookies`).catch(() => null);
		const stat = await fs.stat(path).catch(() => null);
		dirs.push({
			name: entry.name,
			path,
			bytes: (await measurePath(path, signal)).bytes + (cookies?.size ?? 0),
			cacheBytes,
			mtimeMs: Math.max(stat?.mtimeMs ?? 0, cookies?.mtimeMs ?? 0),
			scope: scopes.get(entry.name) ?? null,
			running: running.has(entry.name)
		});
	}
	return dirs;
}

/** Profiles that belong to no existing workspace. */
export function orphanProfiles(dirs: ProfileDir[]): ProfileDir[] {
	return dirs.filter(dir => !dir.scope && !dir.running);
}

export async function removeProfileDirs(dirs: ProfileDir[]): Promise<{ freedBytes: number; removed: number }> {
	let freedBytes = 0;
	let removed = 0;
	const running = runningDirNames();
	for (const dir of dirs) {
		if (running.has(dir.name)) continue;
		freedBytes += await removePath(dir.path);
		freedBytes += await removePath(`${dir.path}.cookies`);
		removed++;
	}
	return { freedBytes, removed };
}

/** Delete the caches of every profile whose browser is not running. Sign-ins stay. */
export async function clearProfileCaches(dirs: ProfileDir[]): Promise<{ freedBytes: number; cleared: number; skipped: number }> {
	let freedBytes = 0;
	let cleared = 0;
	let skipped = 0;
	const running = runningDirNames();
	for (const dir of dirs) {
		if (running.has(dir.name)) {
			skipped++;
			continue;
		}
		for (const cache of cachePaths(dir.path, await chromeProfiles(dir.path))) freedBytes += await removePath(cache);
		cleared++;
	}
	return { freedBytes, cleared, skipped };
}

/**
 * Wipe a workspace's profile completely — cookies, storage, sign-ins — closing
 * its browser first. Used when the workspace itself is going away.
 */
export async function wipeWorkspaceProfile(projectId: string, worktreeId?: string | null): Promise<number> {
	const key = makeScopeKey(projectId, worktreeId);
	const path = join(profilesRoot(), profileDirName(key));
	const { bytes } = await measurePath(path);
	try {
		await browserPool.clearBrowsingData(key);
	} catch (error) {
		debug.warn('storage', `Could not wipe the preview profile of ${key}:`, error);
		return 0;
	}
	return bytes;
}

/** Wipe the profiles of a project and all of its worktrees. */
export async function wipeProjectProfiles(projectId: string): Promise<number> {
	let freed = await wipeWorkspaceProfile(projectId);
	for (const worktree of worktreeQueries.getByProjectId(projectId)) {
		freed += await wipeWorkspaceProfile(projectId, worktree.id);
	}
	return freed;
}
