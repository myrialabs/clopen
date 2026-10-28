/**
 * The control catalog — the single source of truth for what Clopen can be
 * told to do from outside its web UI.
 *
 *   types.ts       the action / context / result contract
 *   define.ts      `defineAction()`, validated at import
 *   invoke.ts      running a WebSocket route as a user (the web UI's own rules)
 *   workspace.ts   shared answers: model for a new session, latest session, …
 *   links.ts       links back into the web UI
 *   actions/       the actions, one file per area
 *
 * Every remote surface is generated from `CONTROL_ACTIONS`: a chat app's
 * commands, `/` menu, buttons and help today; an MCP server's tool schema
 * (`describeControlActions()`) when one is built. Adding a capability to
 * remote control is adding an action here — never a handler in a surface.
 */

import { Value } from '@sinclair/typebox/value';
import type { AuthUser } from '$backend/auth/auth-service';
import { callRouteAs } from './invoke';
import { CONTROL_GROUP_LABELS, type ControlAction, type ControlContext, type ControlGroup, type ControlResult, type ControlTarget } from './types';
import { browseFolders, createProject, deleteFolder, goHome, listProjects, makeFolder, openProject, renameFolder } from './actions/projects';
import { deleteSession, dropQueued, listSessions, newSession, openSession, runningSessions, searchSessions, sessionStatus, showQueue, stopSession } from './actions/sessions';
import { listSkills, runSkill } from './actions/skills';
import { getFile, turnDiff } from './actions/files';
import { listEngines, listModels, listReasoning, setModel, setReasoning } from './actions/models';
import { listAccounts, switchAccount } from './actions/accounts';

export type { ControlAction, ControlChoice, ControlContext, ControlFile, ControlGroup, ControlResult, ControlTarget, ControlCommand } from './types';
export { CONTROL_GROUP_LABELS } from './types';
export { matchSkill, normaliseSkillName } from './actions/skills';
export { registerControlRouter, callRouteAs } from './invoke';
export { setPublicOriginResolver, sessionLink, publicOrigin } from './links';
export * from './workspace';

/** Every action, in the order help and every command menu list them. */
export const CONTROL_ACTIONS: readonly ControlAction[] = [
	sessionStatus,
	runningSessions,
	newSession,
	listSessions,
	searchSessions,
	openSession,
	stopSession,
	showQueue,
	dropQueued,
	deleteSession,
	turnDiff,
	getFile,
	listSkills,
	runSkill,
	listProjects,
	openProject,
	goHome,
	browseFolders,
	makeFolder,
	renameFolder,
	deleteFolder,
	createProject,
	listEngines,
	listModels,
	setModel,
	listReasoning,
	setReasoning,
	listAccounts,
	switchAccount
] as unknown as ControlAction[];

const byId = new Map(CONTROL_ACTIONS.map((action) => [action.id, action]));
const byCommand = new Map<string, ControlAction>();
for (const action of CONTROL_ACTIONS) {
	const name = action.command?.name;
	if (!name) continue;
	if (byCommand.has(name)) throw new Error(`Control command /${name} is declared twice`);
	byCommand.set(name, action);
}

export function getControlAction(id: string): ControlAction | null {
	return byId.get(id) ?? null;
}

export function controlActionForCommand(name: string): ControlAction | null {
	return byCommand.get(name) ?? null;
}

/** The command-bearing actions, in catalog order. */
function commandActions(): ControlAction[] {
	return CONTROL_ACTIONS.filter((action) => action.command);
}

/**
 * Free text after a command → the action's arguments. One key takes the whole
 * text; several keys take one word each, the last taking the rest.
 */
