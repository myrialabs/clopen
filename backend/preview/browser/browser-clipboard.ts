/**
 * Workspace clipboard.
 *
 * One clipboard per workspace, shared by its tabs, its agent and the user's
 * devices — the single source of truth for "what was copied last".
 *
 * There used to be three clipboards that never met: the headless browser's own
 * (which a page's `execCommand('copy')` filled and nobody could read), the
 * viewer's device (where `navigator.clipboard.writeText` was relayed, and which
 * an agent cannot see), and none at all for the agent. So an agent clicking a
 * page's "Copy" button and pasting the result elsewhere got nothing, and a
 * paste chord pasted from the empty headless clipboard.
 *
 * Every copy now lands here — from a page (copy event, `writeText`), from the
 * agent, from the context menu, or from the user's device — and every paste
 * reads from here. Anything not copied *by the device* is pushed back down to
 * the user's devices, which is what keeps the two in step.
 */

import { EventEmitter } from 'events';

export type ClipboardSource = 'page' | 'agent' | 'menu' | 'device';

export interface ClipboardChange {
	text: string;
	source: ClipboardSource;
	timestamp: number;
}

/** Above this, a copy is kept but no longer mirrored over the socket. */
const MAX_SYNCED_CHARS = 1_000_000;

export class WorkspaceClipboard extends EventEmitter {
	private text = '';
	private source: ClipboardSource | null = null;
	private updatedAt = 0;

	read(): string {
		return this.text;
	}

	/** Who wrote the current content and when — for the stats panel. */
	describe(): { length: number; source: ClipboardSource | null; updatedAt: number } {
		return { length: this.text.length, source: this.source, updatedAt: this.updatedAt };
	}

	/**
	 * Replace the content. Emits `changed` when the text actually differs, so a
	 * device echoing back what it was just sent does not ping-pong.
	 */
	write(text: string, source: ClipboardSource): void {
		const value = String(text ?? '');
		if (value === this.text) {
			this.source = source;
			this.updatedAt = Date.now();
			return;
		}

		this.text = value;
		this.source = source;
		this.updatedAt = Date.now();

		if (source !== 'device' && value.length <= MAX_SYNCED_CHARS) {
			this.emit('changed', { text: value, source, timestamp: this.updatedAt } satisfies ClipboardChange);
		}
	}
}
