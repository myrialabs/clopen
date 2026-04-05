#!/usr/bin/env bun

/**
 * Production start script — resolves available port before starting backend.
 * Mirrors scripts/dev.ts: ensures port is truly available (IPv4 + IPv6)
 * before the backend binds, avoiding silent hangs from zombie processes.
 */

import { findAvailablePort } from '../backend/utils/port-utils';

const desiredPort = process.env.CLOPEN_PORT ? parseInt(process.env.CLOPEN_PORT) : 9141;

const port = await findAvailablePort(desiredPort);

if (port !== desiredPort) {
	console.log(`⚠️ Port ${desiredPort} in use, using ${port}`);
}

// Set resolved values before importing backend (env.ts reads at import time)
process.env.CLOPEN_PORT = String(port);
process.env.CLOPEN_HOST = process.env.CLOPEN_HOST || 'localhost';
process.env.NODE_ENV = 'production';

await import('../backend/index.ts');
