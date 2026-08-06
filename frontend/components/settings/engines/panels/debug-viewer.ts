import type { TerminalViewerHandle } from '@myrialabs/ptykit/client';

/**
 * Shared read-only debug terminal (PtyKit viewer — no PTY/input, just output).
 * Used by the Claude Code (setup-token PTY) and Codex (login stream) debug panels.
 */
export async function mountDebugViewer(container: HTMLElement): Promise<TerminalViewerHandle> {
	const { mountViewer } = await import('@myrialabs/ptykit/client');
	return mountViewer(container, {
		// theme, font family, scrollback, convertEol, cursor all default in PtyKit;
		// only the compact debug-panel font size + grid are app-specific.
		theme: 'dark',
		fontSize: 11,
		cols: 120,
		rows: 20
	});
}
