/**
 * Rebuild the task list the Task tools describe (TaskCreate / TaskUpdate,
 * Claude Agent SDK 0.3.142+, which replaced the now-default-off TodoWrite).
 *
 * TodoWrite sent a full snapshot per call, so reading it was "take the last
 * one". The Task tools are deltas instead — one task per TaskCreate, patched by
 * `taskId` — so the list has to be replayed. The subtlety that matters, and that
 * an earlier version of this replay got wrong, is **how far** a `taskId` is
 * meaningful:
 *
 * Clopen sends every turn with `forkSession: true`, so each turn runs under a
 * fresh SDK session whose task store starts empty and whose ids restart at 1.
 * A `taskId` is therefore scoped to the SDK session that minted it, exactly as
 * an SDK session id is only meaningful to the engine that minted it. Treating
 * the ids as conversation-global made turn 2's updates land on turn 1's rows:
 * turn 2's own tasks stayed pending forever, turn 1's flipped status under
 * someone else's plan, and the progress count could never reach 100%. The
 * engine says so itself — a TaskList in a later turn answers "No tasks found"
 * even though earlier turns created plenty.
 *
 * So the namespace is the SDK session, and a TaskCreate arriving under a new one
 * starts that session's list from scratch. Updates never open a namespace, only
 * creates do: a turn that patches without creating is a continuation (the case
 * if the engine ever starts persisting its store across a fork), and clearing on
 * it would throw away the list those patches refer to.
 */

import type {
	TodoItem,
	TaskCreateInput,
	TaskUpdateInput,
	TaskStatus,
} from '$shared/types/unified';

/** Shape this replay needs from a message — anything with content blocks. */
interface TaskReplayMessage {
	type: string;
	sessionId?: string | null;
	content?: unknown;
}

interface RawBlock {
	type?: string;
	name?: string;
	id?: string;
	toolUseId?: string;
	content?: unknown;
	input?: unknown;
}

/**
 * TaskCreate reports the id it was given in its result text, e.g.
 * `Task #4 created successfully: Run the migration`. That is the authoritative
 * id — the alternative, counting creates and assuming the engine agrees, is what
 * the fallback below does and only while the result is still in flight.
 */
const CREATED_TASK_ID = /^Task #(\d+)\b/;

function createdTaskId(result: string | undefined): string | null {
	const matched = result?.match(CREATED_TASK_ID);
	return matched ? matched[1] : null;
}

function blocksOf(message: TaskReplayMessage): RawBlock[] {
	return Array.isArray(message.content) ? (message.content as RawBlock[]) : [];
}

/**
 * Pair every tool_result to the tool call it answers.
 *
 * The widget reads the raw message list rather than the grouped one the chat
 * renders, and `ToolUseBlock.result` is populated by that grouper — so on this
 * side of the app a tool_use block never carries its own result and the ids have
 * to be collected from the synthetic user messages that deliver them.
 */
function collectToolResults(messages: TaskReplayMessage[]): Map<string, string> {
	const results = new Map<string, string>();
	for (const message of messages) {
		if (message.type !== 'user') continue;
		for (const block of blocksOf(message)) {
			if (block.type === 'tool_result' && block.toolUseId && typeof block.content === 'string') {
				results.set(block.toolUseId, block.content);
			}
		}
	}
	return results;
}

/**
 * Replay the Task tools into the current task list, or `null` when the
 * conversation used none — the caller falls back to TodoWrite for the engines
 * that still send it.
 */
export function replayTaskTools(messages: TaskReplayMessage[]): TodoItem[] | null {
	if (messages.length === 0) return null;

	const results = collectToolResults(messages);
	const tasks = new Map<string, TodoItem>();
	let order: string[] = [];
	let sawTaskTool = false;
	/** SDK session whose id namespace `tasks` currently holds. */
	let namespace: string | null | undefined;
	/** Creates seen in that namespace, so a pending result can be stood in for. */
	let created = 0;

	const upsert = (id: string, patch: Partial<TodoItem>) => {
		const existing = tasks.get(id);
		if (existing) {
			tasks.set(id, { ...existing, ...patch });
			return;
		}
		order.push(id);
		tasks.set(id, {
			content: patch.content ?? '',
			status: patch.status ?? 'pending',
			activeForm: patch.activeForm ?? patch.content ?? '',
		});
	};

	for (const message of messages) {
		if (message.type !== 'assistant') continue;

		for (const block of blocksOf(message)) {
			if (block.type !== 'tool_use') continue;

			if (block.name === 'TaskCreate') {
				sawTaskTool = true;
				// First create under a different SDK session: its ids start over at
				// 1, so anything held from the previous one would collide.
				if (message.sessionId !== namespace) {
					tasks.clear();
					order = [];
					created = 0;
					namespace = message.sessionId;
				}
				created += 1;
				const input = (block.input ?? {}) as TaskCreateInput;
				const id = createdTaskId(block.id ? results.get(block.id) : undefined)
					?? String(created);
				upsert(id, {
					content: input.subject,
					activeForm: input.activeForm || input.subject,
					status: 'pending',
				});
				continue;
			}

			if (block.name === 'TaskUpdate') {
				sawTaskTool = true;
				const input = (block.input ?? {}) as TaskUpdateInput;
				if (!input.taskId) continue;

				if (input.status === 'deleted') {
					if (tasks.delete(input.taskId)) {
						order = order.filter((id) => id !== input.taskId);
					}
					continue;
				}

				// An id with no create behind it can only be rendered when the
				// update names the task. Without a subject the row would enter the
				// list labelled by its own number, which is how "4" used to show up
				// as a task. Happens when the loaded message window opens partway
				// through a turn.
				if (!tasks.has(input.taskId) && !input.subject) continue;

				upsert(input.taskId, {
					...(input.subject ? { content: input.subject } : {}),
					...(input.activeForm ? { activeForm: input.activeForm } : {}),
					...(input.status ? { status: input.status as TaskStatus } : {}),
				});
			}
		}
	}

	if (!sawTaskTool) return null;
	return order.map((id) => tasks.get(id)!);
}
