/**
 * Engine setup-flow guard.
 *
 * Each engine keeps its own `Map<setupId, SetupProcess>` (Claude, Codex, …).
 * The shape varies, but every entry tracks a `disposed` flag, so the helper is
 * typed against that minimal contract.
 */

export interface SetupProcessLike {
	disposed: boolean;
}

/**
 * Resolve a live setup-flow session. Throws the same error for "missing" and
 * "expired", because the client handles both the same way: start again.
 */
export function requireSetupSession<T extends SetupProcessLike>(
	setupId: string,
	setupProcesses: Map<string, T>
): T {
	const entry = setupProcesses.get(setupId);
	if (!entry || entry.disposed) {
		throw new Error('Setup session not found or expired');
	}
	return entry;
}
