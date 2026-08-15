/**
 * File Watcher Service
 *
 * Real-time file system watcher using Node's fs.watch (compatible with Bun)
 * Features:
 * - Per-project watcher management
 * - Debounced events to prevent spam
 * - Automatic cleanup on unwatch
 * - Cross-platform support (Windows/Unix)
 *
 * Watching strategy, per platform:
 *
 * macOS and Windows get a single `{ recursive: true }` watch on the project
 * root. Both back it with one OS-level handle (FSEvents / ReadDirectoryChangesW)
 * that covers the whole subtree, so recursion is essentially free and pruning
 * would buy nothing.
 *
 * Linux cannot do that. There, recursion is emulated with inotify and costs one
 * kernel watch per directory, with no way to exclude any of them. A project
 * containing `node_modules` blows past `fs.inotify.max_user_watches`; the
 * watcher faults with ENOSPC, gets rebuilt, and faults again — an endless
 * restart loop that pegged the CPU and, because each restart announced itself as
 * a file change, made clients reload every few seconds with nothing actually
 * changing. So on Linux we walk the tree ourselves and never watch an ignored
 * directory, which removes the overwhelming majority of the watch descriptors.
 */

/** Whether the platform's recursive `fs.watch` is a single cheap OS handle. */
const USE_NATIVE_RECURSIVE_WATCH = process.platform !== 'linux';

import { watch, type FSWatcher, existsSync } from 'node:fs';
import { stat, readdir } from 'node:fs/promises';
import { join, relative, normalize, sep } from 'node:path';
import { ws } from '$backend/utils/ws';
import { debug } from '$shared/utils/logger';
import type { FileChange } from '$shared/types/filesystem';

/**
 * Debounce configuration
 */
const DEBOUNCE_MS = 300; // Debounce file change events

/**
 * Hard ceiling on directory watches per project (Linux manual recursion only).
 * Even with ignored directories pruned, a pathological tree (generated code, a
 * huge monorepo) could still exhaust `max_user_watches`. Stop adding watches
 * past this point and tell the client its view may go stale, rather than
 * faulting into the restart loop this whole design exists to prevent.
 */
const MAX_WATCHED_DIRS = 4000;

/** Restart backoff after a watcher fault: 1s, 2s, 4s, 8s, then give up. */
const RESTART_DELAYS_MS = [1000, 2000, 4000, 8000];

/** How long a rebuilt watcher must survive before its fault count is forgiven. */
const FAULT_FORGIVENESS_MS = 60_000;

/**
 * Directories to ignore when watching
 */
const IGNORED_DIRS = new Set([
	'node_modules',
	'.git',
	'.svelte-kit',
	'dist',
	'build',
	'.next',
	'.nuxt',
	'.output',
	'__pycache__',
	'.pytest_cache',
	'coverage',
	'.nyc_output',
	'.turbo',
	'.cache',
	'.temp',
	'.tmp',
	'vendor'
]);

/**
 * Files to ignore
 */
const IGNORED_FILES = new Set([
	'.DS_Store',
	'Thumbs.db',
	'.gitkeep',
	'.gitignore~'
]);

/**
 * Git state files to watch for external git operations
 */
const GIT_STATE_FILES = ['index', 'HEAD', 'MERGE_HEAD', 'REBASE_HEAD'];
const GIT_DEBOUNCE_MS = 500;

/**
 * Watcher instance for a project
 */
interface ProjectWatcher {
	projectPath: string;
	projectId: string;
	debounceTimer: ReturnType<typeof setTimeout> | null;
	pendingChanges: Map<string, FileChange>;
	/** Absolute directory path -> its (non-recursive) watcher. Includes the root. */
	dirWatchers: Map<string, FSWatcher>;
	/** Set once MAX_WATCHED_DIRS was hit, so the warning is emitted only once. */
	truncated: boolean;
	/** Consecutive watcher faults; reset after a clean restart. */
	faults: number;
	/** Flipped by stopWatching so in-flight async tree walks bail out. */
	closed: boolean;
	gitWatcher: FSWatcher | null;
	gitRefsWatcher: FSWatcher | null;
	gitDebounceTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * File Watcher Manager
 * Manages file watchers per project
 */
class FileWatcherManager {
	private watchers = new Map<string, ProjectWatcher>();

