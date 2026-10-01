/**
 * Changes in an editor — one model for every surface that shows them.
 *
 * The Files editor (a gutter over one buffer) and the diff editors (two panes)
 * used to count, colour and step through changes each their own way, so the
 * same file could read "1 of 3" in one place and "3 changes" in another. Both
 * now reduce their changes to spans on the editor's own lines and hand them to
 * the pieces here: one colour per kind, one scrollbar mark, one navigator.
 */
import type { editor } from 'monaco-editor';

export type ChangeType = 'added' | 'modified' | 'deleted';

/**
 * One change, as lines of the editor it is navigated in. A deletion has no
 * lines of its own, so it sits on the line it left behind (`start === end`).
 */
export interface ChangeSpan {
	type: ChangeType;
	start: number;
	end: number;
}

/** Where the reader is, and what the surface can do from there. */
export interface ChangeState {
	count: number;
	/** -1 only when there are no changes. */
	index: number;
	/** The current change can be discarded here. */
	canDiscard: boolean;
	canUndo: boolean;
	canRedo: boolean;
}

export const NO_CHANGES: ChangeState = { count: 0, index: -1, canDiscard: false, canUndo: false, canRedo: false };

/** What a header can ask the surface to do. Omitted actions are not offered. */
export interface ChangeControls {
	previous: () => void;
	next: () => void;
	discard?: () => void;
	undo?: () => void;
	redo?: () => void;
}

/** One hue per kind of change, for gutter and scrollbar marks alike. */
export function changeTypeColor(type: ChangeType, isDark: boolean): string {
	if (isDark) {
		return type === 'added' ? '#047857' : type === 'modified' ? '#2563eb' : '#b91c1c';
	}
	return type === 'added' ? '#10b981' : type === 'modified' ? '#3b82f6' : '#ef4444';
}

/** `monaco.editor.OverviewRulerLane.Full`, without loading Monaco to read it. */
const OVERVIEW_RULER_FULL = 7;

/** The scrollbar mark of a change; merged into a surface's own decoration. */
export function changeOverviewRuler(type: ChangeType, isDark: boolean): editor.IModelDecorationOverviewRulerOptions {
	return { color: changeTypeColor(type, isDark), position: OVERVIEW_RULER_FULL };
}

/** Scrollbar marks alone, for a surface with no gutter of its own. */
export function changeMarkerDecorations(spans: ChangeSpan[], isDark: boolean): editor.IModelDeltaDecoration[] {
	return spans.map((span) => ({
		range: { startLineNumber: span.start, startColumn: 1, endLineNumber: span.end, endColumn: 1 },
		options: { overviewRuler: changeOverviewRuler(span.type, isDark) }
	}));
}

interface UndoableModel {
	canUndo?: () => boolean;
	canRedo?: () => boolean;
}

/**
 * Whether the editor's buffer has anything to undo or redo. Monaco's text
 * model answers this, but outside its typed surface; a build without it
 * reports both as available rather than locking the buttons.
 */
export function editorHistory(target: editor.ICodeEditor | null | undefined): { canUndo: boolean; canRedo: boolean } {
	const model = target?.getModel() as UndoableModel | null | undefined;
	if (!model) return { canUndo: false, canRedo: false };
	return { canUndo: model.canUndo?.() ?? true, canRedo: model.canRedo?.() ?? true };
}

export function undoIn(target: editor.ICodeEditor | null | undefined) {
	target?.trigger('clopen', 'undo', null);
}

export function redoIn(target: editor.ICodeEditor | null | undefined) {
	target?.trigger('clopen', 'redo', null);
}

interface NavigatorOptions {
	/** Something about the position changed. */
	onUpdate: () => void;
	/** A change was stepped to — the surface may open more of it. */
	onReveal?: (span: ChangeSpan, index: number) => void;
	/** While true, scrolling does not move the current change (an open peek). */
	isPinned?: () => boolean;
}

/**
 * The reader's place among an editor's changes.
 *
 * There is always a current change when there are any, so the header can say
 * "1 / 3" from the start. It follows the reader: clicking into a change, or
 * scrolling one into view, makes it the current one. Stepping from a change
 * the reader has not been taken to yet goes to it first rather than past it.
 */
export class ChangeNavigator {
	private spans: ChangeSpan[] = [];
	private current = -1;
	/** The reader is at the current change, not merely past it in the list. */
	private arrived = false;
	private disposables: Array<{ dispose(): void }> = [];

	constructor(
		private readonly target: editor.ICodeEditor,
		private readonly options: NavigatorOptions
	) {
		this.disposables.push(
			target.onDidChangeCursorPosition((event) => {
				if (event.source === 'api') return;
				this.followLine(event.position.lineNumber);
			}),
			target.onDidScrollChange((event) => {
				if (event.scrollTopChanged) this.followViewport();
			})
		);
	}

	get count(): number {
		return this.spans.length;
	}

	get index(): number {
		return this.current;
	}

	get span(): ChangeSpan | undefined {
		return this.current >= 0 ? this.spans[this.current] : undefined;
	}

	setChanges(spans: ChangeSpan[]) {
		this.spans = [...spans].sort((a, b) => a.start - b.start);
		if (this.spans.length === 0) {
			this.current = -1;
			this.arrived = false;
		} else if (this.current < 0) {
			this.current = 0;
			this.arrived = false;
		} else if (this.current >= this.spans.length) {
			this.current = this.spans.length - 1;
		}
		this.options.onUpdate();
	}

	/** Step to the next (1) or previous (-1) change, wrapping at either end. */
	step(direction: 1 | -1) {
		const count = this.spans.length;
		if (count === 0) return;
		const next = !this.arrived && this.current >= 0
			? this.current
			: (this.current + direction + count) % count;
		this.reveal(next);
	}

	reveal(index: number) {
		const span = this.spans[index];
		if (!span) return;
		this.current = index;
		this.arrived = true;
		this.target.setPosition({ lineNumber: span.start, column: 1 });
		this.target.revealLineInCenterIfOutsideViewport(span.start);
		this.options.onReveal?.(span, index);
		this.options.onUpdate();
	}

	/** Make a change current without moving the editor — it was opened some other way. */
	select(index: number) {
		if (!this.spans[index] || (index === this.current && this.arrived)) return;
		this.current = index;
		this.arrived = true;
		this.options.onUpdate();
	}

	dispose() {
		for (const disposable of this.disposables) disposable.dispose();
		this.disposables = [];
	}

	private followLine(line: number) {
		let found = -1;
		for (let i = 0; i < this.spans.length; i++) {
			if (this.spans[i].start <= line) found = i;
			else break;
		}
		if (found < 0) return;
		const span = this.spans[found];
		const inside = line >= span.start && line <= span.end;
		if (found === this.current && inside === this.arrived) return;
		this.current = found;
		this.arrived = inside;
		this.options.onUpdate();
	}

	private followViewport() {
		if (this.spans.length === 0 || this.options.isPinned?.()) return;
		const visible = this.target.getVisibleRanges();
		const isVisible = (span: ChangeSpan) =>
			visible.some((range) => span.start <= range.endLineNumber && span.end >= range.startLineNumber);
		const currentSpan = this.spans[this.current];
		if (currentSpan && isVisible(currentSpan)) return;
		const first = this.spans.findIndex(isVisible);
		if (first < 0) return;
		this.current = first;
		this.arrived = true;
		this.options.onUpdate();
	}
}
