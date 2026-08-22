/**
 * ssh-client — port forwarding types.
 *
 * The three shapes mirror OpenSSH's flags:
 * - `local`   (-L) listen locally, forward each connection to `dest` via the host
 * - `remote`  (-R) ask the host to listen, forward what arrives back to `dest`
 * - `dynamic` (-D) listen locally as a SOCKS5 proxy, destination per request
 */

export type SshForwardType = 'local' | 'remote' | 'dynamic';

export interface SshForward {
	id: string;
	connectionId: string;
	name: string;
	type: SshForwardType;
	listenHost: string;
	listenPort: number;
	/** Unused for `dynamic` — the SOCKS client names the destination per request. */
	destHost: string | null;
	destPort: number | null;
	/** Start this forward automatically whenever the connection opens. */
	autoStart: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface SshForwardInput {
	name: string;
	type: SshForwardType;
	listenHost?: string;
	listenPort: number;
	destHost?: string;
	destPort?: number;
	autoStart?: boolean;
}

export interface SshForwardStatus {
	id: string;
	running: boolean;
	/** The port actually bound. Differs from `listenPort` when 0 was requested. */
	boundPort: number | null;
	/** Connections handled since the forward started. */
	connectionCount: number;
	error: string | null;
}