	/**
	 * Per-project set of connection ids currently viewing the project.
	 * The watcher is a shared singleton per project; it must stay alive while
	 * ANY connection is viewing (multi-tab / multi-device) and be torn down
	 * only when the last viewer leaves. Reference-counting here avoids the
	 * previous bug where one viewer's unwatch killed the watcher for everyone,
	 * and where switching projects leaked orphaned watchers.
	 */
	private viewers = new Map<string, Set<string>>();

	/** Projects with an in-flight auto-restart, to avoid overlapping restarts. */
	private restarting = new Set<string>();

	/**
	 * Per-project dirty file tracking for snapshot system.
	 * Accumulates changed file relative paths between snapshot captures.
	 */
	private dirtyFiles = new Map<string, Set<string>>();

	/**
	 * Get dirty files accumulated since last clear for a project.
	 */
	getDirtyFiles(projectId: string): Set<string> {
		return this.dirtyFiles.get(projectId) || new Set();
	}

	/**
	 * Clear dirty files after snapshot capture.
	 */
	clearDirtyFiles(projectId: string): void {
		this.dirtyFiles.delete(projectId);
	}

	/**
	 * Track a file as dirty for snapshot purposes.
	 */
	private trackDirtyFile(projectId: string, relativePath: string): void {
		if (!this.dirtyFiles.has(projectId)) {
			this.dirtyFiles.set(projectId, new Set());
		}
		this.dirtyFiles.get(projectId)!.add(relativePath);
	}

	/**
	 * Register a connection as a viewer of a project and ensure a watcher is
	 * running. Returns true if the project is being watched after the call.
	 */
	async addViewer(connId: string, projectId: string, projectPath: string): Promise<boolean> {
		if (!this.viewers.has(projectId)) {
			this.viewers.set(projectId, new Set());
		}
		this.viewers.get(projectId)!.add(connId);

		if (this.watchers.has(projectId)) return true;
		return this.startWatching(projectId, projectPath);
	}

	/**
	 * Remove a connection as a viewer of a project. Stops the watcher only when
	 * no viewers remain.
	 */
	removeViewer(connId: string, projectId: string): void {
		const set = this.viewers.get(projectId);
		if (!set) return;
		set.delete(connId);
		if (set.size === 0) {
			this.viewers.delete(projectId);
			this.stopWatching(projectId);
		}
	}

	/**
	 * Remove a connection from every project it was viewing. Called on hard
	 * disconnect (tab close, network drop) where no explicit unwatch arrives.
	 */
	removeViewerFromAll(connId: string): void {
		for (const projectId of Array.from(this.viewers.keys())) {
			this.removeViewer(connId, projectId);
		}
	}

	/** In-flight start promises, to coalesce concurrent start requests. */
	private starting = new Map<string, Promise<boolean>>();

	/**
	 * Start watching a project directory. Concurrent calls for the same project
	 * are coalesced: `fs.watch` setup awaits a `stat`, so without this guard two
	 * near-simultaneous viewers (e.g. two devices) could each build a watcher and
	 * leak one.
	 */
	async startWatching(projectId: string, projectPath: string, faults = 0): Promise<boolean> {
		// Already watching this project
		if (this.watchers.has(projectId)) {
			debug.log('file', `Already watching project: ${projectId}`);
			return true;
		}

		const inflight = this.starting.get(projectId);
		if (inflight) return inflight;

		const startPromise = this.doStartWatching(projectId, projectPath, faults);
		this.starting.set(projectId, startPromise);
		try {
			return await startPromise;
		} finally {
			this.starting.delete(projectId);
		}
	}

