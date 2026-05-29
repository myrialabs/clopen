#!/usr/bin/env bun

/**
 * Development script — runs backend and frontend concurrently.
 * Resolves available ports before spawning, then passes them via env
 * so Vite proxy and Elysia backend use the same coordinated ports.
 */

import concurrently from 'concurrently';
import { findAvailablePort } from '../backend/utils/port-utils';

const desiredBackend = process.env.CLOPEN_PORT_BACKEND ? parseInt(process.env.CLOPEN_PORT_BACKEND) : 9161;
const desiredFrontend = process.env.CLOPEN_PORT_FRONTEND ? parseInt(process.env.CLOPEN_PORT_FRONTEND) : 9151;

// Resolve available ports
const backendPort = await findAvailablePort(desiredBackend);
let frontendPort = await findAvailablePort(desiredFrontend);

// Ensure they don't collide
if (frontendPort === backendPort) {
	frontendPort = await findAvailablePort(frontendPort + 1);
}

if (backendPort !== desiredBackend) {
	console.log(`⚠️ Backend port ${desiredBackend} in use, using ${backendPort}`);
}
if (frontendPort !== desiredFrontend) {
	console.log(`⚠️ Frontend port ${desiredFrontend} in use, using ${frontendPort}`);
}

console.log(`Backend: http://localhost:${backendPort}`);
console.log(`Frontend: http://localhost:${frontendPort}`);
console.log();

const portEnv = {
	NODE_ENV: 'development',
	CLOPEN_PORT_BACKEND: String(backendPort),
	CLOPEN_PORT_FRONTEND: String(frontendPort),
};

const { result } = concurrently(
	[
		{ command: 'bun --watch backend/index.ts', name: 'backend', prefixColor: 'blue', env: portEnv },
		{ command: 'bunx vite dev', name: 'frontend', prefixColor: 'green', env: portEnv },
	],
	{
		killOthersOn: ['failure'],
	},
);

// SIGINT (130) and SIGTERM (143) are user-initiated shutdowns, not failures.
// Without this, concurrently's rejected Promise becomes an unhandled rejection
// and Bun dumps the full CloseEvent[] (with RxJS circular refs) on Ctrl+C.
const CLEAN_EXIT_CODES = new Set([0, 130, 143]);

try {
	await result;
	process.exit(0);
} catch (events) {
	const hasRealFailure =
		Array.isArray(events) &&
		events.some((e) => {
			const code = typeof e?.exitCode === 'number' ? e.exitCode : Number.parseInt(String(e?.exitCode), 10);
			return Number.isFinite(code) && !CLEAN_EXIT_CODES.has(code);
		});
	process.exit(hasRealFailure ? 1 : 0);
}
