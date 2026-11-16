/**
 * Agent actions — the control surface an AI agent drives through the Clopen
 * MCP server.
 *
 * They share the catalog's contract (`ControlAction`: validated arguments, a
 * result with text and data), and add two things a chat command does not need:
 *
 * - `risk`: what undoing it would take (see `risk.ts`). Irreversible actions
 *   wait for the owner's approval in the Inbox unless the owner allowed them.
 * - `scope`: who may run it. `assistant` actions — missions, jobs, scripts,
 *   skills, the raw API — belong to Clopen's own chat. `any` actions are also
 *   offered to agents working in a project session (databases, scripts to run,
 *   asking the owner), so a project agent can use what Clopen knows without
 *   being able to steer Clopen itself.
 */

import type { Static, TSchema } from 'elysia';
import type { ControlRisk } from '$shared/types/assistant';
import type { ControlAction } from '../types';

export type AgentScope = 'assistant' | 'any';

export interface AgentAction<A extends TSchema = TSchema> extends ControlAction<A> {
	risk: ControlRisk | ((args: Static<A>) => ControlRisk);
	scope: AgentScope;
	/** Example arguments shown in the tool description — and in the error when arguments do not fit. */
	example?: Record<string, unknown>;
	/**
	 * Refuse arguments that can never succeed, BEFORE an approval is asked for.
	 * An approval the owner grants for something that is then refused anyway is
	 * the worst outcome (it happened with blocked API routes).
	 */
	validate?: (args: Static<A>) => void;
}

const ID = /^[a-z]+\.[a-z][a-z-]*$/;

export function defineAgentAction<A extends TSchema>(action: AgentAction<A>): AgentAction<A> {
	if (!ID.test(action.id)) throw new Error(`Agent action id "${action.id}" must look like group.verb`);
	if (action.command) throw new Error(`Agent action "${action.id}" must not declare a chat command`);
	return action;
}

export function riskOf(action: AgentAction, args: Record<string, unknown>): ControlRisk {
	return typeof action.risk === 'function' ? action.risk(args as never) : action.risk;
}