	private async doStartWatching(
		projectId: string,
		projectPath: string,
		faults = 0
	): Promise<boolean> {
		try {
			// Normalize path
			const normalizedPath = normalize(projectPath);

			// Verify path exists and is a directory
			const pathStat = await stat(normalizedPath);
			if (!pathStat.isDirectory()) {
				debug.error('file', `Path is not a directory: ${normalizedPath}`);
				return false;
			}

			const projectWatcher: ProjectWatcher = {
				projectPath: normalizedPath,
				projectId,
				debounceTimer: null,
				pendingChanges: new Map(),
				dirWatchers: new Map(),
				truncated: false,
				faults,
				closed: false,
				gitWatcher: null,
				gitRefsWatcher: null,
				gitDebounceTimer: null
			};
			this.watchers.set(projectId, projectWatcher);

			// Watch the root synchronously so events are never missed while the
			// (async) subtree walk is still in progress.
			if (!this.watchDir(projectWatcher, normalizedPath)) {
				this.watchers.delete(projectId);
				return false;
			}

			// Start git state watcher (for external git operations)
			this.startGitWatcher(projectId, normalizedPath);

			// On Linux the root watch only covers the root itself. Walk the tree in
			// the background so every non-ignored directory gets its own watch;
			// elsewhere the root's recursive handle already covers everything.
			if (!USE_NATIVE_RECURSIVE_WATCH) {
				void this.watchSubtree(projectWatcher, normalizedPath);
			}

			// Forgive earlier faults once a rebuild has held steady, so an isolated
			// hiccup much later still gets the full retry budget instead of
			// inheriting an exhausted one.
			if (faults > 0) {
				setTimeout(() => {
					if (this.watchers.get(projectId) === projectWatcher) projectWatcher.faults = 0;
				}, FAULT_FORGIVENESS_MS);
			}

			debug.log('file', `Started watching project: ${projectId} at ${normalizedPath}`);
			return true;
		} catch (error) {
			debug.error('file', `Failed to start watching project ${projectId}:`, error);
			return false;
		}
	}

	/**
	 * Attach a non-recursive watcher to a single directory.
	 * Returns false when the directory could not be watched (gone, permission
	 * denied, or the per-project ceiling was reached).
	 */
	private watchDir(pw: ProjectWatcher, dir: string): boolean {
		if (pw.closed || pw.dirWatchers.has(dir)) return true;

		if (pw.dirWatchers.size >= MAX_WATCHED_DIRS) {
			if (!pw.truncated) {
				pw.truncated = true;
				debug.warn(
					'file',
					`Watch ceiling (${MAX_WATCHED_DIRS} dirs) reached for project ${pw.projectId}; deeper directories will not report changes`
				);
				ws.emit.project(pw.projectId, 'files:watch-error', {
					projectId: pw.projectId,
					error: `Project is too large to watch entirely (${MAX_WATCHED_DIRS}+ directories). Changes in deeply nested folders may not appear automatically.`
				});
			}
			return false;
		}

		try {
			// The root watch is recursive where that's a single OS handle; every
			// other watch (and every Linux watch) covers exactly one directory.
			// Either way `filename` arrives relative to `dir`, so the change handler
			// resolves it the same way.
			const recursive = USE_NATIVE_RECURSIVE_WATCH && dir === pw.projectPath;
			const watcher = watch(dir, { recursive }, (eventType, filename) => {
				if (filename) this.handleFileChange(pw.projectId, dir, filename, eventType);
			});

			// fs.watch can fault (and on some platforms go silently deaf) under heavy
			// churn or after sleep/wake. A fault on a nested directory only costs us
			// that subtree, so drop it quietly; a fault on the root means the project
			// is unwatched and warrants a full rebuild.
			watcher.on('error', (error) => {
				if (dir === pw.projectPath) {
					debug.error('file', `Watcher error for project ${pw.projectId}:`, error);
					ws.emit.project(pw.projectId, 'files:watch-error', {
						projectId: pw.projectId,
						error: error.message || 'File watcher error'
					});
					this.scheduleRestart(pw.projectId);
				} else {
					debug.warn('file', `Dropping faulted watcher for ${dir}:`, error);
					this.unwatchDir(pw, dir);
				}
			});

			pw.dirWatchers.set(dir, watcher);
			return true;
		} catch (error) {
			// ENOENT/EACCES on a nested directory is normal (it may have vanished
			// between readdir and watch); only the root failing is fatal.
			if (dir === pw.projectPath) {
				debug.error('file', `Failed to watch project root ${dir}:`, error);
				return false;
			}
			debug.log('file', `Skipped unwatchable directory ${dir}`);
			return false;
		}
	}

