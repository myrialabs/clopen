/**
 * `defineAction()` in its own module, so an action file can import it without
 * importing the registry that imports the action file.
 */

import type { TSchema } from 'elysia';
import type { ControlAction } from './types';

const ID = /^[a-z]+\.[a-z][a-z-]*$/;
const COMMAND = /^[a-z0-9_]{1,32}$/;

/** Validate a declaration at import — a malformed one is a bug, not a runtime condition. */
export function defineAction<A extends TSchema>(action: ControlAction<A>): ControlAction<A> {
	if (!ID.test(action.id)) throw new Error(`Control action id "${action.id}" must look like group.verb`);
	// `chat.*` buttons belong to the chat app itself (approvals); a catalog action by that name would never run.
	if (action.id.startsWith('chat.')) throw new Error(`Control action id "${action.id}" may not start with chat.`);
	const name = action.command?.name;
	if (name !== undefined && !COMMAND.test(name)) throw new Error(`Control command "${name}" must match ${COMMAND}`);
	return action;
}
