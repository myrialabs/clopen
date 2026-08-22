/**
 * ssh-client — connection types shared between backend and frontend.
 */

/**
 * How Clopen authenticates to the remote host.
 *
 * - `password`  — a stored password. Clopen also answers `keyboard-interactive`
 *                 prompts with it, so servers that disable plain password auth
 *                 (`KbdInteractiveAuthentication yes`) still work.
 * - `key`       — a private key pasted into Clopen and stored in the database.
 * - `key-file`  — a private key read from the Clopen server's filesystem at
 *                 connect time, so the key material never enters the database.
 * - `agent`     — delegate to a running ssh-agent (`SSH_AUTH_SOCK`, or the
 *                 explicit socket path on the connection).
 */
export type SshAuthMethod = 'password' | 'key' | 'key-file' | 'agent';

export interface SshConnection {
	id: string;
	name: string;
	host: string;
	port: number;
	username: string;
	authMethod: SshAuthMethod;
	password: string | null;
	privateKey: string | null;
	privateKeyPath: string | null;
	passphrase: string | null;
	agentSocket: string | null;
	/** Another saved connection to tunnel through (ProxyJump). */
	jumpConnectionId: string | null;
	/** Remote directory the shell and the file browser start in. */
	initialPath: string | null;
	/** Seconds between keepalive packets. 0 disables them. */
	keepaliveSeconds: number;
	/** Refuse to connect when the host key does not match the trusted one. */
	strictHostKey: boolean;
	color: string | null;
	createdAt: string;
	updatedAt: string;
	lastUsedAt: string | null;
}

export interface SshConnectionInput {
	name: string;
	host: string;
	port?: number;
	username: string;
	authMethod?: SshAuthMethod;
	password?: string;
	privateKey?: string;
	privateKeyPath?: string;
	passphrase?: string;
	agentSocket?: string;
	jumpConnectionId?: string | null;
	initialPath?: string;
	keepaliveSeconds?: number;
	strictHostKey?: boolean;
	color?: string;
}

export interface SshHealth {
	ok: boolean;
	latencyMs: number | null;
	/** The remote SSH banner, e.g. `SSH-2.0-OpenSSH_9.6`. */
	serverBanner: string | null;
	/** `uname -sr` output, when the host let us run it. */
	remoteOs: string | null;
	/** SHA256 fingerprint of the key the host presented. */
	hostKeyFingerprint: string | null;
	/** True when the presented key differs from the one Clopen already trusts. */
	hostKeyChanged: boolean;
	/**
	 * True when the user disconnected this host. The pool dials on demand, so
	 * this is what distinguishes "deliberately closed" from "failed to connect".
	 */
	suspended: boolean;
	error: string | null;
}
