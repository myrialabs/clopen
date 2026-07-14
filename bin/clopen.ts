#!/usr/bin/env bun

// Runtime guard — Bun only, reject Node.js and Deno
if (typeof globalThis.Bun === 'undefined') {
	console.error('\x1b[31mError: Clopen requires Bun runtime.\x1b[0m');
	console.error('Node.js and Deno are not supported.');
	console.error('');
	console.error('Install Bun: https://bun.sh');
	console.error('Then run:    bun clopen');
	process.exit(1);
}

/**
 * Clopen CLI Entry Point
 *
 * Handles:
 * - CLI argument parsing
 * - Environment setup (.env from .env.example)
 * - Server startup
 *
 * Note: dist/ is pre-built and included in the published package.
 * Dependencies are installed by the package manager (bun add -g).
 */

import { existsSync, copyFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadEnvFile } from '../backend/utils/env';

// CLI Options interface
interface CLIOptions {
	port?: number;
	host?: string;
	help?: boolean;
	version?: boolean;
	update?: boolean;
	resetPat?: boolean;
	clearData?: boolean;
	log?: boolean;
}

// Get version from package.json
function getVersion(): string {
	try {
		const packagePath = join(__dirname, 'package.json');
		const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'));
		return packageJson.version || '0.0.0';
	} catch {
		return '0.0.0';
	}
}

// ============================================================
// Simple single-line spinner (used for update / clear-data)
// ============================================================

let spinnerInterval: Timer | null = null;
let spinnerMessage = '';

function startSpinner(message: string) {
	spinnerMessage = message;
	if (!spinnerInterval) {
		const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
		let i = 0;
		spinnerInterval = setInterval(() => {
			process.stdout.write(`\r\x1b[K${frames[i]} ${spinnerMessage}`);
			i = (i + 1) % frames.length;
		}, 80);
	}
}

function updateSpinner(message: string) {
	spinnerMessage = message;
}

function stopSpinner() {
	if (spinnerInterval) {
		clearInterval(spinnerInterval);
		spinnerInterval = null;
		process.stdout.write('\r\x1b[K');
	}
}

// Restore cursor on unexpected exit
process.on('exit', () => {
	if (spinnerInterval) clearInterval(spinnerInterval);
});

// ============================================================
// Constants
// ============================================================

const __dirname = join(import.meta.dir, '..');
const ENV_EXAMPLE = join(__dirname, '.env.example');
const ENV_FILE = join(__dirname, '.env');
const DIST_DIR = join(__dirname, 'dist');

const DEFAULT_PORT = 9141;
const DEFAULT_HOST = 'localhost';
const MIN_PORT = 1024;
const MAX_PORT = 65535;

// ============================================================
// CLI helpers
// ============================================================

function showHelp() {
	console.log(`
Clopen - All-in-one web workspace for Claude Code & OpenCode

USAGE:
  clopen [OPTIONS]
  clopen <command>

COMMANDS:
  update                  Update clopen to the latest version
  reset-pat               Regenerate admin Personal Access Token
  clear-data              Delete all projects, sessions, and settings

OPTIONS:
  -p, --port <number>     Port to run the server on (default: ${DEFAULT_PORT})
  --host <address>        Host address to bind to (default: ${DEFAULT_HOST})
  --log                   Enable debug logging output
  -v, --version           Show version number
  -h, --help              Show this help message

EXAMPLES:
  clopen                  # Start with default settings
  clopen --port 9145      # Start on custom port
  clopen --log            # Start with debug logging
  clopen -v               # Show version
  clopen update           # Update to latest version

For more information, visit: https://github.com/myrialabs/clopen
`);
}

