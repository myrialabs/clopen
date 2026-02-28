#!/usr/bin/env bun
// MUST be first import — cleans process.env before any other module reads it
import { SERVER_ENV } from './lib/shared/env';

import { Elysia } from 'elysia';
import { corsMiddleware } from './middleware/cors';
import { errorHandlerMiddleware } from './middleware/error-handler';
import { loggerMiddleware } from './middleware/logger';

// Database initialization
import { initializeDatabase, closeDatabase } from './lib/database';
import { disposeAllEngines } from './lib/engine';
import { debug } from '$shared/utils/logger';
import { findAvailablePort } from './lib/shared/port-utils';
import { networkInterfaces } from 'os';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';

// Import WebSocket router
import { wsRouter } from './ws';

/**
 * Clopen - Elysia Backend Server
 *
 * Development: Elysia runs on port 9151, Vite dev server proxies /api and /ws from port 9141
 * Production: Elysia runs on port 9141, serves static files from dist/ + API + WebSocket
 */

function getLocalIps(): string[] {
	const ips: string[] = [];
	for (const ifaces of Object.values(networkInterfaces())) {
		for (const iface of ifaces ?? []) {
			if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
		}
	}
	return ips;
}

const isDevelopment = SERVER_ENV.isDevelopment;
const PORT = SERVER_ENV.PORT;
const HOST = SERVER_ENV.HOST;

// Create Elysia app
const app = new Elysia()
	// Apply middleware
	.use(corsMiddleware)
	.use(errorHandlerMiddleware)
	.use(loggerMiddleware)

	// API routes
	.get('/api/health', () => ({
		status: 'ok',
		timestamp: new Date().toISOString(),
		environment: SERVER_ENV.NODE_ENV
	}))

	// Mount WebSocket router (all functionality now via WebSocket)
	.use(wsRouter.asPlugin('/ws'));

if (!isDevelopment) {
	// Production: serve static files manually instead of @elysiajs/static.
	// The static plugin tries to serve directories (like /) as files via Bun.file(),
	// which hangs on some devices/platforms. Using statSync to verify the path is
	// an actual file before serving avoids this issue.
	const distDir = resolve(process.cwd(), 'dist');
	const indexHtml = await Bun.file(resolve(distDir, 'index.html')).text();

	app.all('/*', ({ path }) => {
		// Serve static files from dist/
		if (path !== '/' && !path.includes('..')) {
			const filePath = resolve(distDir, path.slice(1));
			if (filePath.startsWith(distDir)) {
				try {
					if (statSync(filePath).isFile()) {
						return new Response(Bun.file(filePath));
					}
				} catch {}
			}
		}

		// SPA fallback: serve cached index.html
		return new Response(indexHtml, {
			headers: { 'Content-Type': 'text/html; charset=utf-8' }
		});
	});
}

// Start server with proper initialization sequence
async function startServer() {
	// Find available port — auto-increment if desired port is in use
	const actualPort = await findAvailablePort(PORT);
	if (actualPort !== PORT) {
		debug.log('server', `⚠️ Port ${PORT} in use, using ${actualPort} instead`);
	}

	// Initialize database first before accepting connections
	try {
		await initializeDatabase();
		debug.log('database', '✅ Database initialized successfully');
	} catch (error) {
		debug.warn('database', '⚠️ Database initialization failed:', error);
	}

	// Start listening after database is ready
	app.listen({
		port: actualPort,
		hostname: HOST
	}, () => {
		console.log(`🚀 Clopen running at http://localhost:${actualPort}`);
		if (HOST === '0.0.0.0') {
			const ips = getLocalIps();
			for (const ip of ips) {
				console.log(`🌐 Network access: http://${ip}:${actualPort}`);
			}
		}
	});
}

startServer().catch((error) => {
	console.error('❌ Failed to start server:', error);
	process.exit(1);
});

// Graceful shutdown - properly close server and database
async function gracefulShutdown() {
	console.log('\n🛑 Shutting down server...');
	try {
		// Dispose all AI engines
		await disposeAllEngines();
		// Stop accepting new connections
		app.stop();
		// Close database connection
		closeDatabase();
		debug.log('server', '✅ Graceful shutdown completed');
	} catch (error) {
		debug.error('server', '❌ Error during shutdown:', error);
	}
	process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Safety net: prevent server crash from unhandled errors.
// These can occur when AI engine SDKs emit asynchronous errors that bypass
// the normal try/catch flow (e.g., subprocess killed during initialization).
process.on('unhandledRejection', (reason) => {
	debug.error('server', 'Unhandled promise rejection (server still running):', reason);
});

process.on('uncaughtException', (error) => {
	debug.error('server', 'Uncaught exception (server still running):', error);
});
