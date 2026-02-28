/**
 * Port utilities for checking ports before server start.
 * Bun-optimized: uses Bun.connect for fast cross-platform port check.
 */

/** Check if a port is currently in use */
export async function isPortInUse(port: number): Promise<boolean> {
	try {
		// Bun-native TCP connect — fast cross-platform check
		const socket = await Bun.connect({
			hostname: '127.0.0.1',
			port,
			socket: {
				data() {},
				open(socket) { socket.end(); },
				error() {},
				close() {}
			}
		});
		socket.end();
		return true; // Connection succeeded = port in use
	} catch {
		return false; // Connection refused = port is free
	}
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