function parseArguments(): CLIOptions {
	const args = process.argv.slice(2);
	const options: CLIOptions = {};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		switch (arg) {
			case '-h':
			case '--help':
				options.help = true;
				break;

			case '-v':
			case '--version':
				options.version = true;
				break;

			case '-p':
			case '--port': {
				const portValue = args[++i];
				if (!portValue) {
					console.error('❌ Error: --port requires a value');
					console.log('Run "clopen --help" for usage information');
					process.exit(1);
				}
				const port = parseInt(portValue);
				if (isNaN(port)) {
					console.error(`❌ Error: Invalid port "${portValue}". Port must be a number.`);
					process.exit(1);
				}
				if (port < MIN_PORT || port > MAX_PORT) {
					console.error(`❌ Error: Port must be between ${MIN_PORT} and ${MAX_PORT}.`);
					process.exit(1);
				}
				options.port = port;
				break;
			}

			case '--host': {
				const hostValue = args[++i];
				if (!hostValue) {
					console.error('❌ Error: --host requires a value');
					console.log('Run "clopen --help" for usage information');
					process.exit(1);
				}
				options.host = hostValue;
				break;
			}

			case 'update':
				options.update = true;
				break;

			case 'reset-pat':
				options.resetPat = true;
				break;

			case 'clear-data':
				options.clearData = true;
				break;

			case '--log':
				options.log = true;
				break;

			default:
				console.error(`❌ Error: Unknown option "${arg}"`);
				console.log('Run "clopen --help" for usage information');
				process.exit(1);
		}
	}

	return options;
}

/** Simple semver comparison: returns true if latest > current */
function isNewerVersion(current: string, latest: string): boolean {
	const currentParts = current.split('.').map(Number);
	const latestParts = latest.split('.').map(Number);

	for (let i = 0; i < 3; i++) {
		const c = currentParts[i] || 0;
		const l = latestParts[i] || 0;
		if (l > c) return true;
		if (l < c) return false;
	}
	return false;
}

// ============================================================
// Commands
// ============================================================

async function runUpdate() {
	const currentVersion = getVersion();
	console.log(`\x1b[36mClopen\x1b[0m v${currentVersion}\n`);

	startSpinner('Checking for updates...');

	let latestVersion: string;
	try {
		const response = await fetch('https://registry.npmjs.org/@myrialabs/clopen/latest');
		if (!response.ok) {
			stopSpinner();
			console.error(`❌ Failed to check for updates (HTTP ${response.status})`);
			process.exit(1);
		}
		const data = await response.json() as { version: string };
		latestVersion = data.version;
	} catch (err) {
		stopSpinner();
		console.error('❌ Failed to reach npm registry:', err instanceof Error ? err.message : err);
		process.exit(1);
	}

	stopSpinner();

	if (!isNewerVersion(currentVersion, latestVersion)) {
		console.log(`✓ Already up to date (v${currentVersion})`);
		process.exit(0);
	}

	console.log(`  New version available: v${currentVersion} → \x1b[32mv${latestVersion}\x1b[0m\n`);

	startSpinner(`Updating to v${latestVersion}...`);

	const proc = Bun.spawn(['bun', 'add', '-g', '@myrialabs/clopen@latest'], {
		stdout: 'pipe',
		stderr: 'pipe'
	});

	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text()
	]);

	const exitCode = await proc.exited;
	stopSpinner();

	if (exitCode !== 0) {
		const output = (stdout + '\n' + stderr).trim();
		console.error('❌ Update failed:');
		console.error(output);
		process.exit(exitCode);
	}

	console.log(`✓ Updated to v${latestVersion}`);
	console.log('\n  Restart clopen to apply the update.');
}

async function recoverAdminToken() {
	const version = getVersion();
	console.log(`\x1b[36mClopen\x1b[0m v${version} — Admin Token Recovery\n`);

	const { initializeDatabase } = await import('../backend/database/index');
	const { listUsers, regeneratePAT } = await import('../backend/auth/auth-service');

	await initializeDatabase();

	const users = listUsers();
	const admin = users.find(u => u.role === 'admin');

	if (!admin) {
		console.error('❌ No admin user found. Start clopen first to complete setup.');
		process.exit(1);
	}

	const newPAT = regeneratePAT(admin.id);

	console.log(`  Admin  : ${admin.name}`);
	console.log(`  New PAT: \x1b[32m${newPAT}\x1b[0m`);
	console.log(`\n  Use this token to log in. Keep it safe — it won't be shown again.`);
}

