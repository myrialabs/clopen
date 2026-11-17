#!/usr/bin/env bun

/**
 * Development script — runs backend and frontend side by side, each supervised.
 * Resolves available ports before spawning, then passes them via env
 * so Vite proxy and Elysia backend use the same coordinated ports.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { stopOnSignals, supervise } from '../shared/utils/process-supervisor';
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

// Each child is supervised on its own (shared/utils/process-supervisor.ts):
// its own process group, restarted when it stops without being asked to, and
// stopped together on Ctrl+C. This used to be `concurrently` with
// `killOthersOn: ['failure']`, which turned one process killed from outside —
// the frontend, by a stray SIGTERM — into the whole dev server going down.
const env = { ...process.env, ...portEnv, FORCE_COLOR: '1' };
const dataDir = process.env.CLOPEN_DATA_DIR?.trim() || join(homedir(), '.clopen-dev');
const reportFile = join(dataDir, 'logs', 'supervisor.log');

const COLORS = { backend: '\x1b[34m', frontend: '\x1b[32m' } as const;
const RESET = '\x1b[0m';

/** Prefix every line of a child's output with its colored name, like concurrently did. */
function prefixed(name: keyof typeof COLORS, target: NodeJS.WriteStream) {
	const prefix = `${COLORS[name]}[${name}]${RESET} `;
	const decoder = new TextDecoder();
	let pending = '';
	return (chunk: Uint8Array) => {
		pending += decoder.decode(chunk, { stream: true });
		const lines = pending.split('\n');
		pending = lines.pop() ?? '';
		if (lines.length > 0) target.write(lines.map((line) => prefix + line).join('\n') + '\n');
	};
}

const start = (name: keyof typeof COLORS, cmd: string[]) =>
	supervise({
		name,
		cmd,
		env,
		onStdout: prefixed(name, process.stdout),
		onStderr: prefixed(name, process.stderr),
		log: (line) => console.error(`${COLORS[name]}[${name}]${RESET} ${line}`),
		reportFile
	});

const supervisors = [
	start('backend', ['bun', '--watch', 'backend/index.ts']),
	start('frontend', ['bunx', 'vite', 'dev'])
];
stopOnSignals(supervisors);

// A child that keeps failing is given up on; then there is no dev server left
// to run, so stop the other one too.
await Promise.race(supervisors.map((s) => s.done));
const codes = await Promise.all(supervisors.map((s) => s.stop()));
process.exit(codes.find((code) => code !== 0) ?? 0);
