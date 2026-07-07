/**
 * System Operations
 *
 * HTTP endpoints for system-level operations:
 * - Clear all database data
 * - Check for package updates
 * - Run package update
 */

import { t } from 'elysia';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRouter } from '$shared/utils/ws-server';
import { closeDatabase, initializeDatabase } from '../../database';
import { debug } from '$shared/utils/logger';
import { ws } from '$backend/utils/ws';
import { getClopenDir } from '$backend/utils/index';
import { resetEnvironment } from '$backend/engine/adapters/claude/environment';

/** In-memory flag: set after successful update, cleared on server restart */
let pendingUpdate: { fromVersion: string; toVersion: string } | null = null;

/** Read current version from package.json */
function getCurrentVersion(): string {
	try {
		const packagePath = join(import.meta.dir, '..', '..', '..', 'package.json');
		const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'));
		return pkg.version || '0.0.0';
	} catch {
		return '0.0.0';
	}
}

/** Fetch latest version from npm registry */
async function fetchLatestVersion(): Promise<string> {
	const response = await fetch('https://registry.npmjs.org/@myrialabs/clopen/latest');
	if (!response.ok) {
		throw new Error(`npm registry returned ${response.status}`);
	}
	const data = await response.json() as { version: string };
	return data.version;
}

/** Simple semver comparison: returns true if latest > current */
function isNewerVersion(current: string, latest: string): boolean {
	const currentParts = current.split('.').map(Number);
	const latestParts = latest.split('.').map(Number);

	for (let i = 0; i < 3; i++) {
		const c = currentParts[i] || 0;
		const l = latestParts[i] || 0;
		if (l > c) return true;
		if (l < c) return false;
	}
	return false;
}

export const operationsHandler = createRouter()
	// Check for package updates
	.http('system:check-update', {
		data: t.Object({}),
		response: t.Object({
			currentVersion: t.String(),
			latestVersion: t.String(),
			updateAvailable: t.Boolean(),
			pendingRestart: t.Boolean(),
			pendingUpdate: t.Optional(t.Object({
				fromVersion: t.String(),
				toVersion: t.String()
			}))
		})
	}, async () => {
		const currentVersion = getCurrentVersion();
		debug.log('server', `Checking for updates... current version: ${currentVersion}`);

		const latestVersion = await fetchLatestVersion();
		const updateAvailable = isNewerVersion(currentVersion, latestVersion);

		debug.log('server', `Latest version: ${latestVersion}, update available: ${updateAvailable}`);

		return {
			currentVersion,
			latestVersion,
			updateAvailable,
			pendingRestart: pendingUpdate !== null,
			pendingUpdate: pendingUpdate ?? undefined
		};
	})

	// Fetch release notes from GitHub
	.http('system:get-release-notes', {
		data: t.Object({}),
		response: t.Object({
			tag_name: t.String(),
			body: t.String(),
			html_url: t.String(),
			published_at: t.String()
		})
	}, async () => {
		const response = await fetch('https://api.github.com/repos/myrialabs/clopen/releases/latest');
		if (!response.ok) {
			throw new Error(`GitHub API returned ${response.status}`);
		}
		const data = await response.json() as { tag_name: string; body: string; html_url: string; published_at: string };
		return {
			tag_name: data.tag_name,
			body: data.body || '',
			html_url: data.html_url,
			published_at: data.published_at
		};
	})

	// Run package update
	.http('system:run-update', {
		data: t.Object({}),
		response: t.Object({
			success: t.Boolean(),
			output: t.String(),
			newVersion: t.String()
		})
	}, async () => {
		debug.log('server', 'Running package update...');

		const proc = Bun.spawn(['bun', 'add', '-g', '@myrialabs/clopen@latest'], {
			stdout: 'pipe',
			stderr: 'pipe'
		});

		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text()
		]);

		const exitCode = await proc.exited;
		const output = (stdout + '\n' + stderr).trim();

		if (exitCode !== 0) {
			throw new Error(`Update failed (exit code ${exitCode}): ${output}`);
		}

		const fromVersion = getCurrentVersion();

		// Re-fetch to confirm new version
		const newVersion = await fetchLatestVersion();

		// Set pending restart flag (persists until server restarts)
		pendingUpdate = { fromVersion, toVersion: newVersion };

		// Broadcast to all connected clients
		ws.emit.global('system:update-completed', {
			fromVersion,
			toVersion: newVersion
		});

		debug.log('server', `Update completed. New version: ${newVersion}`);

		return { success: true, output, newVersion };
	})

	// Clear all database data
	.http('system:clear-data', {
		data: t.Object({}),
		response: t.Object({
			cleared: t.Boolean(),
			tablesCount: t.Number()
		})
	}, async () => {
		debug.log('server', 'Clearing all data...');

		// Close database connection
		closeDatabase();

		// Delete entire clopen directory
		const clopenDir = getClopenDir();
		await fs.rm(clopenDir, { recursive: true, force: true });
		debug.log('server', 'Deleted clopen directory:', clopenDir);

		// Reset environment state
		resetEnvironment();

		// Reinitialize database from scratch (creates dir, db, migrations, seeders)
		await initializeDatabase();

		debug.log('server', 'All data cleared successfully');

		return {
			cleared: true,
			tablesCount: 0
		};
	});
