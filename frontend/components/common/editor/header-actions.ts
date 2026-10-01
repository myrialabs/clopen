/**
 * What an editor header offers, described as data.
 *
 * Every surface used to hand the header a pile of ready-made buttons, so the
 * header could not tell how many there were or which mattered, and on a narrow
 * panel they simply ran off the edge. A surface now lists its actions and how
 * much each one matters; the header keeps the ones that fit and moves the rest
 * into a "⋯" menu, the same way on every surface.
 */
import type { IconName } from '$shared/types/ui/icons';
import { isMac } from '$frontend/utils/platform';

/** How a header button is coloured. */
export type HeaderTone = 'default' | 'success' | 'warning' | 'sky' | 'primary';

/** One row of a menu the action opens (a gutter mode, a view mode…). */
export type HeaderChoice =
	| { kind: 'separator' }
	| { kind: 'heading'; label: string }
	/** A quieter title inside a group, e.g. "This chat" under "Show changes from". */
	| { kind: 'subheading'; label: string }
	| {
			kind?: 'item';
			label: string;
			/** Muted text before the label, e.g. "Turn 3". */
			prefix?: string;
			checked?: boolean;
			dim?: boolean;
			title?: string;
			onSelect: () => void;
	  };

export interface HeaderAction {
	id: string;
	/** Tooltip, accessible name and the row's text in the "⋯" menu. */
	label: string;
	icon: IconName;
	onclick?: () => void;
	/** Opens a link instead of calling `onclick`. */
	href?: string;
	/** A toggle that is switched on. */
	active?: boolean;
	disabled?: boolean;
	busy?: boolean;
	tone?: HeaderTone;
	/** Opens a menu of these instead of acting by itself. */
	choices?: HeaderChoice[];
	/** Higher stays on the bar longer when room runs out. Default 0. */
	priority?: number;
}

/** Width one icon button takes, gap included — every header action is an icon. */
export const ACTION_SLOT = 36;

/** An action that opens a menu carries a small chevron beside its icon. */
const CHOICES_SLOT = 44;

export function actionWidth(action: HeaderAction): number {
	return action.choices ? CHOICES_SLOT : ACTION_SLOT;
}

/**
 * Which actions fit in `width` pixels. When they all do, nothing is hidden;
 * otherwise one slot is kept for the "⋯" button and the most important actions
 * (the earlier one among equals) take what is left. Both lists keep the
 * surface's order.
 */
export function splitActions(
	actions: HeaderAction[],
	width: number
): { visible: HeaderAction[]; overflow: HeaderAction[] } {
	const total = actions.reduce((sum, action) => sum + actionWidth(action), 0);
	if (total <= width) return { visible: actions, overflow: [] };

	let budget = width - ACTION_SLOT;
	const keep = new Set<HeaderAction>();
	const byImportance = actions
		.map((action, index) => ({ action, index }))
		.sort((a, b) => (b.action.priority ?? 0) - (a.action.priority ?? 0) || a.index - b.index);
	for (const { action } of byImportance) {
		const need = actionWidth(action);
		if (need > budget) continue;
		keep.add(action);
		budget -= need;
	}
	return {
		visible: actions.filter((action) => keep.has(action)),
		overflow: actions.filter((action) => !keep.has(action))
	};
}

/** Save, the same look, states and hint on every surface. */
export function saveAction(options: {
	dirty: boolean;
	saving: boolean;
	onSave: () => void;
	priority?: number;
}): HeaderAction {
	return {
		id: 'save',
		label: options.saving ? 'Saving…' : options.dirty ? `Save (${isMac() ? '⌘S' : 'Ctrl+S'})` : 'No changes to save',
		icon: 'lucide:save',
		tone: 'success',
		busy: options.saving,
		disabled: !options.dirty || options.saving,
		onclick: options.onSave,
		priority: options.priority ?? 100
	};
}

/** Side by side or inline — the icon shows the layout on screen, the label the other one. */
export function layoutAction(options: { sideBySide: boolean; onToggle: () => void; priority?: number }): HeaderAction {
	return {
		id: 'layout',
		label: options.sideBySide ? 'Switch to inline' : 'Switch to side by side',
		icon: options.sideBySide ? 'lucide:columns-2' : 'lucide:rows-2',
		onclick: options.onToggle,
		priority: options.priority ?? 5
	};
}
