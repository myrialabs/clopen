import { createServer } from 'http';

import { debug } from '$shared/utils/logger';
/**
 * Check if a specific port is available
 */
export function checkPortAvailability(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		
		server.listen(port, () => {
			server.close(() => {
				resolve(true); // Port is available
			});
		});
		
		server.on('error', (err: NodeJS.ErrnoException) => {
			if (err.code === 'EADDRINUSE') {
				resolve(false); // Port is in use
			} else {
				resolve(false); // Other error, consider as unavailable
			}
		});
	});
}

/**
 * Strictly check if port 5678 is available and fail if not
 */
export async function ensurePort5678Available(): Promise<void> {
	const isAvailable = await checkPortAvailability(5678);
	
	if (!isAvailable) {
		debug.error('server', '❌ FATAL ERROR: Port 5678 is required but not available!');
		debug.error('server', '❌ Please stop any service using port 5678 and try again.');
		debug.error('server', '❌ This application strictly requires port 5678 to be available.');
		debug.error('server', '❌ Use the following command to find what is using port 5678:');
		debug.error('server', '❌   Windows: netstat -ano | findstr :5678');
		debug.error('server', '❌   Linux/Mac: lsof -i :5678');
		process.exit(1);
	}
	
	debug.log('server', '✅ Port 5678 is available');
}

/**
 * Get process info using a specific port (Windows only)
 */
export async function getPortProcessInfo(port: number): Promise<void> {
	try {
		const proc = Bun.spawn(['netstat', '-ano'], {
			stdout: 'pipe',
			stderr: 'ignore'
		});
		const output = await new Response(proc.stdout).text();
		const filteredOutput = output.split('\n').filter((line: string) => line.includes(`:${port}`)).join('\n');
		
		if (filteredOutput.trim()) {
			debug.error('server', `❌ Port ${port} is being used by:`);
			debug.error('server', filteredOutput);
		}
	} catch (error) {
		debug.error('server', '❌ Could not check port usage:', error instanceof Error ? error.message : 'Unknown error');
	}
}