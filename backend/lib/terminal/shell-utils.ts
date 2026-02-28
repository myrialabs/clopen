/**
 * Shell utilities optimized for bun-pty
 * Provides cross-platform shell detection and PTY creation
 */

import { join } from 'path';
import { spawn, type IPty } from 'bun-pty';

import { debug } from '$shared/utils/logger';
import { getCleanSpawnEnv } from '../shared/env';
// Platform detection
export const isWindows = process.platform === 'win32';
export const isMacOS = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

/**
 * Find Git Bash executable on Windows
 */
export async function findGitBash(): Promise<string | null> {
	if (!isWindows) return null;
	
	const possiblePaths = [
		'C:\\Program Files\\Git\\bin\\bash.exe',
		'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
		process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Git', 'bin', 'bash.exe') : null,
		process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : null,
	].filter(Boolean) as string[];
	
	for (const bashPath of possiblePaths) {
		try {
			if (await Bun.file(bashPath).exists()) {
				debug.log('terminal', '✅ Found Git Bash at:', bashPath);
				return bashPath;
			}
		} catch {
			// Continue to next path
		}
	}
	
	return null;
}

/**
 * Find PowerShell executable on Windows
 */
export async function findPowerShell(): Promise<string | null> {
	if (!isWindows) return null;
	
	const possiblePaths = [
		'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
		'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
		process.env.SYSTEMROOT ? join(process.env.SYSTEMROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null,
	].filter(Boolean) as string[];
	
	for (const pwshPath of possiblePaths) {
		try {
			if (await Bun.file(pwshPath).exists()) {
				debug.log('terminal', '✅ Found PowerShell at:', pwshPath);
				return pwshPath;
			}
		} catch {
			// Continue to next path
		}
	}
	
	return null;
}

/**
 * Check if Git Bash is available
 */
export async function isGitBashAvailable(): Promise<boolean> {
	if (!isWindows) return false;
	return (await findGitBash()) !== null;
}

/**
 * Get Git Bash required message
 */
export function getGitBashRequiredMessage(command: string): string {
	return `⚠️  Git Bash is required for Unix commands!

The command '${command}' requires Git Bash.

Please install Git for Windows:
• Download from: https://git-scm.com/download/win
• Or install via: winget install Git.Git

After installation, restart the application.`;
}

/**
 * Get the appropriate shell configuration for the current platform
 */
export async function getShellConfig(preferGitBash = false): Promise<{
	shell: string;
	args: (command: string) => string[];
	name: string;
	isUnixLike: boolean;
}> {
	if (isWindows) {
		// For Windows, always use PowerShell as the primary shell
		// PowerShell is available on all modern Windows systems
		return {
			shell: 'powershell',
			args: (command: string) => ['-NoProfile', '-Command', command],
			name: 'PowerShell',
			isUnixLike: false
		};
	}
	
	// macOS
	if (isMacOS) {
		if (await Bun.file('/bin/zsh').exists()) {
			return {
				shell: '/bin/zsh',
				args: (command: string) => ['-c', command],
				name: 'Zsh',
				isUnixLike: true
			};
		}
		return {
			shell: '/bin/bash',
			args: (command: string) => ['-c', command],
			name: 'Bash',
			isUnixLike: true
		};
	}
	
	// Linux
	if (isLinux) {
		const userShell = process.env.SHELL || '/bin/bash';
		const shellName = userShell.split('/').pop() || 'Shell';
		return {
			shell: userShell,
			args: (command: string) => ['-c', command],
			name: shellName.charAt(0).toUpperCase() + shellName.slice(1),
			isUnixLike: true
		};
	}
	
	// Fallback
	return {
		shell: '/bin/sh',
		args: (command: string) => ['-c', command],
		name: 'Shell',
		isUnixLike: true
	};
}

/**
 * Create a clean PTY environment with terminal-specific overrides.
 * Uses getCleanSpawnEnv() to filter Bun/npm/Vite runtime pollution
 * on every call (catches Vite re-injection after startup).
 */
export function createCleanPtyEnv(terminalSize?: { cols: number; rows: number }): Record<string, string> {
	const ptyEnv = getCleanSpawnEnv();

	// Terminal-specific environment variables for xterm.js
	const cols = terminalSize?.cols || 80;
	const rows = terminalSize?.rows || 24;

	Object.assign(ptyEnv, {
		FORCE_COLOR: '1',
		COLORTERM: 'truecolor',
		TERM: 'xterm-256color',
		COLUMNS: cols.toString(),
		LINES: rows.toString(),
		TERM_PROGRAM: 'xterm.js',
		CLICOLOR: '1',
		LC_ALL: 'en_US.UTF-8',
		LANG: 'en_US.UTF-8'
	});

	return ptyEnv;
}

/**
 * Create a PTY instance using bun-pty with xterm.js optimizations
 */
export function createPty(shell: string, args: string[], cwd: string, terminalSize?: { cols: number; rows: number }): IPty {
	// Use clean environment (no Bun/npm/Vite pollution)
	const ptyEnv = createCleanPtyEnv(terminalSize);
	const cols = terminalSize?.cols || 80;
	const rows = terminalSize?.rows || 24;
	
	// Extract the actual command from args
	const actualCommand: string = '';
	
	if (isWindows) {
		// Windows: Always use PowerShell
		if (shell === 'powershell') {
			// Extract the actual command from args
			let actualCommand = args.join(' ');
			if (args.length >= 2 && (args[0] === '-Command' || args[0] === '-NoProfile')) {
				// Find the actual command in the args
				const commandIndex = args.findIndex(arg => arg === '-Command');
				if (commandIndex !== -1 && commandIndex + 1 < args.length) {
					actualCommand = args[commandIndex + 1];
				} else if (args[args.length - 1] !== '-Command' && args[args.length - 1] !== '-NoProfile') {
					actualCommand = args[args.length - 1];
				}
			}
			return spawn('powershell', ['-NoProfile', '-NoLogo', '-Command', actualCommand], {
				name: 'xterm-256color',
				cols,
				rows,
				cwd: cwd,
				env: ptyEnv
			});
		}
		
		// Default to PowerShell if shell is not recognized
		return spawn('powershell', ['-NoProfile', '-NoLogo', '-Command', args.join(' ') || 'Write-Host "Terminal ready"'], {
			name: 'xterm-256color',
			cols,
			rows,
			cwd: cwd,
			env: ptyEnv
		});
	}
	
	// Unix-like systems
	return spawn(shell, args, {
		name: 'xterm-256color',
		cols,
		rows,
		cwd: cwd,
		env: ptyEnv
	});
}

/**
 * Create a PTY wrapper for process-manager compatibility with xterm.js support
 */
export function createPtyWrapper(pty: IPty, sessionId?: string): any {
	let isKilled = false;
	
	return {
		pid: pty.pid,
		pty: pty, // Expose the original PTY instance
		
		// Expose PTY event handlers
		onData: (callback: (data: string) => void) => {
			return pty.onData(callback);
		},
		
		onExit: (callback: (event: { exitCode: number; signal?: number | string }) => void) => {
			return pty.onExit((event) => {
				isKilled = true;
				debug.log('terminal', `🏁 PTY ${pty.pid} exited with code:`, event.exitCode);
				callback({ exitCode: event.exitCode, signal: event.signal });
			});
		},
		
		resize: (cols: number, rows: number) => {
			try {
				debug.log('terminal', `🔧 Resizing PTY ${pty.pid} to ${cols}x${rows}`);
				pty.resize(cols, rows);
				debug.log('terminal', `✅ PTY ${pty.pid} resized successfully`);
			} catch (error) {
				debug.error('terminal', `❌ Failed to resize PTY ${pty.pid}:`, error);
				throw error;
			}
		},
		
		write: (data: string) => {
			return pty.write(data);
		},
		
		kill: (signal?: number | string) => {
			if (isKilled) {
				debug.log('terminal', '⚠️ PTY already killed, ignoring kill signal');
				return;
			}
			
			try {
				isKilled = true;
				debug.log('terminal', `💀 Killing PTY ${pty.pid} with signal:`, signal);
				
				if (signal === 'SIGKILL' || signal === 9) {
					pty.kill('SIGKILL');
				} else if (signal === 'SIGTERM' || signal === 15) {
					pty.kill('SIGTERM');
				} else {
					// Send Ctrl+C for graceful termination, then SIGKILL as fallback
					debug.log('terminal', '⌨️  Sending Ctrl+C to PTY...');
					pty.write('\x03');
					
					// Give the process time to handle Ctrl+C gracefully
					setTimeout(() => {
						try {
							if (pty.pid && !isKilled) {
								debug.log('terminal', '⏰ Graceful termination timeout, sending SIGKILL...');
								pty.kill('SIGKILL');
							}
						} catch (killError) {
							// Process might already be dead, this is expected
							debug.log('terminal', '💀 PTY process already terminated');
						}
					}, 1000);
				}
			} catch (e) {
				debug.log('terminal', '⚠️ Error killing PTY (this may be normal during shutdown):', e instanceof Error ? e.message : e);
			}
		},
		
		exited: new Promise<number>((resolve) => {
			pty.onExit((event) => {
				isKilled = true;
				debug.log('terminal', `🏁 PTY ${pty.pid} exited with code:`, event.exitCode);
				resolve(event.exitCode);
			});
		})
	};
}