	/**
	 * Close the watcher for `dir` and every directory beneath it.
	 * Called when a directory is deleted or renamed away.
	 */
	private unwatchDir(pw: ProjectWatcher, dir: string): void {
		const prefix = dir.endsWith(sep) ? dir : dir + sep;
		for (const [watched, watcher] of pw.dirWatchers) {
			if (watched !== dir && !watched.startsWith(prefix)) continue;
			try {
				watcher.close();
			} catch {
				// Already closed — nothing to do.
			}
			pw.dirWatchers.delete(watched);
		}
	}

	/**
	 * Recursively attach watchers to every non-ignored directory under `dir`.
	 * Ignored directories (node_modules, .git, build output, …) are never
	 * descended into — that pruning is what keeps the watch count survivable.
	 */
	private async watchSubtree(pw: ProjectWatcher, dir: string): Promise<void> {
		if (pw.closed) return;

		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return; // Directory vanished or is unreadable — nothing to watch.
		}

		for (const entry of entries) {
			if (pw.closed) return;
			if (!entry.isDirectory()) continue;

			const childPath = join(dir, entry.name);
			const relativePath = relative(pw.projectPath, childPath).replace(/\\/g, '/');
			if (this.shouldIgnore(relativePath)) continue;

			if (!this.watchDir(pw, childPath)) {
				// Ceiling reached — stop descending entirely rather than watching an
				// arbitrary subset that depends on directory ordering.
				if (pw.truncated) return;
				continue;
			}
			await this.watchSubtree(pw, childPath);
		}
	}

	/**
	 * Stop watching a project directory
	 */
	stopWatching(projectId: string): boolean {
		const projectWatcher = this.watchers.get(projectId);
		if (!projectWatcher) {
			debug.log('file', `Not watching project: ${projectId}`);
			return false;
		}

		try {
			// Stop any in-flight subtree walk from re-adding watchers behind us.
			projectWatcher.closed = true;

			// Close every directory watcher (the root included)
			for (const dirWatcher of projectWatcher.dirWatchers.values()) {
				try {
					dirWatcher.close();
				} catch {
					// Already closed — nothing to do.
				}
			}
			projectWatcher.dirWatchers.clear();

			// Close git watchers
			projectWatcher.gitWatcher?.close();
			projectWatcher.gitRefsWatcher?.close();

			// Clear debounce timers
			if (projectWatcher.debounceTimer) {
				clearTimeout(projectWatcher.debounceTimer);
			}
			if (projectWatcher.gitDebounceTimer) {
				clearTimeout(projectWatcher.gitDebounceTimer);
			}

			// Remove from map
			this.watchers.delete(projectId);

			debug.log('file', `Stopped watching project: ${projectId}`);
			return true;
		} catch (error) {
			debug.error('file', `Error stopping watcher for project ${projectId}:`, error);
			return false;
		}
	}

	/**
	 * Fully release a project: drop all viewers and any pending restart, then
	 * stop the watcher. Used when a project is removed entirely (not just when a
	 * single viewer navigates away).
	 */
	releaseProject(projectId: string): void {
		this.viewers.delete(projectId);
		this.restarting.delete(projectId);
		this.stopWatching(projectId);
	}

	/**
	 * Check if a project is being watched
	 */
	isWatching(projectId: string): boolean {
		return this.watchers.has(projectId);
	}

	/**
	 * Get all watched project IDs
	 */
	getWatchedProjects(): string[] {
		return Array.from(this.watchers.keys());
	}

