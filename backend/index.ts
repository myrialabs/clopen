#!/usr/bin/env bun

// Runtime guard — Bun only, reject Node.js and Deno
if (typeof globalThis.Bun === 'undefined') {
	console.error('\x1b[31mError: Clopen requires Bun runtime.\x1b[0m');
	console.error('Node.js and Deno are not supported.');
	console.error('Install Bun: https://bun.sh');
	process.exit(1);
}

// MUST be first import — cleans process.env before any other module reads it
import { SERVER_ENV } from './utils/env';

import { Elysia } from 'elysia';
import { corsMiddleware } from './middleware/cors';
import { errorHandlerMiddleware } from './middleware/error-handler';
import { loggerMiddleware } from './middleware/logger';

// Database initialization
import { initializeDatabase, closeDatabase } from './database';
import { disposeAllEngines } from './engine';
import { refreshProcessPath } from './utils/path-enrich';
import { debug } from '$shared/utils/logger';
import { networkInterfaces } from 'os';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';

// Import WebSocket router
import { wsRouter } from './ws';

// Import browser preview manager for graceful shutdown
import { browserPreviewServiceManager } from './preview';

// MCP remote server for Open Code custom tools
import { handleMcpRequest, closeMcpServer } from './mcp/remote-server';

// Auth middleware
import { checkRouteAccess } from './auth/permissions';
import { authRateLimiter } from './auth';
import { sessionCleanupScheduler } from './auth/session-cleanup';
import { ws as wsServer } from './utils/ws';

// Register auth gate on WebSocket router — blocks unauthenticated/unauthorized access
wsRouter.setAuthMiddleware(async (conn, action) => {
	const isAuth = wsServer.isAuthenticated(conn);
	const role = wsServer.getRole(conn);
	return checkRouteAccess(action, isAuth, role);
});

/**
 * Clopen - Elysia Backend Server
 *
 * Development: Elysia runs on port 9161, Vite dev server proxies /api and /ws from port 9151
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

	// MCP remote server endpoint for Open Code custom tools
	// Handles GET (SSE stream), POST (JSON-RPC), DELETE (session close)
	.all('/mcp', async ({ request }) => handleMcpRequest(request))

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
						const file = Bun.file(filePath);
						return new Response(file, {
							headers: { 'Content-Type': file.type || 'application/octet-stream' }
						});
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
	// Port resolution is handled by the caller:
	// - Development: scripts/dev.ts resolves ports and passes via PORT_BACKEND env
	// - Production:  scripts/start.ts resolves port and passes via PORT env
	// - CLI:         bin/clopen.ts resolves port and passes via PORT env
	// This avoids double port-check race conditions (e.g. zombie processes on
	// Windows causing silent desync between Vite proxy and backend).

	// Enrich process.env.PATH with known install directories so Bun.which /
	// Bun.spawn / bun-pty discover CLI binaries regardless of how clopen was
	// launched (GUI, service, container, login shell). See path-enrich.ts.
	try {
		await refreshProcessPath();
	} catch (error) {
		debug.warn('path', '⚠️ Initial PATH enrichment failed:', error);
	}

	// Initialize database first before accepting connections
	try {
		await initializeDatabase();
		debug.log('database', '✅ Database initialized successfully');
		// Start expired session cleanup now that the database is ready
		sessionCleanupScheduler.start();
	} catch (error) {
		debug.warn('database', '⚠️ Database initialization failed:', error);
	}

	// Start listening after database is ready
	app.listen({
		port: PORT,
		hostname: HOST
	}, () => {
		if (isDevelopment) {
			console.log('🚀 Backend ready — waiting for frontend...');
		} else {
			console.log(`🚀 Clopen running at http://localhost:${PORT}`);
		}
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
let isShuttingDown = false;

async function gracefulShutdown() {
	if (isShuttingDown) return;
	isShuttingDown = true;

	// Force exit after 5 seconds — prevents port from being held by slow cleanup
	// during bun --watch restarts, which causes ECONNREFUSED on the Vite WS proxy.
	const forceExitTimer = setTimeout(() => {
		debug.warn('server', '⚠️ Shutdown timeout — forcing exit to release port');
		process.exit(1);
	}, 5_000);

	console.log('\n🛑 Shutting down server...');
	try {
		// Stop accepting new connections first — release the port ASAP
		app.stop();
		// Dispose rate limiter timer
		authRateLimiter.dispose();
		// Dispose expired session cleanup timer
		sessionCleanupScheduler.dispose();
		// Close MCP remote server (before engines, as they may still reference it)
		await closeMcpServer();
		// Cleanup browser preview sessions
		await browserPreviewServiceManager.cleanup();
		// Dispose all AI engines
		await disposeAllEngines();
		// Close database connection
		closeDatabase();
		debug.log('server', '✅ Graceful shutdown completed');
	} catch (error) {
		debug.error('server', '❌ Error during shutdown:', error);
	}
	clearTimeout(forceExitTimer);
	process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Ignore SIGHUP — sent when the controlling terminal closes or an SSH session
// disconnects. Without a handler Bun exits immediately; we want the server to
// keep running (e.g. started in a background tab or remote shell).
process.on('SIGHUP', () => {
	debug.log('server', 'Received SIGHUP — ignoring (server stays running)');
});

// Safety net: prevent server crash from unhandled errors.
// These can occur when AI engine SDKs emit asynchronous errors that bypass
// the normal try/catch flow (e.g., subprocess killed during initialization).
//
// IMPORTANT: Use the Web API (globalThis.addEventListener) instead of Node's
// process.on('unhandledRejection') because Bun only respects event.preventDefault()
// from the Web API to suppress the default crash behavior.
globalThis.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
	// preventDefault() is the ONLY way to prevent Bun from exiting on unhandled rejections.
	// process.on('unhandledRejection') alone does NOT prevent the crash in Bun 1.3.x.
	event.preventDefault();

	try {
		const reason = event.reason;
		const message = reason instanceof Error ? reason.message : String(reason);
		if (message.includes('Operation aborted') || message.includes('aborted')) {
			debug.warn('server', 'Suppressed expected SDK abort rejection:', message);
			return;
		}
		debug.error('server', 'Unhandled promise rejection (server still running):', reason);
	} catch {
		console.error('Unhandled promise rejection (server still running)');
	}
});

process.on('uncaughtException', (error) => {
	try {
		debug.error('server', 'Uncaught exception (server still running):', error);
	} catch {
		console.error('Uncaught exception (server still running)');
	}
});
