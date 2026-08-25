/**
 * On-disk "honesty" materialization for permissions.
 *
 * Enforcement is a runtime hook (see the engine adapters + resolve.ts); this
 * module additionally writes the resolved rules into Claude's ISOLATED
 * `settings.json` so they are inspectable and also apply to that engine's own
 * settings resolution. Only Claude gets a file: it is the one engine with a
 * config Clopen can manage safely (isolated dir) AND whose native
 * `permissions.allow`/`permissions.deny` schema matches this feature's model.
 *
 * The merge is managed-KEYS: only `permissions.allow` / `permissions.deny` are
 * touched; any other content in the file (Claude's own settings) is preserved.
 * Global scope only — writing a repo's `.claude/settings.json` touches the
 * working tree and must be an explicit user action, never silent at stream start.
 *
 * Never throws — a stream is never broken because permissions couldn't be
 * written to disk.
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'path';
import { resolveArtifact } from '$backend/artifacts';
import { debug } from '$shared/utils/logger';
import { resolvePermissionsFromDb } from './service';
import { hasAnyRestriction } from './resolve';
import type { ArtifactEngineKey } from './service';

async function readJson(path: string): Promise<Record<string, unknown>> {
	try {
		await stat(path);
	} catch {
		return {};
	}
	try {
		const parsed = JSON.parse(await readFile(path, 'utf8'));
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		// Malformed settings.json — don't clobber it. Skip the write.
		return { __unparsable__: true };
	}
}

/**
 * Materialize the global permission set for one engine into its isolated config
 * file (Claude only). Called per stream (global scope). No-op for engines without
 * a managed permission file.
 */
export async function syncPermissions(engine: ArtifactEngineKey): Promise<void> {
	try {
		if (engine !== 'claude') return; // Only Claude has a managed on-disk file today.

		const resolution = resolveArtifact('permission', { engine, scope: 'global' });
		if (!resolution.supported) return;
		const target = resolution.locateEffective({ engine, scope: 'global' });
		if (!target) return;

		const resolved = resolvePermissionsFromDb('claude-code');

		// Nothing to enforce and no file to clean up → don't create a spurious `{}`.
		const fileExists = await stat(target).then(() => true).catch(() => false);
		if (!hasAnyRestriction(resolved) && !fileExists) return;

		const current = await readJson(target);
		if (current.__unparsable__) {
			debug.warn('permissions', `Skipping settings.json write — ${target} is not valid JSON`);
			return;
		}

		const permissions = (typeof current.permissions === 'object' && current.permissions
			? { ...(current.permissions as Record<string, unknown>) }
			: {}) as Record<string, unknown>;

		if (hasAnyRestriction(resolved)) {
			permissions.allow = resolved.allow;
			permissions.deny = resolved.deny;
		} else {
			// No rules → drop our managed keys, leaving any other permission config.
			delete permissions.allow;
			delete permissions.deny;
		}

		const next: Record<string, unknown> = { ...current };
		if (Object.keys(permissions).length > 0) next.permissions = permissions;
		else delete next.permissions;

		const serialized = JSON.stringify(next, null, 2) + '\n';
		const existing = await readFile(target, 'utf8').catch(() => '');
		if (serialized === existing) return;

		await mkdir(join(target, '..'), { recursive: true });
		await writeFile(target, serialized, 'utf8');
		debug.log('permissions', `🔐 Wrote Claude permissions → ${target} (${resolved.allow.length} allow, ${resolved.deny.length} deny)`);
	} catch (error) {
		debug.warn('permissions', `Permission materialization for ${engine} failed (continuing without):`, error);
	}
}
