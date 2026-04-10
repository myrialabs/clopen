/**
 * CLI Binary Resolution & Status
 *
 * Uses Bun.which() for cross-platform PATH resolution.
 * Bun.which() returns absolute paths and handles PATHEXT
 * extensions (.exe, .cmd) on Windows automatically.
 */

export type CLIStatus = { installed: boolean; version: string | null };

export async function getStatus(command: string): Promise<CLIStatus> {
	const resolved = Bun.which(command);
	if (!resolved) return { installed: false, version: null };

	try {
		const proc = Bun.spawn([resolved, '--version'], { stdout: 'pipe', stderr: 'pipe' });
		const exitCode = await proc.exited;
		if (exitCode !== 0) return { installed: false, version: null };

		const stdout = await new Response(proc.stdout).text();
		const raw = stdout.trim();
		const version = raw.split(/[\s(]/)[0] || raw || null;
		return { installed: true, version };
	} catch {
		return { installed: false, version: null };
	}
}