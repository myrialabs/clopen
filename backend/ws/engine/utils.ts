/**
 * Engine Utilities
 *
 * Shared helpers used by engine status handlers.
 */

export function getBackendOS(): 'windows' | 'macos' | 'linux' {
	switch (process.platform) {
		case 'win32': return 'windows';
		case 'darwin': return 'macos';
		default: return 'linux';
	}
}

export async function detectCLI(command: string): Promise<{ installed: boolean; version: string | null }> {
	try {
		const proc = Bun.spawn([command, '--version'], {
			stdout: 'pipe',
			stderr: 'pipe'
		});

		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			return { installed: false, version: null };
		}

		const stdout = await new Response(proc.stdout).text();
		const raw = stdout.trim();
		// Extract only the version token (e.g. "2.1.52" from "2.1.52 (Claude Code)")
		// Takes everything before the first whitespace or parenthesis
		const version = raw.split(/[\s(]/)[0] || raw || null;
		return { installed: true, version };
	} catch {
		return { installed: false, version: null };
	}
}
