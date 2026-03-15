/**
 * SSH Tunnel Configuration
 * Enables accessing databases on private networks via SSH Port Forwarding.
 */

export type SSHAuthMethod = 'password' | 'key';

export interface SSHTunnelConfig {
	enabled: boolean;
	/** SSH server host */
	host: string;
	/** SSH server port (default: 22) */
	port: number;
	/** SSH username */
	username: string;
	/** Authentication method */
	authMethod: SSHAuthMethod;
	/**
	 * SSH password (stored AES-256-GCM encrypted).
	 * Used when authMethod === 'password'.
	 */
	password?: string;
	/**
	 * SSH private key in PEM format (stored AES-256-GCM encrypted).
	 * Used when authMethod === 'key'.
	 */
	privateKey?: string;
	/**
	 * Passphrase for the private key (stored AES-256-GCM encrypted).
	 * Optional — only needed for passphrase-protected keys.
	 */
	passphrase?: string;
	/**
	 * Remote host that the SSH server can reach (DB host from SSH server's perspective).
	 * Defaults to DBConnectionConfig.host when omitted.
	 */
	remoteHost?: string;
	/**
	 * Remote port to forward to.
	 * Defaults to DBConnectionConfig.port when omitted.
	 */
	remotePort?: number;
}
