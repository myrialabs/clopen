/**
 * The git identity service — CRUD, key materialisation, and the DTO boundary.
 *
 * One rule governs this module: A SECRET NEVER LEAVES IT. `toDTO` reduces the
 * private key, its passphrase, and the HTTPS token to booleans, so no code path
 * above this file can accidentally serialise one to a browser. The public key
 * is the deliberate exception — it is public, and the user needs to copy it.
 *
 * Key material on disk is kept in step with the row here rather than in the
 * query layer: writing a file is not part of storing a row, and a failed write
 * must not leave a saved identity whose key silently does not exist.
 */

import { randomUUID } from 'node:crypto';
import {
	gitIdentityQueries,
	gitIdentityBindingQueries,
	parseHosts,
	type GitIdentityRow
} from '$backend/database/queries';
import { debug } from '$shared/utils/logger';
import type {
	GeneratedSshKey,
	GitIdentityDTO,
	GitIdentityInput
} from '$shared/types/git-identity';
import { derivePublicKey, generateKeyPair, identityKeyPath, removeKeyFiles, writeKeyFile } from './keys';
import { syncLocalMachineIdentity } from './import-local';
import { refreshScopeConfigsForUser, writeScopeConfig } from './scope-config';

/** Strip a row down to what a client may see. */
export function toDTO(row: GitIdentityRow): GitIdentityDTO {
	return {
		id: row.id,
		label: row.label,
		name: row.name,
		email: row.email,
		authMethod: row.auth_method,
		hosts: parseHosts(row.hosts),
		sshPublicKey: row.ssh_public_key,
		hasSshKey: !!row.ssh_private_key,
		hasSshPassphrase: !!row.ssh_passphrase,
		hasHttpsToken: !!row.https_token,
		httpsUsername: row.https_username,
		integrationAccountId: row.integration_account_id,
		isDefault: row.is_default === 1,
		source: row.source,
		// Mirrored rows are not deletable: the machine's config still exists, so a
		// delete would only be undone by the next list read.
		canDelete: row.source !== 'local-machine',
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function assertValid(input: GitIdentityInput): void {
	if (!input.label.trim()) throw new Error('An identity needs a label');
	if (!input.name.trim()) throw new Error('An identity needs a name');
	const email = input.email.trim();
	// Deliberately loose. Git accepts anything without whitespace or angle
	// brackets as an email, and rejecting an address a host does accept would be
	// the more annoying failure.
	if (!email || /[\s<>]/.test(email)) throw new Error('That email is not usable in a git commit');
}

/**
 * Keep the key file in step with the row.
 *
 * Called after every write. Reads the stored (already unsealed) key rather than
 * the input, so an edit that leaves the key untouched still guarantees the file
 * exists — which matters after a restore onto a machine that has the database
 * but not the key files.
 */
async function syncKeyFile(row: GitIdentityRow): Promise<GitIdentityRow> {
	if (row.auth_method !== 'ssh-key' || !row.ssh_private_key) {
		await removeKeyFiles(row.id);
		return row;
	}

	const { strictPermissions } = await writeKeyFile(row.id, row.ssh_private_key);
	if (!strictPermissions) {
		// Said once, loudly, rather than left for the user to decode out of an
		// ssh error at push time.
		debug.warn(
			'git',
			`Key for identity ${row.id} could not be given strict permissions; ssh may refuse it`
		);
	}

	// A user who pasted only a private key still gets something to copy into
	// GitHub. Skipped for passphrased keys, which cannot be read unattended.
	if (!row.ssh_public_key && !row.ssh_passphrase) {
		const derived = await derivePublicKey(identityKeyPath(row.id));
		if (derived) {
			const updated = gitIdentityQueries.update(row.id, {
				label: row.label,
				name: row.name,
				email: row.email,
				authMethod: row.auth_method,
				hosts: parseHosts(row.hosts),
				sshPublicKey: derived,
				httpsUsername: row.https_username,
				integrationAccountId: row.integration_account_id
			});
			if (updated) return updated;
		}
	}

	return row;
}

export const gitIdentityService = {
	/**
	 * Every identity this user owns, mirroring the machine's git config first.
	 *
	 * Done on the read rather than at startup so it also covers a user who joins
	 * later, and because it is the moment the result is actually about to be
	 * shown. It is idempotent and only writes on the first call per user.
	 */
	async list(userId: string): Promise<GitIdentityDTO[]> {
		await syncLocalMachineIdentity(userId);
		return gitIdentityQueries.listByUser(userId).map(toDTO);
	},

	get(userId: string, id: string): GitIdentityDTO | null {
		const row = gitIdentityQueries.getById(id);
		if (!row || row.owner_user_id !== userId) return null;
		return toDTO(row);
	},

	async create(userId: string, input: GitIdentityInput): Promise<GitIdentityDTO> {
		assertValid(input);
		if (gitIdentityQueries.labelTaken(userId, input.label.trim())) {
			throw new Error(`You already have an identity called "${input.label.trim()}"`);
		}

		const id = randomUUID();
		let row = gitIdentityQueries.create(id, userId, {
			label: input.label.trim(),
			name: input.name.trim(),
			email: input.email.trim(),
			authMethod: input.authMethod,
			hosts: input.hosts,
			sshPrivateKey: input.sshPrivateKey ?? null,
			sshPublicKey: input.sshPublicKey ?? null,
			sshPassphrase: input.sshPassphrase ?? null,
			httpsUsername: input.httpsUsername ?? null,
			httpsToken: input.httpsToken ?? null,
			integrationAccountId: input.integrationAccountId ?? null
		});

		row = await syncKeyFile(row);

		// The first identity a user creates becomes their default — otherwise it
		// would sit there doing nothing until they found the toggle, which reads
		// as the feature being broken.
		if (input.isDefault || gitIdentityQueries.listByUser(userId).length === 1) {
			gitIdentityQueries.setDefault(userId, id);
			row = gitIdentityQueries.getById(id)!;
		}

		// Terminals that are already open read their identity from a file, so it is
		// rewritten here — otherwise the new account would only reach tabs opened
		// after this point.
		await refreshScopeConfigsForUser(userId);

		debug.log('git', `Created git identity "${row.label}" for user ${userId}`);
		return toDTO(row);
	},

	async update(userId: string, id: string, input: GitIdentityInput): Promise<GitIdentityDTO> {
		assertValid(input);
		const existing = gitIdentityQueries.getById(id);
		if (!existing || existing.owner_user_id !== userId) throw new Error('Identity not found');
		if (gitIdentityQueries.labelTaken(userId, input.label.trim(), id)) {
			throw new Error(`You already have an identity called "${input.label.trim()}"`);
		}

		let row = gitIdentityQueries.update(id, {
			label: input.label.trim(),
			name: input.name.trim(),
			email: input.email.trim(),
			authMethod: input.authMethod,
			hosts: input.hosts,
			// `undefined` keeps the stored secret, `null` clears it — the
			// distinction the query layer depends on.
			sshPrivateKey: input.sshPrivateKey,
			sshPublicKey: input.sshPublicKey ?? existing.ssh_public_key,
			sshPassphrase: input.sshPassphrase,
			httpsUsername: input.httpsUsername ?? null,
			httpsToken: input.httpsToken,
			integrationAccountId: input.integrationAccountId ?? null
			// `source` is deliberately absent: the update statement does not touch
			// that column, so an edited mirror stays a mirror — and stays
			// undeletable, because the machine config it reflects is still there.
		});
		if (!row) throw new Error('Identity not found');

		row = await syncKeyFile(row);

		if (input.isDefault && row.is_default !== 1) {
			gitIdentityQueries.setDefault(userId, id);
			row = gitIdentityQueries.getById(id)!;
		}

		await refreshScopeConfigsForUser(userId);

		debug.log('git', `Updated git identity "${row.label}"`);
		return toDTO(row);
	},

	async remove(userId: string, id: string): Promise<void> {
		const row = gitIdentityQueries.getById(id);
		if (!row || row.owner_user_id !== userId) throw new Error('Identity not found');
		if (row.source === 'local-machine') {
			throw new Error(
				"This account mirrors the machine's own git config, so it cannot be deleted. Edit it instead."
			);
		}

		gitIdentityQueries.remove(id);
		await removeKeyFiles(id);

		// Deleting the default leaves the user with none, so the next one in the
		// list takes over rather than every project silently losing its identity.
		if (row.is_default === 1) {
			const remaining = gitIdentityQueries.listByUser(userId);
			if (remaining.length > 0) gitIdentityQueries.setDefault(userId, remaining[0]!.id);
		}

		await refreshScopeConfigsForUser(userId);

		debug.log('git', `Removed git identity "${row.label}"`);
	},

	async setDefault(userId: string, id: string): Promise<GitIdentityDTO> {
		const row = gitIdentityQueries.getById(id);
		if (!row || row.owner_user_id !== userId) throw new Error('Identity not found');
		gitIdentityQueries.setDefault(userId, id);
		// Every project that inherits the default is affected, not just one.
		await refreshScopeConfigsForUser(userId);
		return toDTO(gitIdentityQueries.getById(id)!);
	},

	/**
	 * Generate a keypair for an identity and store the private half.
	 *
	 * Returns only the public key and its fingerprint; the private key goes
	 * straight into the sealed column and the 0600 file.
	 */
	async generateKey(userId: string, id: string): Promise<GeneratedSshKey> {
		const row = gitIdentityQueries.getById(id);
		if (!row || row.owner_user_id !== userId) throw new Error('Identity not found');

		const { privateKey, publicKey, fingerprint } = await generateKeyPair(
			id,
			`${row.email} (clopen)`
		);

		gitIdentityQueries.update(id, {
			label: row.label,
			name: row.name,
			email: row.email,
			authMethod: 'ssh-key',
			hosts: parseHosts(row.hosts),
			sshPrivateKey: privateKey,
			sshPublicKey: publicKey,
			// A generated key has no passphrase, so any stored one is now wrong.
			sshPassphrase: null,
			httpsUsername: row.https_username,
			integrationAccountId: row.integration_account_id
		});

		await refreshScopeConfigsForUser(userId);

		debug.log('git', `Generated SSH key for identity "${row.label}"`);
		return { publicKey, fingerprint };
	},

	/** Bind a project to an identity, for this user. */
	async bind(userId: string, projectId: string, identityId: string | null): Promise<void> {
		if (identityId === null) {
			gitIdentityBindingQueries.clear(projectId, userId);
		} else {
			const row = gitIdentityQueries.getById(identityId);
			if (!row || row.owner_user_id !== userId) throw new Error('Identity not found');
			gitIdentityBindingQueries.set(projectId, userId, identityId);
		}
		// Only this project's file can have changed, so only it is rewritten.
		await writeScopeConfig(userId, projectId);
	},

	/** How many projects would lose their binding if this identity went away. */
	bindingCount(identityId: string): number {
		return gitIdentityBindingQueries.countForIdentity(identityId);
	}
};
