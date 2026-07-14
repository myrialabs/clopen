#!/usr/bin/env bun

// Runtime guard — Bun only, reject Node.js and Deno
if (typeof globalThis.Bun === 'undefined') {
	console.error('\x1b[31mError: Clopen requires Bun runtime.\x1b[0m');
	console.error('Node.js and Deno are not supported.');
	console.error('Install Bun: https://bun.sh');
	process.exit(1);
}

// Note: the node:v8 isBuildingSnapshot shim (backend/utils/bun-compat.ts) is
// applied via Bun `preload` (bunfig.toml + --preload in bin/clopen.ts), NOT a
// plain import here — Bun does not guarantee side-effect import order ahead of
// the transitive mongodb/bson CJS import, so an import would run too late.

// MUST be first import — cleans process.env before any other module reads it.
import { SERVER_ENV } from './utils/env';

import { Elysia } from 'elysia';
import { corsMiddleware } from './middleware/cors';
import { errorHandlerMiddleware } from './middleware/error-handler';
import { loggerMiddleware } from './middleware/logger';

// Database initialization
import { initializeDatabase, closeDatabase } from './database';
import { syncInternalServers } from './mcp';
import { disposeAllEngines } from './engine';
import { refreshProcessPath } from './utils/path-enrich';
import { debug } from '$shared/utils/logger';
import { networkInterfaces } from 'os';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';

// Import WebSocket router
import { wsRouter } from './ws';

// HTTP upload route — bypasses the Vite WS proxy, which corrupts sustained
// binary transfers with `write EPIPE`. See backend/http/files-upload.ts.
import { filesUploadRoute } from './http/files-upload';

// HTTP routes for per-user notification sounds (upload / serve / delete).
import { audioRoute } from './http/audio';

// Import browser preview manager for graceful shutdown
import { browserPreviewServiceManager } from './preview';

// MCP remote server for Open Code custom tools
import { handleMcpRequest, handleExternalMcpRequest, closeMcpServer, completeAuthorization } from './mcp';

// Auth middleware
import { checkRouteAccess } from './auth/permissions';
import { authRateLimiter } from './auth';
import { sessionCleanupScheduler } from './auth/session-cleanup';
import { uploadTempCleanup } from './http/upload-temp-cleanup';
import { ws as wsServer } from './utils/ws';
import { messageRateLimiter } from './ws/message-rate-limiter';

// Register auth gate on WebSocket router — blocks unauthenticated/unauthorized access
wsRouter.setAuthMiddleware(async (conn, action) => {
	const isAuth = wsServer.isAuthenticated(conn);
	const role = wsServer.getRole(conn);
	return checkRouteAccess(action, isAuth, role);
});

// Register message rate limiter on WebSocket router — prevents DoS via message spam
wsRouter.setRateLimiter((conn, action) => {
	return messageRateLimiter.checkRateLimit(conn, action);
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
	.all('/mcp', async ({ request, server }) => {
		// MCP tool calls can run far longer than Bun's default 10s idle timeout.
		// While a tool executes, the streaming response sends no bytes, so Bun
		// would close the idle connection and the call surfaces as MCP error
		// -32001 ("Request timed out"). Disable the idle timeout for this
		// long-lived endpoint only — every other route keeps the safe default.
		server?.timeout(request, 0);
		return handleMcpRequest(request);
	})

	// Per-server proxy for user-installed (external) MCP servers. Clopen connects
	// to the upstream third-party server and re-exposes its sanitized tools here,
	// so engines never connect to it directly — see backend/mcp/external/proxy.ts.
	// Same long-lived semantics as `/mcp`: disable Bun's idle timeout.
	.all('/mcp/ext/:slug', async ({ request, params, server }) => {
		server?.timeout(request, 0);
		return handleExternalMcpRequest(request, params.slug);
	})

	// Stable OAuth redirect target for centralized MCP sign-in. The browser is
	// redirected here after the user consents; we exchange the code for tokens
	// (stored against the server) and show a self-closing confirmation page. The
	// Settings panel polls `mcp:status` to pick up the new connected state.
	.get('/api/mcp/oauth/callback', async ({ query }) => {
		const { code, state, error } = query as { code?: string; state?: string; error?: string };
		const page = (title: string, body: string) =>
			new Response(
				`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}div{text-align:center;max-width:28rem;padding:2rem}h1{font-size:1.1rem}p{color:#94a3b8;font-size:.9rem}</style></head><body><div><h1>${title}</h1><p>${body}</p><script>setTimeout(()=>window.close(),2500)</script></div></body></html>`,
				{ headers: { 'Content-Type': 'text/html' } }
			);
		if (error) return page('Sign-in failed', `The authorization server returned: ${error}. You can close this tab and try again.`);
		if (!code || !state) return page('Sign-in failed', 'Missing authorization code. You can close this tab and try again.');
		try {
			await completeAuthorization(state, code);
			return page('Connected', 'Sign-in complete. You can close this tab and return to Clopen.');
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Unknown error';
			return page('Sign-in failed', `${message}. You can close this tab and try again.`);
		}
	})

	// HTTP file upload — mounted before the WS plugin so /api/files/upload
	// stays on the HTTP path through the Vite dev proxy.
	.use(filesUploadRoute)

	// Per-user notification sound upload/serve/delete.
	.use(audioRoute)

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
		// Mirror code-defined internal MCP servers into the DB so Settings → MCP
		// can list and toggle them. Idempotent; preserves the user's toggles.
		syncInternalServers();
		// Start expired session cleanup now that the database is ready
		sessionCleanupScheduler.start();
		uploadTempCleanup.start();
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
		// Dispose upload temp cleanup timer
		uploadTempCleanup.dispose();
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

// Safety net: prevent server crash from unhandled promise rejections.
// These can occur when third-party SDKs emit asynchronous errors that bypass
// the normal try/catch flow, e.g.:
//  - AI engine SDKs whose subprocess is killed during initialization
//  - puppeteer-extra's stealth evasions fire a non-awaited
//    `Network.setUserAgentOverride` on a newly created popup target; when the
//    target closes mid-call the resulting TargetCloseError rejects with no
//    handler attached and would otherwise kill the whole server while the user
//    is interacting with the Preview.
//
// IMPORTANT (Bun routing — verified on Bun 1.3.14): top-level unhandled
// rejections are suppressed by Node's process.on('unhandledRejection') but NOT
// by the Web API globalThis.addEventListener('unhandledrejection') +
// preventDefault() (the Web handler does not even fire for these). We register
// BOTH for cross-version safety; the shared reporter below dedups intent.
function reportUnhandledRejection(reason: unknown): void {
	try {
		const message = reason instanceof Error ? reason.message : String(reason);
		if (message.includes('Operation aborted') || message.includes('aborted')) {
			debug.warn('server', 'Suppressed expected SDK abort rejection:', message);
			return;
		}
		debug.error('server', 'Unhandled promise rejection (server still running):', reason);
	} catch {
		console.error('Unhandled promise rejection (server still running)');
	}
}

// Primary net on Bun 1.3.x — registering this handler prevents the default
// crash-on-unhandled-rejection behavior.
process.on('unhandledRejection', (reason) => {
	reportUnhandledRejection(reason);
});

// Belt-and-suspenders for Bun versions where only the Web API suppresses exit.
globalThis.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
	event.preventDefault();
	reportUnhandledRejection(event.reason);
});

process.on('uncaughtException', (error) => {
	try {
		debug.error('server', 'Uncaught exception (server still running):', error);
	} catch {
		console.error('Uncaught exception (server still running)');
	}
});
