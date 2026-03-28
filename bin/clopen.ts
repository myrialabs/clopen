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
 * - Dependency installation (always runs to ensure up-to-date)
 * - Build verification
 * - Server startup
 */

import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'fs';
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

// Simple loading indicator
let loadingInterval: Timer | null = null;
let currentMessage = '';

async function delay(ms: number = 500) {
	await new Promise(resolve => setTimeout(resolve, ms));
}

function updateLoading(message: string) {
	currentMessage = message;
	if (!loadingInterval) {
		const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
		let i = 0;
		loadingInterval = setInterval(() => {
			// Clear line and write new message to avoid text overlap
			process.stdout.write(`\r\x1b[K${frames[i]} ${currentMessage}`);
			i = (i + 1) % frames.length;
		}, 80);
	}
}

function stopLoading() {
	if (loadingInterval) {
		clearInterval(loadingInterval);
		loadingInterval = null;
		process.stdout.write('\r\x1b[K'); // Clear line
	}
}

const __dirname = join(import.meta.dir, '..');
const ENV_EXAMPLE = join(__dirname, '.env.example');
const ENV_FILE = join(__dirname, '.env');
const DIST_DIR = join(__dirname, 'dist');
const BUILD_VERSION_FILE = join(DIST_DIR, '.build-version');

// Default values
const DEFAULT_PORT = 9141;
const DEFAULT_HOST = 'localhost';
const MIN_PORT = 1024;
const MAX_PORT = 65535;

