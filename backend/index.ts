#!/usr/bin/env bun
import { Elysia } from 'elysia';
import { staticPlugin } from '@elysiajs/static';
import { corsMiddleware } from './middleware/cors';
import { errorHandlerMiddleware } from './middleware/error-handler';
import { loggerMiddleware } from './middleware/logger';

// Database initialization
import { initializeDatabase, closeDatabase } from './lib/database';
import { disposeAllEngines } from './lib/engine';
import { debug } from '$shared/utils/logger';
import { isPortInUse } from './lib/shared/port-utils';
import { networkInterfaces } from 'os';

// Import WebSocket router
import { wsRouter } from './ws';

/**
 * Clopen - Elysia Backend Server
 *
 * Single port: 9141 for everything.
 * Development: Vite embedded as middleware (no separate server)
 * Production: Serves frontend static files + API
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

const isDevelopment = process.env.NODE_ENV !== 'production';
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 9141;
const HOST = process.env.HOST || 'localhost';

// Create Elysia app
const app = new Elysia()
	// Apply middleware
	.use(corsMiddleware)
	.use(errorHandlerMiddleware)
	.use(loggerMiddleware)

	// Health check endpoint
	.get('/health', () => ({
		status: 'ok',
		timestamp: new Date().toISOString(),
		environment: process.env.NODE_ENV || 'development'
	}))

	// Mount WebSocket router (all functionality now via WebSocket)
	.use(wsRouter.asPlugin('/ws'));

if (isDevelopment) {
	// Development: Embed Vite as middleware — no separate port
	// Uses Vite's direct APIs (transformIndexHtml, transformRequest) for speed,
	// with Node.js compat middleware only as fallback for edge cases.
	const { initViteDev, handleDevRequest, closeViteDev } = await import('./lib/vite-dev');
	const vite = await initViteDev();

	app.all('/*', async ({ request }) => handleDevRequest(vite, request));

	// Store cleanup function for graceful shutdown
	(globalThis as any).__closeViteDev = closeViteDev;
} else {
	// Production: Serve static frontend files
	app.use(
		staticPlugin({
			assets: './dist',
			prefix: '/'
		})
	);

	// SPA fallback: serve index.html for all non-file routes
	// Pass BunFile directly (not .stream()) so Bun sets Content-Length automatically
	app.all('/*', async () => {
		return new Response(Bun.file('./dist/index.html'), {
			headers: { 'Content-Type': 'text/html; charset=utf-8' }
		});
	});

}

// Start server with proper initialization sequence
async function startServer() {
	// Strict check: refuse to start if port is already in use
	if (await isPortInUse(PORT)) {
		console.error(`❌ Port ${PORT} is already in use. Please close the existing process first.`);
		process.exit(1);
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
		port: PORT,
		hostname: HOST
	}, () => {
		console.log(`🚀 Clopen running at http://localhost:${PORT}`);
		if (HOST === '0.0.0.0') {
			const ips = getLocalIps();
			for (const ip of ips) {
				console.log(`🌐 Network access: http://${ip}:${PORT}`);
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
		// Close Vite dev server if running
		if (isDevelopment && (globalThis as any).__closeViteDev) {
			await (globalThis as any).__closeViteDev();
		}
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
