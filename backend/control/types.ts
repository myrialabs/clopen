/**
 * The control catalog's contract.
 *
 * An ACTION is one thing a user can make Clopen do from outside the web UI —
 * open a project, switch a model, run a skill. It is declared once,
 * here, and every remote surface is generated from it: a chat app's commands,
 * buttons and help today, an MCP server's tool schema tomorrow. A surface
 * never implements an operation; it renders an action's result.
 *
 * Actions are deliberately surface-neutral. They take explicit arguments
 * (validated against a TypeBox schema, which is also what an MCP client will
 * be shown), act as one user against one target, and return a result made of
 * Markdown, follow-up choices and an optional new target — things a chat
 * renders as text and buttons and an agent reads as data.
 */

import type { Static, TSchema } from 'elysia';
import type { AuthUser } from '$backend/auth/auth-service';

/** Where an action acts: a project (Home when none was picked) and maybe a session. */
export interface ControlTarget {
	projectId: string;
	sessionId: string | null;
}

export interface ControlContext {
	user: AuthUser;
	target: ControlTarget;
	/**
	 * Run a WebSocket route as this user — the SAME route, auth gate and
	 * validation the web UI goes through. The project defaults to the target's.
	 */
	call<T = unknown>(action: string, data?: Record<string, unknown>, options?: { projectId?: string }): Promise<T>;
}

/** A follow-up the user can pick: a button in a chat, an option for an agent. */
export interface ControlChoice {
	label: string;
	/** A second line of context — a path, a provider, a state. */
	detail?: string;
	current?: boolean;
	action: string;
	args?: Record<string, unknown>;
}

/** A file an action hands back — sent as a file in a chat, a path to an agent. */
export interface ControlFile {
	/** Absolute path on the Clopen machine. */
	path: string;
	filename: string;
	mime: string;
}

export interface ControlResult {
	/** Markdown. */
	text: string;
	/** Files to deliver with the text. */
	files?: ControlFile[];
	/**
	 * A message to send to the target session as the user, after the text: an
	 * action that STARTS a turn (running a skill) says what to send, and the
	 * surface sends it the way it sends anything the user types.
	 */
	prompt?: string;
	/**
	 * The action needs words from the user (a folder name): what to ask, and
	 * which action gets them, as argument `key` next to `args`. A chat takes
	 * the next message (or a reply) as the answer; an agent passes it directly.
	 */
	ask?: { question: string; action: string; args?: Record<string, unknown>; key: string };
	choices?: ControlChoice[];
	/** Where the conversation is after this action, when it moved. */
	target?: ControlTarget;
	/** A link worth opening — rendered as a button in a chat. */
	link?: { label: string; url: string };
}

export type ControlGroup = 'conversation' | 'sessions' | 'files' | 'skills' | 'projects' | 'models' | 'accounts';

export const CONTROL_GROUP_LABELS: Record<ControlGroup, string> = {
	conversation: 'Conversation',
	sessions: 'Sessions',
	files: 'Files',
	skills: 'Skills',
	projects: 'Projects',
	models: 'Models',
	accounts: 'Engine accounts'
};

export interface ControlCommand {
	/**
	 * `[a-z0-9_]`, 1-32 characters — the strictest platform's rule (Telegram).
	 * One name per action, no aliases: a surface lists every command it
	 * accepts, so a hidden second name would be a command nobody can find.
	 */
	name: string;
	/**
	 * What free text after the command fills. A single key receives the whole
	 * text; `split` keys receive whitespace-separated words, the last one
	 * taking the rest.
	 */
	argument?: { keys: string[]; hint: string };
}

export interface ControlAction<A extends TSchema = TSchema> {
	/** `group.verb` — stable, used in button data and by future MCP clients. */
	id: string;
	group: ControlGroup;
	title: string;
	/** One line, shown in help and to an agent. */
	description: string;
	/**
	 * Who may run it. The routes an action calls enforce their own rules too
	 * (the same `auth/permissions.ts` the web UI is held to); this is what keeps
	 * an admin-only action out of a member's menus in the first place.
	 */
	access: 'member' | 'admin';
	args: A;
	command?: ControlCommand;
	/** A question to ask before running, for anything destructive. Null: just run it. */
	confirm?: (args: Static<A>, ctx: ControlContext) => string | null | Promise<string | null>;
	run(ctx: ControlContext, args: Static<A>): Promise<ControlResult>;
}