function showHelp() {
	console.log(`
Clopen - All-in-one web workspace for Claude Code & OpenCode

USAGE:
  clopen [OPTIONS]
  clopen update

COMMANDS:
  update                  Update clopen to the latest version
  reset-pat               Regenerate admin Personal Access Token
  clear-data              Delete all projects, sessions, and settings

OPTIONS:
  -p, --port <number>     Port to run the server on (default: ${DEFAULT_PORT})
  --host <address>        Host address to bind to (default: ${DEFAULT_HOST})
  -v, --version           Show version number
  -h, --help              Show this help message

EXAMPLES:
  clopen                  # Start with default settings
  clopen --port 9145      # Start on custom port
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

async function runUpdate() {
	const currentVersion = getVersion();
	console.log(`\x1b[36mClopen\x1b[0m v${currentVersion}\n`);

	// Check for latest version
	updateLoading('Checking for updates...');

	let latestVersion: string;
	try {
		const response = await fetch('https://registry.npmjs.org/@myrialabs/clopen/latest');
		if (!response.ok) {
			stopLoading();
			console.error(`❌ Failed to check for updates (HTTP ${response.status})`);
			process.exit(1);
		}
		const data = await response.json() as { version: string };
		latestVersion = data.version;
	} catch (err) {
		stopLoading();
		console.error('❌ Failed to reach npm registry:', err instanceof Error ? err.message : err);
		process.exit(1);
	}

	stopLoading();

	if (!isNewerVersion(currentVersion, latestVersion)) {
		console.log(`✓ Already up to date (v${currentVersion})`);
		process.exit(0);
	}

	console.log(`  New version available: v${currentVersion} → \x1b[32mv${latestVersion}\x1b[0m\n`);

	// Run update
	updateLoading(`Updating to v${latestVersion}...`);

	const proc = Bun.spawn(['bun', 'add', '-g', '@myrialabs/clopen@latest'], {
		stdout: 'pipe',
		stderr: 'pipe'
	});

	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text()
	]);

	const exitCode = await proc.exited;
	stopLoading();

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

	// Initialize database (import dynamically to avoid loading full backend)
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
	updateLoading('Clearing all data...');

	const { initializeDatabase, closeDatabase } = await import('../backend/database/index');
	const { getClopenDir } = await import('../backend/utils/paths');
	const { resetEnvironment } = await import('../backend/engine/adapters/claude/environment');
	const fs = await import('node:fs/promises');

	// Initialize database so we can close it properly
	await initializeDatabase();

	// Close database connection
	closeDatabase();

	// Delete entire clopen directory
	const clopenDir = getClopenDir();
	await fs.rm(clopenDir, { recursive: true, force: true });

	// Reset environment state
	resetEnvironment();

	// Reinitialize database from scratch
	await initializeDatabase();

	stopLoading();
	console.log('✓ All data cleared successfully.');
	console.log('  Database has been reinitialized with a fresh state.');
}

async function setupEnvironment() {
	// Check if .env exists, if not copy from .env.example
	if (!existsSync(ENV_FILE)) {
		if (existsSync(ENV_EXAMPLE)) {
			copyFileSync(ENV_EXAMPLE, ENV_FILE);
		}
	}
}

async function installDependencies() {
	// Always run bun install to ensure dependencies are up to date
	// Bun is fast and will skip if nothing changed
	updateLoading('Checking dependencies...');
	await delay();

	const installProc = Bun.spawn(['bun', 'install', '--silent'], {
		cwd: __dirname,
		stdout: 'pipe',
		stderr: 'pipe'
	});

	// If install takes longer than 3 seconds, it's actually installing
	const updateMessageTimeout = setTimeout(() => {
		updateLoading('Installing dependencies...');
	}, 3000);

	const exitCode = await installProc.exited;
	clearTimeout(updateMessageTimeout);

	if (exitCode !== 0) {
		stopLoading();
		// Show error output only if failed
		const errorText = await new Response(installProc.stderr).text();
		console.error('❌ Dependency installation failed:');
		console.error(errorText);
		process.exit(exitCode);
	}
}

function needsBuild(): boolean {
	// No dist directory — must build
	if (!existsSync(DIST_DIR)) return true;

	// No build version file — must build
	if (!existsSync(BUILD_VERSION_FILE)) return true;

	// Compare built version with current version
	try {
		const builtVersion = readFileSync(BUILD_VERSION_FILE, 'utf-8').trim();
		return builtVersion !== getVersion();
	} catch {
		return true;
	}
}

async function verifyBuild() {
	if (needsBuild()) {
		updateLoading('Building...');
		await delay();

		const buildProc = Bun.spawn(['bun', 'run', 'build'], {
			cwd: __dirname,
			stdout: 'pipe',
			stderr: 'pipe'
		});

		const exitCode = await buildProc.exited;

		if (exitCode !== 0) {
			stopLoading();
			const errorText = await new Response(buildProc.stderr).text();
			console.error('❌ Build failed:');
			console.error(errorText);
			process.exit(exitCode);
		}

		// Write current version to build version file
		writeFileSync(BUILD_VERSION_FILE, getVersion());
	}
}

async function startServer(options: CLIOptions) {
	updateLoading('Starting server...');
	await delay();

	// Delegate to scripts/start.ts — handles port resolution (IPv4 + IPv6
	// zombie detection) and starts backend in a single consistent path.
	const startScript = join(__dirname, 'scripts/start.ts');

	stopLoading();

	// Overlay clopen's own .env on top of process.env to override any
	// pollution from a .env file in the directory where `clopen` was invoked.
	// CLI args take highest priority on top of that.
	const env = { ...process.env, ...loadEnvFile(ENV_FILE) };
	if (options.port) env.PORT = options.port.toString();
	if (options.host) env.HOST = options.host;

	const serverProc = Bun.spawn(['bun', startScript], {
		cwd: __dirname,
		stdout: 'inherit',
		stderr: 'inherit',
		stdin: 'inherit',
		env
	});

	// Wait for server process
	await serverProc.exited;
}

async function main() {
	try {
		// Parse CLI arguments
		const options = parseArguments();

		// Show version if requested
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

		// Show help if requested
		if (options.help) {
			showHelp();
			process.exit(0);
		}

		// Run update if requested
		if (options.update) {
			await runUpdate();
			process.exit(0);
		}

		// Recover admin token if requested
		if (options.resetPat) {
			await setupEnvironment();
			await recoverAdminToken();
			process.exit(0);
		}

		// Clear all data if requested
		if (options.clearData) {
			await setupEnvironment();
			await clearAllData();
			process.exit(0);
		}

		// 1. Setup environment variables
		await setupEnvironment();

		// 2. Install dependencies if needed
		await installDependencies();

		// 3. Verify/build frontend
		await verifyBuild();

		// 4. Start server
		await startServer(options);

	} catch (error) {
		console.error('❌ Failed to start Clopen:', error);
		process.exit(1);
	}
}

// Run CLI
main();
