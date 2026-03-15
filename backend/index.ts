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
import { debug } from '$shared/utils/logger';
import { networkInterfaces } from 'os';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';

// Import WebSocket router
import { wsRouter } from './ws';

// Backup scheduler
import { startBackupScheduler, stopBackupScheduler } from './db-manager/backup';

// SQL-to-REST API Generator
import {
	executeEndpointQuery,
	checkRateLimit,
	getRateLimitReset,
	generateOpenApiSpec,
	generateSwaggerHtml,
	hashApiKey
} from './db-manager/sql-rest-api';
import { sqlRestApiQueries } from './database/queries';

// MCP remote server for Open Code custom tools
import { handleMcpRequest, closeMcpServer } from './mcp/remote-server';

// Auth middleware
import { checkRouteAccess } from './auth/permissions';
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

	// ── SQL-to-REST API Generator ────────────────────────────────────────────

	// OpenAPI spec JSON — use relative base URL so Swagger UI resolves against its own origin
	.get('/sql-api/spec', () => {
		const endpoints = sqlRestApiQueries.listEndpoints().filter((e) => e.enabled);
		const spec = generateOpenApiSpec(endpoints, '/');
		return new Response(JSON.stringify(spec, null, 2), {
			headers: {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*'
			}
		});
	})

	// Swagger UI HTML — use relative URL so the spec is fetched same-origin as the browser
	.get('/sql-api/docs', () => {
		const html = generateSwaggerHtml('/sql-api/spec');
		return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
	})

	// Execute a SQL API endpoint by slug
	.get('/sql-api/:slug', async ({ params, query, request }) => {
		const { slug } = params;
		const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
			?? request.headers.get('cf-connecting-ip')
			?? 'unknown';

		const endpoint = sqlRestApiQueries.getEndpointBySlug(slug);
		if (!endpoint) {
			return new Response(JSON.stringify({ error: 'Endpoint not found', code: 'ENDPOINT_NOT_FOUND' }), {
				status: 404, headers: { 'Content-Type': 'application/json' }
			});
		}

		if (!endpoint.enabled) {
			return new Response(JSON.stringify({ error: 'Endpoint is disabled', code: 'ENDPOINT_DISABLED' }), {
				status: 503, headers: { 'Content-Type': 'application/json' }
			});
		}

		// API key authentication for private endpoints
		let apiKeyId: string | null = null;
		if (!endpoint.isPublic) {
			const rawKey = request.headers.get('x-api-key') ?? (query as Record<string, string>)['api_key'];
			if (!rawKey) {
				return new Response(JSON.stringify({ error: 'API key required', code: 'UNAUTHORIZED' }), {
					status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'ApiKey' }
				});
			}
			const keyHash = await hashApiKey(rawKey);
			const apiKey = sqlRestApiQueries.getKeyByHash(keyHash);
			if (!apiKey || !apiKey.enabled) {
				return new Response(JSON.stringify({ error: 'Invalid or disabled API key', code: 'UNAUTHORIZED' }), {
					status: 401, headers: { 'Content-Type': 'application/json' }
				});
			}
			if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
				return new Response(JSON.stringify({ error: 'API key has expired', code: 'UNAUTHORIZED' }), {
					status: 401, headers: { 'Content-Type': 'application/json' }
				});
			}
			if (apiKey.endpointId !== '*' && apiKey.endpointId !== endpoint.id) {
				return new Response(JSON.stringify({ error: 'API key not authorized for this endpoint', code: 'UNAUTHORIZED' }), {
					status: 401, headers: { 'Content-Type': 'application/json' }
				});
			}
			apiKeyId = apiKey.id;
			// Update last_used_at asynchronously (best-effort)
			try { sqlRestApiQueries.touchKeyLastUsed(apiKey.id); } catch { /* ignore */ }
		}

		// Rate limiting
		const clientId = apiKeyId ?? ip;
		const allowed = checkRateLimit(endpoint.id, clientId, endpoint.rateLimitRequests, endpoint.rateLimitWindowSecs);
		if (!allowed) {
			const retryAfter = getRateLimitReset(endpoint.id, clientId, endpoint.rateLimitWindowSecs);
			const logId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
			try {
				sqlRestApiQueries.addRequestLog({
					id: logId,
					endpointId: endpoint.id,
					endpointSlug: endpoint.slug,
					apiKeyId,
					ipAddress: ip,
					params: query as Record<string, string>,
					statusCode: 429,
					rowCount: null,
					executionTimeMs: null,
					error: 'Rate limit exceeded'
				});
			} catch { /* ignore */ }
			return new Response(JSON.stringify({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' }), {
				status: 429,
				headers: {
					'Content-Type': 'application/json',
					'Retry-After': String(retryAfter),
					'X-RateLimit-Limit': String(endpoint.rateLimitRequests),
					'X-RateLimit-Window': String(endpoint.rateLimitWindowSecs)
				}
			});
		}

		// Execute query
		const queryParams = { ...(query as Record<string, string>) };
		delete queryParams['api_key']; // strip auth param before passing to SQL engine
		const { result, error: execError } = await executeEndpointQuery(endpoint, queryParams);

		const logId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		if (execError) {
			try {
				sqlRestApiQueries.addRequestLog({
					id: logId,
					endpointId: endpoint.id,
					endpointSlug: endpoint.slug,
					apiKeyId,
					ipAddress: ip,
					params: queryParams,
					statusCode: execError.code === 'PARAM_ERROR' ? 400 : 500,
					rowCount: null,
					executionTimeMs: null,
					error: execError.error
				});
			} catch { /* ignore */ }
			const status = execError.code === 'PARAM_ERROR' || execError.code === 'SELECT_ONLY' ? 400 : 500;
			return new Response(JSON.stringify(execError), {
				status, headers: { 'Content-Type': 'application/json' }
			});
		}

		try {
			sqlRestApiQueries.addRequestLog({
				id: logId,
				endpointId: endpoint.id,
				endpointSlug: endpoint.slug,
				apiKeyId,
				ipAddress: ip,
				params: queryParams,
				statusCode: 200,
				rowCount: result!.rowCount,
				executionTimeMs: result!.executionTimeMs,
				error: null
			});
		} catch { /* ignore */ }

		return new Response(JSON.stringify(result), {
			status: 200,
			headers: {
				'Content-Type': 'application/json',
				'X-Execution-Time': String(result!.executionTimeMs),
				'X-Row-Count': String(result!.rowCount),
				'X-Cached': result!.cached ? 'true' : 'false'
			}
		});
	})

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

	// Initialize database first before accepting connections
	try {
		await initializeDatabase();
		debug.log('database', '✅ Database initialized successfully');
	} catch (error) {
		debug.warn('database', '⚠️ Database initialization failed:', error);
	}

	// Start the automated backup scheduler
	startBackupScheduler();

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
async function gracefulShutdown() {
	console.log('\n🛑 Shutting down server...');
	try {
		// Stop backup scheduler
		stopBackupScheduler();
		// Close MCP remote server (before engines, as they may still reference it)
		await closeMcpServer();
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
