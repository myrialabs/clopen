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
import { bootstrapAfterDbInit } from '$backend/bootstrap';
import { fetchReleaseNotes } from '$backend/update/release-notes';
import { isNewerVersion } from '$shared/utils/semver';

/** In-memory flag: set after successful update, cleared on server restart */
let pendingUpdate: { fromVersion: string; toVersion: string } | null = null;

/** Read current version from package.json on disk (reflects the latest install, not necessarily what's loaded in memory) */
function readVersionFromDisk(): string {
	try {
		const packagePath = join(import.meta.dir, '..', '..', '..', 'package.json');
		const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'));
		return pkg.version || '0.0.0';
	} catch {
		return '0.0.0';
	}
}

/**
 * Version actually loaded into this running process, captured once at module load.
 * If a `clopen update` CLI run (a separate process) updates package.json on disk
 * while this server keeps running, readVersionFromDisk() will report the new
 * version immediately even though this process is still executing the old code —
 * runningVersion lets us detect that drift and keep flagging "restart required".
 */
const runningVersion = readVersionFromDisk();

/** Fetch latest version from npm registry */
async function fetchLatestVersion(): Promise<string> {
	const response = await fetch('https://registry.npmjs.org/@myrialabs/clopen/latest');
	if (!response.ok) {
		throw new Error(`npm registry returned ${response.status}`);
	}
	const data = await response.json() as { version: string };
	return data.version;
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
		debug.log('server', `Checking for updates... running version: ${runningVersion}`);

		// If a `clopen update` CLI run (separate process) already updated package.json
		// on disk while this server kept running, the disk version won't match what's
		// actually loaded in memory. Treat that drift as an implicit pending restart.
		const diskVersion = readVersionFromDisk();
		if (pendingUpdate === null && diskVersion !== runningVersion) {
			pendingUpdate = { fromVersion: runningVersion, toVersion: diskVersion };
		}

		const latestVersion = await fetchLatestVersion();
		const updateAvailable = isNewerVersion(runningVersion, latestVersion);

		debug.log('server', `Latest version: ${latestVersion}, update available: ${updateAvailable}`);

		return {
			currentVersion: runningVersion,
			latestVersion,
			updateAvailable,
			pendingRestart: pendingUpdate !== null,
			pendingUpdate: pendingUpdate ?? undefined
		};
	})

	// Clopen's releases from GitHub, newest first, parsed into grouped changes
	.http('system:get-release-notes', {
		data: t.Object({}),
		response: t.Array(t.Object({
			version: t.String(),
			tagName: t.String(),
			url: t.String(),
			publishedAt: t.String(),
			changes: t.Array(t.Object({
				kind: t.Union([t.Literal('feature'), t.Literal('improvement'), t.Literal('fix'), t.Literal('other')]),
				scope: t.Optional(t.String()),
				summary: t.String(),
				breaking: t.Boolean(),
				pullNumber: t.Optional(t.Number()),
				pullUrl: t.Optional(t.String())
			})),
			newContributors: t.Array(t.String()),
			notes: t.String()
		}))
	}, async () => fetchReleaseNotes())

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

		const fromVersion = runningVersion;

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

		// Re-establish code-defined built-ins that migrations/seeders don't cover
		// (internal MCP servers like Browser Automation + the default engine).
		// The process stays alive across clear-data, so without this they'd vanish
		// until the next restart.
		bootstrapAfterDbInit();

		debug.log('server', 'All data cleared successfully');

		return {
			cleared: true,
			tablesCount: 0
		};
	});
