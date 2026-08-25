/**
 * ssh-client — trusted host keys.
 *
 * Clopen trusts on first use: the first key a host presents is recorded, and
 * every later connection must present the same one. A mismatch stops the
 * connection and surfaces both fingerprints so the user can decide.
 */

export interface SshKnownHost {
	id: string;
	host: string;
	port: number;
	/** e.g. `ssh-ed25519`, `ssh-rsa`. */
	keyType: string;
	/** `SHA256:…`, the same rendering OpenSSH prints. */
	fingerprint: string;
	addedAt: string;
	lastSeenAt: string | null;
}