	/**
	 * Handle a change reported by the watcher on `dir`.
	 * `filename` is relative to `dir`, not to the project root.
	 */
	private async handleFileChange(
		projectId: string,
		dir: string,
		filename: string,
		eventType: string
	): Promise<void> {
		const projectWatcher = this.watchers.get(projectId);
		if (!projectWatcher || projectWatcher.closed) return;

		// Build full path, then derive the project-relative path — the ignore rules
		// are defined against the project root, and `filename` is only relative to
		// the directory that reported it.
		const fullPath = join(dir, filename);
		const relativePath = relative(projectWatcher.projectPath, fullPath).replace(/\\/g, '/');

		// Paths outside the project (possible on some platforms for rename events)
		// and ignored paths never reach clients.
		if (relativePath.startsWith('..') || this.shouldIgnore(relativePath)) {
			return;
		}

		// Determine change type
		let changeType: 'created' | 'modified' | 'deleted';
		let isDirectory = false;
		if (eventType === 'change') {
			changeType = 'modified';
		} else {
			// 'rename' event — check if file exists to distinguish create from delete
			try {
				const entryStat = await stat(fullPath);
				isDirectory = entryStat.isDirectory();
				changeType = 'created';
			} catch {
				changeType = 'deleted';
			}
		}

		// Where recursion is emulated, keep the watch set in step with the tree: a
		// new directory needs its own watcher, and a removed one must release its
		// descendants' watchers so they can't leak.
		if (!USE_NATIVE_RECURSIVE_WATCH) {
			if (isDirectory && changeType === 'created') {
				if (this.watchDir(projectWatcher, fullPath)) {
					void this.watchSubtree(projectWatcher, fullPath);
				}
			} else if (changeType === 'deleted' && projectWatcher.dirWatchers.has(fullPath)) {
				this.unwatchDir(projectWatcher, fullPath);
			}
		}

		// Track dirty file for snapshot system
		this.trackDirtyFile(projectId, relativePath);

		// Create file change object
		const fileChange: FileChange = {
			path: fullPath,
			type: changeType,
			timestamp: new Date().toISOString()
		};

		// Add to pending changes (using path as key to dedupe)
		projectWatcher.pendingChanges.set(fullPath, fileChange);

		// Debounce: clear existing timer and set new one
		if (projectWatcher.debounceTimer) {
			clearTimeout(projectWatcher.debounceTimer);
		}

		projectWatcher.debounceTimer = setTimeout(() => {
			this.flushPendingChanges(projectId);
		}, DEBOUNCE_MS);
	}

	/**
	 * Check if a file/directory should be ignored
	 */
	private shouldIgnore(filename: string): boolean {
		const parts = filename.split('/');

		// Check each path segment
		for (const part of parts) {
			if (IGNORED_DIRS.has(part) || IGNORED_FILES.has(part)) {
				return true;
			}
			// Ignore hidden files and directories (except .env files)
			if (part.startsWith('.') && !part.startsWith('.env')) {
				return true;
			}
		}

		return false;
	}


	/**
	 * Flush pending changes to clients
	 */
	private flushPendingChanges(projectId: string): void {
		const projectWatcher = this.watchers.get(projectId);
		if (!projectWatcher || projectWatcher.pendingChanges.size === 0) return;

		// Convert pending changes to array
		const changes = Array.from(projectWatcher.pendingChanges.values());

		// Clear pending changes
		projectWatcher.pendingChanges.clear();
		projectWatcher.debounceTimer = null;

		// Emit changes to users currently viewing the project
		ws.emit.project(projectId, 'files:changed', {
			projectId,
			changes,
			timestamp: Date.now()
		});

		debug.log(
			'file',
			`Emitted ${changes.length} file changes for project ${projectId}`
		);
	}

