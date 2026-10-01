/**
 * What every Clopen editor shares, code or diff.
 *
 * The code editor and the diff editor were configured separately, and drifted:
 * a 14px scrollbar in one, 8px in the other, three overview lanes against one,
 * a minimap rule here and not there. One base keeps the chrome identical
 * wherever code is shown; each editor adds only what is genuinely its own.
 */
import type { editor } from 'monaco-editor';
import { settings } from '$frontend/stores/features/settings.svelte';

/** Fraction of the app font size code is drawn at, unless a surface says otherwise. */
export const DEFAULT_FONT_SCALE = 0.9;

/** Code size and row height for a font scale, rounded the way Monaco is given them. */
export function editorFontMetrics(fontScale = DEFAULT_FONT_SCALE): { fontSize: number; lineHeight: number } {
	return {
		fontSize: Math.round(settings.fontSize * fontScale),
		lineHeight: Math.round(settings.fontSize * fontScale * 1.5)
	};
}

/** Scrollbar, ruler and minimap — the frame around the code. */
export const EDITOR_CHROME = {
	minimap: { enabled: false },
	scrollBeyondLastLine: false,
	// One lane: the change marks fill it, and nothing else competes for it.
	overviewRulerLanes: 1,
	overviewRulerBorder: false,
	hideCursorInOverviewRuler: true,
	scrollbar: {
		verticalScrollbarSize: 8,
		horizontalScrollbarSize: 8
	}
} satisfies editor.IEditorOptions;
