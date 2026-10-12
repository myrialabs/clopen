/**
 * Port utilities for checking ports before server start.
 * Bun-optimized: uses Bun.connect for fast cross-platform port check.
 *
 * Checks BOTH IPv4 (127.0.0.1) and IPv6 (::1) — on Windows, 'localhost'
 * may resolve to either address. A zombie process listening on [::1] would
 * go undetected by an IPv4-only check, causing the new server to bind to a
 * port that can't actually serve traffic (connections hang indefinitely).
 */

/** Try to connect to a specific host:port */
async function tryConnect(hostname: string, port: number): Promise<boolean> {
	try {
		const socket = await Bun.connect({
			hostname,
			port,
			socket: {
				data() {},
				open(socket) { socket.end(); },
				error() {},
				close() {}
			}
		});
		socket.end();
		return true;
	} catch {
		return false;
	}
}

/** Check if a port is currently in use on any localhost address (IPv4 + IPv6) */
export async function isPortInUse(port: number): Promise<boolean> {
	const [v4, v6] = await Promise.all([
		tryConnect('127.0.0.1', port),
		tryConnect('::1', port),
	]);
	return v4 || v6;
}

/** Find an available port starting from the given port, incrementing on collision */
export async function findAvailablePort(startPort: number, maxAttempts = 8): Promise<number> {
	let port = startPort;
	for (let i = 0; i < maxAttempts; i++) {
		if (!(await isPortInUse(port))) return port;
		port++;
	}
	throw new Error(`No available port found starting from ${startPort} (tried ${maxAttempts} ports)`);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Whether an OAuth flow's loopback callback is actually listening, read off the
 * `redirect_uri` of its authorization URL. Engine logins race that callback
 * against a pasted redirect URL; the paste is only required when nothing is
 * listening (the port was taken) or the redirect goes to a hosted page instead.
 */
export async function hasLoopbackCallbackListener(authUrl: string): Promise<boolean> {
	try {
		const redirect = new URL(new URL(authUrl).searchParams.get('redirect_uri') ?? '');
		if (!LOOPBACK_HOSTS.has(redirect.hostname)) return false;
		const port = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80));
		return await isPortInUse(port);
	} catch {
		return false;
	}
}