	/**
	 * Start watching .git directory for external git operations
	 * Watches: .git/index (staging), .git/HEAD (branch switch), .git/refs/ (branches/tags)
	 */
	private startGitWatcher(projectId: string, projectPath: string): void {
		const projectWatcher = this.watchers.get(projectId);
		if (!projectWatcher) return;

		const gitDir = join(projectPath, '.git');
		if (!existsSync(gitDir)) return;

		try {
			// Watch .git/ root for index, HEAD, MERGE_HEAD changes
			projectWatcher.gitWatcher = watch(gitDir, (eventType, filename) => {
				if (!filename) return;
				const normalized = filename.replace(/\\/g, '/');
				if (GIT_STATE_FILES.includes(normalized)) {
					this.emitGitChanged(projectId);
				}
			});
			projectWatcher.gitWatcher.on('error', () => {
				// Silently ignore git watcher errors
			});

			// Watch .git/refs/ for branch/tag create/delete. Lock files are git's
			// own write-in-progress scratch space: every ref update produces a
			// `<ref>.lock` create AND delete, so forwarding them doubled the churn
			// and fired a refresh before the ref itself had landed.
			const refsDir = join(gitDir, 'refs');
			if (existsSync(refsDir)) {
				projectWatcher.gitRefsWatcher = watch(refsDir, { recursive: true }, (_eventType, filename) => {
					if (filename && filename.replace(/\\/g, '/').endsWith('.lock')) return;
					this.emitGitChanged(projectId);
				});
				projectWatcher.gitRefsWatcher.on('error', () => {
					// Silently ignore refs watcher errors
				});
			}

			debug.log('file', `Started git watcher for project: ${projectId}`);
		} catch (err) {
			debug.warn('file', `Failed to start git watcher for project ${projectId}:`, err);
		}
	}

	/**
	 * Debounced emit of git:changed event
	 */
	private emitGitChanged(projectId: string): void {
		const projectWatcher = this.watchers.get(projectId);
		if (!projectWatcher) return;

		if (projectWatcher.gitDebounceTimer) {
			clearTimeout(projectWatcher.gitDebounceTimer);
		}

		projectWatcher.gitDebounceTimer = setTimeout(() => {
			projectWatcher.gitDebounceTimer = null;
			ws.emit.project(projectId, 'git:changed', {
				projectId,
				timestamp: Date.now()
			});
			debug.log('file', `Emitted git:changed for project ${projectId}`);
		}, GIT_DEBOUNCE_MS);
	}

	/**
	 * Schedule a rebuild of a project's watcher after a fault, backing off on
	 * each consecutive failure and giving up once the backoff is exhausted.
	 *
	 * The backoff matters: a fault whose cause is structural (the platform watch
	 * limit, a permission change) reproduces immediately on restart. A fixed 1s
	 * retry turned that into an endless rebuild loop that pegged the CPU and,
	 * because each restart announced itself as a file change, made every client
	 * reload its editor every second.
	 */
	private scheduleRestart(projectId: string): void {
		if (this.restarting.has(projectId)) return;
		// Only restart if someone is still viewing the project.
		if (!this.viewers.get(projectId)?.size) return;

		const current = this.watchers.get(projectId);
		if (!current) return;

		const attempt = current.faults;
		const delay = RESTART_DELAYS_MS[attempt];
		if (delay === undefined) {
			debug.error(
				'file',
				`Watcher for project ${projectId} faulted ${attempt} times; giving up on automatic restart`
			);
			ws.emit.project(projectId, 'files:watch-error', {
				projectId,
				error: 'File watching stopped after repeated failures. Refresh to retry.'
			});
			return;
		}

		this.restarting.add(projectId);

		setTimeout(async () => {
			this.restarting.delete(projectId);
			if (!this.viewers.get(projectId)?.size) return;

			const projectPath = this.watchers.get(projectId)?.projectPath;
			if (!projectPath) return;

			debug.warn(
				'file',
				`Restarting faulted watcher for project ${projectId} (attempt ${attempt + 1})`
			);
			this.stopWatching(projectId);
			const ok = await this.startWatching(projectId, projectPath, attempt + 1);
			if (!ok) return;

			// A faulted watcher may have dropped events while down. Ask clients to
			// reconcile — deliberately NOT via `files:changed`, which means "these
			// specific paths changed" and made consumers tear down and rebuild live
			// views (the open diff editor) on every restart.
			ws.emit.project(projectId, 'files:resync', {
				projectId,
				timestamp: Date.now()
			});
		}, delay);
	}

	/**
	 * Stop all watchers (cleanup)
	 */
	stopAll(): void {
		for (const projectId of this.watchers.keys()) {
			this.stopWatching(projectId);
		}
		debug.log('file', 'Stopped all file watchers');
	}
}

// Export singleton instance
export const fileWatcher = new FileWatcherManager();
