/**
 * File Watcher Service
 *
 * Real-time file system watcher using Node's fs.watch (compatible with Bun)
 * Features:
 * - Per-project watcher management
 * - Debounced events to prevent spam
 * - Automatic cleanup on unwatch
 * - Cross-platform support (Windows/Unix)
 */

import { watch, type FSWatcher, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, relative, normalize, sep } from 'node:path';
import { ws } from '$backend/lib/utils/ws';
import { debug } from '$shared/utils/logger';
import type { FileChange } from '$shared/types/filesystem';

/**
 * Debounce configuration
 */
const DEBOUNCE_MS = 300; // Debounce file change events

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
	watcher: FSWatcher;
	projectPath: string;
	projectId: string;
	debounceTimer: ReturnType<typeof setTimeout> | null;
	pendingChanges: Map<string, FileChange>;
	subWatchers: Map<string, FSWatcher>;
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
	 * Start watching a project directory
	 */
	async startWatching(projectId: string, projectPath: string): Promise<boolean> {
		// Already watching this project
		if (this.watchers.has(projectId)) {
			debug.log('file', `Already watching project: ${projectId}`);
			return true;
		}

		try {
			// Normalize path
			const normalizedPath = normalize(projectPath);

			// Verify path exists and is a directory
			const pathStat = await stat(normalizedPath);
			if (!pathStat.isDirectory()) {
				debug.error('file', `Path is not a directory: ${normalizedPath}`);
				return false;
			}

			// Create main watcher for project root
			const watcher = watch(normalizedPath, { recursive: true }, (eventType, filename) => {
				if (filename) {
					this.handleFileChange(projectId, normalizedPath, filename, eventType);
				}
			});

			// Handle watcher errors
			watcher.on('error', (error) => {
				debug.error('file', `Watcher error for project ${projectId}:`, error);
				// Try to emit error to clients
				ws.emit.project(projectId, 'files:watch-error', {
					projectId,
					error: error.message || 'File watcher error'
				});
			});

			// Store watcher instance
			const projectWatcher: ProjectWatcher = {
				watcher,
				projectPath: normalizedPath,
				projectId,
				debounceTimer: null,
				pendingChanges: new Map(),
				subWatchers: new Map(),
				gitWatcher: null,
				gitRefsWatcher: null,
				gitDebounceTimer: null
			};
			this.watchers.set(projectId, projectWatcher);

			// Start git state watcher (for external git operations)
			this.startGitWatcher(projectId, normalizedPath);

			debug.log('file', `Started watching project: ${projectId} at ${normalizedPath}`);
			return true;
		} catch (error) {
			debug.error('file', `Failed to start watching project ${projectId}:`, error);
			return false;
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
			// Close main watcher
			projectWatcher.watcher.close();

			// Close all sub-watchers
			for (const subWatcher of projectWatcher.subWatchers.values()) {
				subWatcher.close();
			}

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
	 * Handle file change event
	 */
	private async handleFileChange(
		projectId: string,
		projectPath: string,
		filename: string,
		eventType: string
	): Promise<void> {
		const projectWatcher = this.watchers.get(projectId);
		if (!projectWatcher) return;

		// Normalize filename to use forward slashes for consistency
		const normalizedFilename = filename.replace(/\\/g, '/');

		// Check if should be ignored
		if (this.shouldIgnore(normalizedFilename)) {
			return;
		}

		// Build full path
		const fullPath = join(projectPath, filename);

		// Determine change type
		let changeType: 'created' | 'modified' | 'deleted';
		if (eventType === 'change') {
			changeType = 'modified';
		} else {
			// 'rename' event — check if file exists to distinguish create from delete
			try {
				await stat(fullPath);
				changeType = 'created';
			} catch {
				changeType = 'deleted';
			}
		}

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

			// Watch .git/refs/ for branch/tag create/delete
			const refsDir = join(gitDir, 'refs');
			if (existsSync(refsDir)) {
				projectWatcher.gitRefsWatcher = watch(refsDir, { recursive: true }, (_eventType, _filename) => {
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