async function clearAllData() {
	const version = getVersion();
	console.log(`\x1b[36mClopen\x1b[0m v${version} — Clear All Data\n`);

	console.log('\x1b[31m⚠  WARNING: This will permanently delete all projects, sessions, and settings.\x1b[0m');
	console.log('   This action cannot be undone.\n');

	process.stdout.write('Are you sure? Type "yes" to confirm: ');

	const response = await new Promise<string>(resolve => {
		const chunks: Buffer[] = [];
		process.stdin.once('data', (data: Buffer) => {
			chunks.push(data);
			resolve(Buffer.concat(chunks).toString().trim());
		});
	});

	if (response !== 'yes') {
		console.log('\nAborted. No data was deleted.');
		process.exit(0);
	}

	console.log('');
	startSpinner('Clearing all data...');

	const { initializeDatabase, closeDatabase } = await import('../backend/database/index');
	const { getClopenDir } = await import('../backend/utils/paths');
	const { resetEnvironment } = await import('../backend/engine/adapters/claude/environment');
	const fs = await import('node:fs/promises');

	await initializeDatabase();
	closeDatabase();

	const clopenDir = getClopenDir();
	await fs.rm(clopenDir, { recursive: true, force: true });

	resetEnvironment();

	await initializeDatabase();

	stopSpinner();
	console.log('✓ All data cleared successfully.');
	console.log('  Database has been reinitialized with a fresh state.');
}

// ============================================================
// Startup sequence
// ============================================================

async function setupEnvironment() {
	if (existsSync(ENV_EXAMPLE)) {
		copyFileSync(ENV_EXAMPLE, ENV_FILE);
	}
}

function ensureBuild() {
	if (!existsSync(DIST_DIR)) {
		console.error('❌ Build artifacts not found (dist/ is missing).');
		console.error('   This usually means the package was not published correctly.');
		console.error('   Try reinstalling: bun add -g @myrialabs/clopen');
		process.exit(1);
	}
}

async function startServer(options: CLIOptions) {
	// cwd is set to __dirname (package root) below so Bun picks up bunfig.toml,
	// which preloads the node:v8 isBuildingSnapshot shim before the backend's
	// import graph — see bunfig.toml and backend/utils/bun-compat.ts.
	const startScript = join(__dirname, 'scripts/start.ts');

	const env = { ...process.env, ...loadEnvFile(ENV_FILE) };
	if (options.port) env.CLOPEN_PORT = options.port.toString();
	if (options.host) env.CLOPEN_HOST = options.host;
	if (options.log) env.CLOPEN_DEBUG = 'true';

	startSpinner('Starting server...');

	const serverProc = Bun.spawn(['bun', startScript], {
		cwd: __dirname,
		stdout: 'pipe',
		stderr: 'pipe',
		stdin: 'inherit',
		env,
	});

	// Forward subprocess output, stopping spinner on first chunk
	let spinnerActive = true;

	async function pipeStream(stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream) {
		const reader = stream.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (spinnerActive) {
					stopSpinner();
					spinnerActive = false;
				}
				target.write(value);
			}
		} finally {
			reader.releaseLock();
		}
	}

	await Promise.all([
		pipeStream(serverProc.stdout, process.stdout),
		pipeStream(serverProc.stderr, process.stderr),
		serverProc.exited,
	]);

	if (spinnerActive) stopSpinner();
}

// ============================================================
// Main
// ============================================================

async function main() {
	try {
		const options = parseArguments();

		if (options.version) {
			const currentVersion = getVersion();
			console.log(`v${currentVersion}`);

			try {
				const response = await fetch('https://registry.npmjs.org/@myrialabs/clopen/latest');
				if (response.ok) {
					const data = await response.json() as { version: string };
					if (isNewerVersion(currentVersion, data.version)) {
						console.log(`\x1b[33mUpdate available: v${data.version}\x1b[0m — run \x1b[36mclopen update\x1b[0m to update`);
					} else {
						console.log('\x1b[32m(latest)\x1b[0m');
					}
				}
			} catch {
				// Silent fail — network unavailable
			}

			process.exit(0);
		}

		if (options.help) {
			showHelp();
			process.exit(0);
		}

		if (options.update) {
			await runUpdate();
			process.exit(0);
		}

		if (options.resetPat) {
			await setupEnvironment();
			await recoverAdminToken();
			process.exit(0);
		}

		if (options.clearData) {
			await setupEnvironment();
			await clearAllData();
			process.exit(0);
		}

		// Print header
		console.log(`\n\x1b[36mClopen\x1b[0m v${getVersion()}\n`);

		await setupEnvironment();
		ensureBuild();
		await startServer(options);

	} catch (error) {
		console.error('❌ Failed to start Clopen:', error);
		process.exit(1);
	}
}

main();
