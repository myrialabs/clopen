/**
 * SSH keys on disk, because `ssh` cannot read one from memory.
 *
 * The key is stored sealed in `git_identities`, which is where it belongs: it
 * survives a reinstall, it is included in a backup of the database, and a VPS
 * or container gets it without anyone copying files around. But `ssh -i` takes
 * a PATH, and OpenSSH has no way to accept a key over a pipe — so the stored
 * key has to exist as a file whenever git runs.
 *
 * ── Written on save, not per command ──
 * Materialising inside every git invocation would mean several processes
 * writing and deleting the same path concurrently — a push and a fetch racing
 * would hand one of them a half-written key, and the failure would look like a
 * corrupt key rather than a race. Instead the file is written once when the
 * identity is saved, lives for as long as the identity does, and is removed
 * when it is deleted.
 *
 * ── Permissions ──
 * OpenSSH refuses a private key whose mode is loose, and on Windows it checks
 * an ACL that `chmod` does not touch. `writeKeyFile` sets 0600 and reports what
 * it could not guarantee, so the caller can tell the user why ssh will refuse
 * rather than letting them discover it at push time.
 */

import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getClopenDir } from '$backend/utils/paths';
import { getCleanSpawnEnv } from '$backend/utils/env';
import { debug } from '$shared/utils/logger';
import type { GeneratedSshKey } from '$shared/types/git-identity';

/** Where an identity's key material lives. */
export function identityKeyDir(identityId: string): string {
	return join(getClopenDir(), 'git-identities', identityId);
}

/** Absolute path of the private key file for an identity. */
export function identityKeyPath(identityId: string): string {
	return join(identityKeyDir(identityId), 'id_key');
}

/**
 * Write the private key to disk with 0600.
 *
 * On Windows the mode is advisory — ssh reads the ACL instead — so this returns
 * whether strict permissions could actually be applied rather than pretending
 * they were.
 */
export async function writeKeyFile(
	identityId: string,
	privateKey: string
): Promise<{ path: string; strictPermissions: boolean }> {
	const dir = identityKeyDir(identityId);
	await mkdir(dir, { recursive: true, mode: 0o700 });

	const path = identityKeyPath(identityId);
	// A private key without its trailing newline is rejected by some OpenSSH
	// builds as malformed, and a pasted key routinely arrives without one.
	const normalized = privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`;
	await writeFile(path, normalized, { mode: 0o600 });

	let strictPermissions = true;
	try {
		await chmod(path, 0o600);
		if (process.platform === 'win32') strictPermissions = false;
	} catch (error) {
		strictPermissions = false;
		debug.warn('git', `Could not tighten permissions on ${path}:`, error);
	}

	debug.log('git', `Materialised SSH key for identity ${identityId}`);
	return { path, strictPermissions };
}

/** Remove an identity's key material. Safe to call when nothing was written. */
export async function removeKeyFiles(identityId: string): Promise<void> {
	try {
		await rm(identityKeyDir(identityId), { recursive: true, force: true });
		debug.log('git', `Removed SSH key material for identity ${identityId}`);
	} catch (error) {
		debug.warn('git', `Could not remove key material for ${identityId}:`, error);
	}
}

/**
 * Generate an ed25519 keypair through `ssh-keygen`.
 *
 * The CLI rather than node:crypto: Node can produce an ed25519 keypair, but not
 * in OpenSSH's own private-key container, and hand-rolling that encoding to
 * save one subprocess would be a serious amount of custom crypto plumbing for
 * no gain. `ssh-keygen` ships with git on every platform Clopen supports.
 *
 * Generated keys carry NO passphrase. A passphrase on a key Clopen stores and
 * uses unattended protects nothing — the passphrase would sit sealed in the
 * same database as the key it unlocks. Users who want one bring their own key.
 */
export async function generateKeyPair(
	identityId: string,
	comment: string
): Promise<GeneratedSshKey & { privateKey: string }> {
	const dir = identityKeyDir(identityId);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const path = identityKeyPath(identityId);

	// ssh-keygen refuses to overwrite, and prompting for confirmation would hang
	// with no terminal attached.
	await rm(path, { force: true });
	await rm(`${path}.pub`, { force: true });

	const proc = Bun.spawn(
		['ssh-keygen', '-t', 'ed25519', '-f', path, '-N', '', '-C', comment, '-q'],
		{
			env: getCleanSpawnEnv(),
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe'
		}
	);
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error(`ssh-keygen failed: ${stderr.trim() || `exit ${code}`}`);
	}

	const privateKey = await Bun.file(path).text();
	const publicKey = (await Bun.file(`${path}.pub`).text()).trim();

	// The public file is regenerated from the stored key whenever it is needed,
	// so leaving it here would be a second copy to keep in sync.
	await rm(`${path}.pub`, { force: true });

	debug.log('git', `Generated ed25519 keypair for identity ${identityId}`);
	return { privateKey, publicKey, fingerprint: await fingerprintOf(publicKey) };
}

/**
 * SHA256 fingerprint of a public key, for display.
 *
 * Returns an empty string when `ssh-keygen` cannot read the key: a fingerprint
 * is a display detail, and failing the whole save because it could not be
 * computed would be the wrong trade.
 */
export async function fingerprintOf(publicKey: string): Promise<string> {
	try {
		const proc = Bun.spawn(['ssh-keygen', '-lf', '-'], {
			env: getCleanSpawnEnv(),
			stdin: new TextEncoder().encode(`${publicKey.trim()}\n`),
			stdout: 'pipe',
			stderr: 'pipe'
		});
		const out = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0) return '';
		// "256 SHA256:abc… comment (ED25519)" — the fingerprint is the second field.
		return out.trim().split(/\s+/)[1] ?? '';
	} catch {
		return '';
	}
}

/**
 * Derive the public key from a stored private key.
 *
 * Lets a user paste only their private key and still get something to copy into
 * GitHub. Returns null for a key that needs a passphrase, since deriving it
 * would require prompting.
 */
export async function derivePublicKey(privateKeyPath: string): Promise<string | null> {
	try {
		const proc = Bun.spawn(['ssh-keygen', '-y', '-P', '', '-f', privateKeyPath], {
			env: getCleanSpawnEnv(),
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe'
		});
		const out = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0) return null;
		return out.trim() || null;
	} catch {
		return null;
	}
}
