#!/usr/bin/env bun

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

// CLI Options interface
interface CLIOptions {
	port?: number;
	host?: string;
	help?: boolean;
	version?: boolean;
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
Clopen - Modern web UI for Claude Code

USAGE:
  clopen [OPTIONS]

OPTIONS:
  -p, --port <number>     Port to run the server on (default: ${DEFAULT_PORT})
  --host <address>        Host address to bind to (default: ${DEFAULT_HOST})
  -v, --version           Show version number
  -h, --help              Show this help message

EXAMPLES:
  clopen                  # Start with default settings (port ${DEFAULT_PORT})
  clopen --port 9150      # Start on port 9150
  clopen --host 0.0.0.0   # Bind to all network interfaces
  clopen --version        # Show version

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

			default:
				console.error(`❌ Error: Unknown option "${arg}"`);
				console.log('Run "clopen --help" for usage information');
				process.exit(1);
		}
	}

	return options;
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

	// Run server as subprocess to ensure it uses local node_modules
	const serverPath = join(__dirname, 'backend/index.ts');

	stopLoading();

	// Prepare environment variables
	const env = { ...process.env };
	if (options.port) {
		env.PORT = options.port.toString();
	}
	if (options.host) {
		env.HOST = options.host;
	}

	const serverProc = Bun.spawn(['bun', serverPath], {
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
			console.log(getVersion());
			process.exit(0);
		}

		// Show help if requested
		if (options.help) {
			showHelp();
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