export function parseCommandArgument(action: ControlAction, text: string): Record<string, unknown> {
	const keys = action.command?.argument?.keys ?? [];
	const trimmed = text.trim();
	if (keys.length === 0 || !trimmed) return {};
	if (keys.length === 1) return { [keys[0]]: trimmed };
	const out: Record<string, unknown> = {};
	let rest = trimmed;
	for (const [index, key] of keys.entries()) {
		if (!rest) break;
		if (index === keys.length - 1) {
			out[key] = rest;
			break;
		}
		const match = /^(\S+)\s*([\s\S]*)$/.exec(rest);
		if (!match) break;
		out[key] = match[1];
		rest = match[2];
	}
	return out;
}

export function createControlContext(user: AuthUser, target: ControlTarget): ControlContext {
	return {
		user,
		target,
		call: (action, data, options) => callRouteAs(user, action, data ?? {}, options?.projectId ?? target.projectId)
	};
}

/** Validate arguments against the action's schema; a readable error when they do not fit. */
export function checkArgs(action: ControlAction, args: Record<string, unknown>): Record<string, unknown> {
	try {
		return Value.Decode(action.args, Value.Convert(action.args, args)) as Record<string, unknown>;
	} catch {
		const hint = action.command?.argument ? ` Usage: /${action.command.name} ${action.command.argument.hint}` : '';
		throw new Error(`That is not quite right for ${action.title}.${hint}`);
	}
}

/** The confirmation question an action wants asked first, if any. */
export async function confirmationFor(action: ControlAction, ctx: ControlContext, args: Record<string, unknown>): Promise<string | null> {
	return action.confirm ? await action.confirm(args as never, ctx) : null;
}

/** Run an action as `ctx.user`: validated arguments, then the action. */
export async function runControlAction(ctx: ControlContext, actionId: string, rawArgs: Record<string, unknown>): Promise<ControlResult> {
	const action = getControlAction(actionId);
	if (!action) throw new Error('That is no longer available.');
	const args = checkArgs(action, rawArgs);
	return action.run(ctx, args as never);
}

/** One line of a command reference — what help, a `/` menu and Settings all list. */
export interface CommandEntry {
	command: string;
	hint: string | null;
	description: string;
	group: string;
}

/**
 * Every command that can be typed, in one order: a surface's own commands
 * (`extra`) first, then the catalog's, grouped. Help, the command menu a
 * chat app publishes and the reference in Settings are all THIS list, so
 * they can never disagree about what exists.
 */
export function commandReference(
	extra: Array<{ command: string; description: string; hint?: string | null }> = []
): CommandEntry[] {
	const own = extra.map((entry) => ({
		command: entry.command,
		hint: entry.hint ?? null,
		description: entry.description,
		group: CONTROL_GROUP_LABELS.conversation
	}));
	const byGroup = new Map<ControlGroup, ControlAction[]>();
	for (const action of commandActions()) {
		const list = byGroup.get(action.group) ?? [];
		list.push(action);
		byGroup.set(action.group, list);
	}
	const catalog = [...byGroup.entries()].flatMap(([group, actions]) =>
		actions.map((action) => ({
			command: action.command!.name,
			hint: action.command!.argument?.hint ?? null,
			description: action.description,
			group: CONTROL_GROUP_LABELS[group]
		}))
	);
	return [...own, ...catalog];
}

/** Help as Markdown, grouped — `commandReference()` written out. */
export function controlHelp(extra: Array<{ command: string; description: string; hint?: string | null }> = []): string {
	const lines: string[] = [];
	let group: string | null = null;
	for (const entry of commandReference(extra)) {
		if (entry.group !== group) {
			if (group !== null) lines.push('');
			lines.push(`**${entry.group}**`);
			group = entry.group;
		}
		lines.push(`/${entry.command}${entry.hint ? ` ${entry.hint}` : ''}: ${entry.description}`);
	}
	return lines.join('\n');
}

/** The catalog as data — what an MCP server will publish as its tool schema. */
export function describeControlActions() {
	return CONTROL_ACTIONS.map((action) => ({
		id: action.id,
		group: action.group,
		title: action.title,
		description: action.description,
		destructive: Boolean(action.confirm),
		command: action.command?.name ?? null,
		args: action.args
	}));
}
