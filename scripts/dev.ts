#!/usr/bin/env bun

/**
 * Development script — runs backend and frontend concurrently.
 * Resolves available ports before spawning, then passes them via env
 * so Vite proxy and Elysia backend use the same coordinated ports.
 */

import concurrently from 'concurrently';
import { findAvailablePort } from '../backend/lib/shared/port-utils';

const desiredBackend = process.env.PORT_BACKEND ? parseInt(process.env.PORT_BACKEND) : 9151;
const desiredFrontend = process.env.PORT_FRONTEND ? parseInt(process.env.PORT_FRONTEND) : 9141;

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
	PORT_BACKEND: String(backendPort),
	PORT_FRONTEND: String(frontendPort),
};

concurrently([
	{ command: 'bun --watch backend/index.ts', name: 'backend', prefixColor: 'blue', env: portEnv },
	{ command: 'bunx vite dev', name: 'frontend', prefixColor: 'green', env: portEnv },
], {
	killOthersOn: ['failure'],
});
