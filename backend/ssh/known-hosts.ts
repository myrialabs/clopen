/**
 * ssh-client — trust-on-first-use host key checking.
 *
 * OpenSSH asks the user at the terminal the first time it meets a host. Clopen
 * has no terminal to ask at connect time, so it records the first key it sees
 * and refuses any later key that differs. A change is a hard stop with both
 * fingerprints reported; trusting the new key is an explicit action in the UI.
 */

import { createHash } from 'node:crypto';
import { sshKnownHostQueries } from '../database/queries';
import type { SshKnownHost } from '$shared/types/ssh';
import { debug } from '$shared/utils/logger';

export interface HostKeyIdentity {
	keyType: string;
	/** `SHA256:…` — the same rendering `ssh-keygen -lf` prints. */
	fingerprint: string;
}

/**
 * An SSH public key blob is a sequence of length-prefixed fields; the first is
 * the algorithm name (`ssh-ed25519`, `rsa-sha2-512`, …). Read just that one.
 */
function readKeyType(keyBlob: Buffer): string {
	if (keyBlob.length < 4) return 'unknown';
	const nameLength = keyBlob.readUInt32BE(0);
	if (nameLength <= 0 || nameLength > keyBlob.length - 4) return 'unknown';
	return keyBlob.subarray(4, 4 + nameLength).toString('utf8');
}

export function describeHostKey(keyBlob: Buffer): HostKeyIdentity {
	// OpenSSH prints the base64 digest without its padding.
	const digest = createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '');
	return { keyType: readKeyType(keyBlob), fingerprint: `SHA256:${digest}` };
}

export type HostKeyVerdict =
	| { outcome: 'trusted-now'; identity: HostKeyIdentity }
	| { outcome: 'matches'; identity: HostKeyIdentity }
	| { outcome: 'changed'; identity: HostKeyIdentity; known: SshKnownHost }
	| { outcome: 'accepted-unchecked'; identity: HostKeyIdentity };

/**
 * Decide what to do with the key `host:port` just presented, and persist the
 * decision. `strict` false still records and reports the key — it only stops
 * a mismatch from being fatal.
 */
export function evaluateHostKey(
	host: string,
	port: number,
	keyBlob: Buffer,
	strict: boolean
): HostKeyVerdict {
	const identity = describeHostKey(keyBlob);
	const known = sshKnownHostQueries.find(host, port);

	if (!known) {
		sshKnownHostQueries.trust(host, port, identity.keyType, identity.fingerprint);
		debug.log('ssh', `trusted new host key for ${host}:${port} — ${identity.fingerprint}`);
		return { outcome: 'trusted-now', identity };
	}

	if (known.fingerprint === identity.fingerprint) {
		sshKnownHostQueries.markSeen(host, port);
		return { outcome: 'matches', identity };
	}

	if (!strict) {
		debug.warn('ssh', `host key for ${host}:${port} changed but strict checking is off`);
		sshKnownHostQueries.trust(host, port, identity.keyType, identity.fingerprint);
		return { outcome: 'accepted-unchecked', identity };
	}

	return { outcome: 'changed', identity, known };
}

/** The message shown in the terminal (and in Test) when a key stops matching. */
export function hostKeyChangedMessage(host: string, port: number, verdict: HostKeyVerdict): string {
	if (verdict.outcome !== 'changed') return '';
	return [
		`Host key verification failed for ${host}:${port}.`,
		`  expected ${verdict.known.fingerprint}`,
		`  received ${verdict.identity.fingerprint}`,
		'The host may have been rebuilt, or the connection may be intercepted.',
		'If you expected this, use "Trust new key" on the connection to accept it.'
	].join('\n');
}

export const knownHosts = {
	list: (): SshKnownHost[] => sshKnownHostQueries.list(),
	find: (host: string, port: number): SshKnownHost | null => sshKnownHostQueries.find(host, port),
	trust: (host: string, port: number, keyType: string, fingerprint: string): SshKnownHost =>
		sshKnownHostQueries.trust(host, port, keyType, fingerprint),
	forget: (host: string, port: number): void => sshKnownHostQueries.forget(host, port)
};
