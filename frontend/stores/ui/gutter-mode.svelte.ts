/**
 * Editor Gutter Mode
 *
 * Which set of changes the editor's coloured gutter paints: what this chat
 * changed, or what differs from git HEAD. Module-level so the choice follows
 * the user between the Files panel's editor and the peek modal, which are two
 * component instances of the same viewer.
 */

export type GutterViewMode = 'ai' | 'git';

interface GutterModeState {
	mode: GutterViewMode;
}

export const gutterModeState = $state<GutterModeState>({ mode: 'ai' });

export function setGutterViewMode(mode: GutterViewMode): void {
	gutterModeState.mode = mode;
}
