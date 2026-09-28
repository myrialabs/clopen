/**
 * Mirroring the machine's own git identity into the list.
 *
 * Someone who already has `git config --global user.email` set has an account —
 * they just have not told Clopen about it. Showing them an empty Git Accounts
 * page and asking them to retype what git already knows is the kind of setup
 * step that makes a feature feel like paperwork, so the machine's identity is
 * imported on first read and becomes the default when nothing else is.
 *
 * ── Mirrored once, then owned by the user ──
 * The import writes only when the row does not exist. It never overwrites it
 * afterwards, deliberately: telling an edit apart from machine drift would need
 * a record of what was last mirrored, and guessing wrong means silently
 * replacing a value the user chose. Importing once and leaving it alone is the
 * behaviour that is easy to explain and impossible to get wrong — a machine
 * config change is picked up by editing the row.
 *
 * ── Not deletable ──
 * Deleting it would accomplish nothing — the machine's config is still there and
 * the next read would recreate it. So the row is marked `local-machine` and the
 * delete path refuses it. Editing is how a user changes it.
 */

import { gitIdentityQueries, type GitIdentityRow } from '$backend/database/queries';
import { getCleanSpawnEnv } from '$backend/utils/env';
import { resolveBinary } from '$backend/utils/cli';
import { debug } from '$shared/utils/logger';
import { randomUUID } from 'node:crypto';

/** What the machine's global git config says about who the user is. */
export interface MachineIdentity {
	name: string;
	email: string;
}

/**
 * Read one value from the machine's GLOBAL git config.
 *
 * `--global` explicitly, not the default lookup: a repository-local value
 * describes one project, while this is meant to be the person's own account. No
 * cwd is given for the same reason.
 */
async function readGlobalConfig(key: string): Promise<string | null> {
	const gitPath = resolveBinary('git');
	if (!gitPath) return null;

	try {
		const proc = Bun.spawn([gitPath, 'config', '--global', '--get', key], {
			env: getCleanSpawnEnv(),
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe'
		});
		const out = await new Response(proc.stdout).text();
		const code = await proc.exited;
		// Exit 1 simply means "not set", which is not a failure.
		if (code !== 0) return null;
		return out.trim() || null;
	} catch (error) {
		debug.warn('git', `Could not read global git config ${key}:`, error);
		return null;
	}
}

/** The machine's identity, or null when git has no global name/email. */
export async function readMachineIdentity(): Promise<MachineIdentity | null> {
	const [name, email] = await Promise.all([
		readGlobalConfig('user.name'),
		readGlobalConfig('user.email')
	]);
	// Both halves are needed. Git itself refuses to commit with only one, so a
	// half-configured machine has nothing worth mirroring.
	if (!name || !email) return null;
	return { name, email };
}

/**
 * A label that says where the row came from without pretending to be a choice.
 *
 * Unique per user is enforced by the schema, so a collision with a manual
 * identity called "This machine" has to be resolved rather than thrown.
 */
function machineLabel(userId: string, taken: (label: string) => boolean): string {
	const base = 'This machine';
	if (!taken(base)) return base;
	for (let i = 2; i < 50; i++) {
		const candidate = `${base} (${i})`;
		if (!taken(candidate)) return candidate;
	}
	// Practically unreachable; a unique suffix beats failing the whole list read.
	return `${base} ${userId.slice(0, 6)}`;
}

/**
 * Ensure the user's list reflects the machine's git config.
 *
 * Returns the mirrored row, or null when the machine has nothing to mirror.
 * Never throws: this runs on the read path for Settings, and a failure to mirror
 * must not take the whole list with it.
 */
export async function syncLocalMachineIdentity(userId: string): Promise<GitIdentityRow | null> {
	try {
		const machine = await readMachineIdentity();
		const existing = gitIdentityQueries.getLocalMachine(userId);

		if (!machine) {
			// Nothing to mirror. An existing row is left alone rather than deleted —
			// the user may have edited it into a real account, and a machine that
			// temporarily has no global config should not erase it.
			return existing;
		}

		if (!existing) {
			const label = machineLabel(userId, (l) => gitIdentityQueries.labelTaken(userId, l));
			const row = gitIdentityQueries.create(randomUUID(), userId, {
				label,
				name: machine.name,
				email: machine.email,
				// Attribution only. Whatever already authenticates this machine's
				// pushes keeps doing so, because no credential is claimed here.
				authMethod: 'none',
				hosts: [],
				source: 'local-machine'
			});
			// Becoming the default is the point: a fresh install then commits as the
			// person the machine already says it is, with nothing to configure.
			if (!gitIdentityQueries.getDefaultForUser(userId)) {
				gitIdentityQueries.setDefault(userId, row.id);
			}
			debug.log('git', `Imported the machine's git identity for user ${userId}`);
			return gitIdentityQueries.getById(row.id);
		}

		// Already mirrored. Left exactly as it is, whether or not the machine has
		// changed since — see the header.
		return existing;
	} catch (error) {
		debug.warn('git', 'Could not mirror the machine git identity:', error);
		return null;
	}
}
