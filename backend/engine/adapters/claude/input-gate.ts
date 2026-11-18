/**
 * When a Claude run's prompt input may close.
 *
 * The SDK closes the CLI's stdin once its prompt iterable ends and the first
 * `result` arrives. But the CLI keeps going after that `result` while
 * background work it started is still running: when a backgrounded command or
 * agent finishes, it starts a new turn on its own. Every request that turn
 * makes back to the host — in-process MCP tools (browser automation, memory),
 * `canUseTool`, hooks — travels over stdin, so with stdin closed each one
 * failed at once ("The tool call was interrupted before a result was
 * received"). Recorded with SDK 0.3.296: the in-process tool's handler never
 * ran in the notification turn.
 *
 * So Clopen holds the prompt iterable open and closes it only when the CLI has
 * nothing left to do:
 *
 * - With session-state events (`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`), the
 *   CLI reports `idle` after every turn — including while background work is
 *   still running, which is exactly why `idle` alone was not enough. Close on
 *   `idle` when the background task list is empty.
 * - Without them (an older CLI), close on a `result` when the background task
 *   list is empty.
 *
 * The background list is the authoritative `background_tasks_changed` list.
 * `task_started` / `task_notification` are not used: foreground commands emit
 * them too (`is_backgrounded: false`), and their notification comes inside the
 * same turn.
 */

export interface InputGateMessage {
	type: string;
	subtype?: string;
	state?: string;
	tasks?: unknown[];
}

export class ClaudeInputGate {
	private backgroundTasks = 0;
	private sawSessionState = false;
	private closed = false;

	constructor(private readonly close: () => void) {}

	/** Feed every SDK message, in order. */
	observe(message: InputGateMessage): void {
		if (this.closed) return;

		if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
			this.backgroundTasks = Array.isArray(message.tasks) ? message.tasks.length : 0;
			return;
		}

		if (message.type === 'system' && message.subtype === 'session_state_changed') {
			this.sawSessionState = true;
			if (message.state === 'idle' && this.backgroundTasks === 0) this.shut();
			return;
		}

		if (message.type === 'result' && !this.sawSessionState && this.backgroundTasks === 0) {
			this.shut();
		}
	}

	/** Close regardless — the run was cancelled or the stream ended. */
	shut(): void {
		if (this.closed) return;
		this.closed = true;
		this.close();
	}

	get isClosed(): boolean {
		return this.closed;
	}
}
