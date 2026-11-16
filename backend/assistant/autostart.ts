/**
 * Start Clopen when the computer starts.
 *
 * Jobs only run while Clopen is running, so a schedule set for 07:00 does
 * nothing if Clopen was not started that morning. This registers Clopen with
 * the operating system's own per-user service manager — no administrator
 * rights, nothing outside the user's own account:
 *
 *   macOS    a LaunchAgent in ~/Library/LaunchAgents (RunAtLoad, KeepAlive)
 *   Linux    a systemd user unit in ~/.config/systemd/user (enabled, restarts)
 *   Windows  a Task Scheduler task that runs at log on
 *
 * Off by default; the owner turns it on in the setup wizard or in Settings, or
 * with `clopen service install`. Self-contained on purpose: the CLI imports
 * this before any of the server exists.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const SERVICE_LABEL = 'dev.myrialabs.clopen';

export interface AutostartStatus {
	supported: boolean;
	enabled: boolean;
	method: 'launchd' | 'systemd' | 'task-scheduler' | null;
	/** Why it is not supported here, when it is not. */
	reason?: string;
}

export interface AutostartTarget {
	/** The Bun executable. */
	bun: string;
	/** `bin/clopen.ts` of the installed package. */
	entry: string;
	port?: number;
}

function launchAgentPath(): string {
	return join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

function systemdUnitPath(): string {
	return join(homedir(), '.config', 'systemd', 'user', 'clopen.service');
}

function run(command: string[]): { ok: boolean; output: string } {
	try {
		const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' });
		return { ok: result.exitCode === 0, output: `${result.stdout?.toString() ?? ''}${result.stderr?.toString() ?? ''}` };
	} catch (error) {
		return { ok: false, output: error instanceof Error ? error.message : String(error) };
	}
}

function xml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The installed package's CLI entry, when Clopen runs from an installed package. */
export function defaultTarget(port?: number): AutostartTarget | null {
	const entry = [join(process.cwd(), 'bin', 'clopen.ts'), join(process.cwd(), 'clopen.ts')].find((candidate) => existsSync(candidate));
	if (!entry) return null;
	return { bun: process.execPath, entry, port };
}

export function autostartStatus(): AutostartStatus {
	switch (process.platform) {
		case 'darwin':
			return { supported: true, enabled: existsSync(launchAgentPath()), method: 'launchd' };
		case 'linux': {
			if (!run(['systemctl', '--user', '--version']).ok) {
				return { supported: false, enabled: false, method: null, reason: 'This Linux system has no user systemd. Start Clopen from your own startup script instead.' };
			}
			return { supported: true, enabled: run(['systemctl', '--user', 'is-enabled', 'clopen.service']).ok, method: 'systemd' };
		}
		case 'win32':
			return { supported: true, enabled: run(['schtasks', '/Query', '/TN', 'Clopen']).ok, method: 'task-scheduler' };
		default:
			return { supported: false, enabled: false, method: null, reason: `Starting with the computer is not supported on ${process.platform}.` };
	}
}

export function enableAutostart(target: AutostartTarget): AutostartStatus {
	const args = [target.entry, ...(target.port ? ['--port', String(target.port)] : [])];
	switch (process.platform) {
		case 'darwin': {
			const path = launchAgentPath();
			mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
			const logDir = join(homedir(), '.clopen', 'logs');
			mkdirSync(logDir, { recursive: true });
			writeFileSync(
				path,
				`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${SERVICE_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(target.bun)}</string>
${args.map((arg) => `		<string>${xml(arg)}</string>`).join('\n')}
	</array>
	<key>EnvironmentVariables</key>
	<dict><key>PATH</key><string>${xml(process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin')}</string></dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
	<key>StandardOutPath</key><string>${xml(join(logDir, 'clopen.log'))}</string>
	<key>StandardErrorPath</key><string>${xml(join(logDir, 'clopen.log'))}</string>
</dict>
</plist>
`
			);
			// Not loaded now: launchd would start it at once, next to the Clopen
			// that is asking and already holds the port. It takes effect at the
			// next log in, which is the point.
			break;
		}
		case 'linux': {
			const path = systemdUnitPath();
			mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
			writeFileSync(
				path,
				`[Unit]
Description=Clopen
After=network-online.target

[Service]
ExecStart=${[target.bun, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ')}
Environment=PATH=${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
			);
			run(['systemctl', '--user', 'daemon-reload']);
			const enabled = run(['systemctl', '--user', 'enable', 'clopen.service']);
			if (!enabled.ok) throw new Error(`systemd refused: ${enabled.output.trim()}`);
			// Keep it running after the last session closes (best effort; needs no root on most systems).
			run(['loginctl', 'enable-linger']);
			break;
		}
		case 'win32': {
			const command = `"${target.bun}" ${args.map((arg) => `"${arg}"`).join(' ')}`;
			const created = run(['schtasks', '/Create', '/F', '/SC', 'ONLOGON', '/TN', 'Clopen', '/TR', command]);
			if (!created.ok) throw new Error(`Task Scheduler refused: ${created.output.trim()}`);
			break;
		}
		default:
			throw new Error(`Starting with the computer is not supported on ${process.platform}.`);
	}
	return autostartStatus();
}

export function disableAutostart(): AutostartStatus {
	switch (process.platform) {
		case 'darwin': {
			const path = launchAgentPath();
			if (existsSync(path)) {
				run(['launchctl', 'unload', '-w', path]);
				rmSync(path, { force: true });
			}
			break;
		}
		case 'linux':
			run(['systemctl', '--user', 'disable', 'clopen.service']);
			rmSync(systemdUnitPath(), { force: true });
			run(['systemctl', '--user', 'daemon-reload']);
			break;
		case 'win32':
			run(['schtasks', '/Delete', '/F', '/TN', 'Clopen']);
			break;
	}
	return autostartStatus();
}
