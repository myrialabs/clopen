/**
 * The agent control surface — what the Clopen MCP server exposes.
 *
 * One batch runner over one registry. An agent sends a list of steps; each
 * step names an action and its arguments, and may name its result (`as`) so a
 * later step can use it: `"$task.taskId"` is the `taskId` in the data
 * of the step named `task`, `"$0.projectId"` reads step 0. A whole-string
 * reference keeps the value's type; a reference inside text is interpolated.
 *
 * Every step is checked in the same order:
 *   1. it exists, and the caller may run it (Clopen's own chat runs anything;
 *      an agent in a project session runs only `any`-scoped actions);
 *   2. its arguments fit the schema;
 *   3. its risk — an irreversible step waits for the owner's approval in the
 *      Inbox unless they allowed irreversible actions, and the batch stops
 *      there, because later steps may depend on it;
 *   4. it runs, and the outcome is written to the audit trail.
 *
 * When the owner settles an approval, the action runs (or not) and the agent
 * that asked is told the outcome in its own session.
 */

import { Value } from '@sinclair/typebox/value';
import { maskSecrets } from '$backend/assistant/scrub';
import { getOwner, type AuthUser } from '$backend/auth/auth-service';
import { controlAuditQueries, projectQueries, sessionQueries } from '$backend/database/queries';
import { isAssistantProject } from '$shared/utils/assistant-project';
import { ensureAssistantProject } from '$backend/assistant/project';
import { getAssistantSettings } from '$backend/assistant/settings';
import { raiseInboxItem, resolveInboxItem } from '$backend/assistant/inbox';
import { sendPromptAsOwner } from '$backend/assistant/prompt';
import { inboxQueries } from '$backend/database/queries';
import { toInboxItem } from '$backend/assistant/mappers';
import type { ControlRisk } from '$shared/types/assistant';
import { debug } from '$shared/utils/logger';
import { callRouteAs } from '../invoke';
import type { ControlContext } from '../types';
import { riskOf, type AgentAction } from './define';
import { TASK_ACTIONS } from './actions/tasks';
import { WORKSPACE_ACTIONS } from './actions/workspace';
import { LIBRARY_ACTIONS } from './actions/library';
import { SYSTEM_ACTIONS } from './actions/system';
import { MEMORY_ACTIONS } from './actions/memory';
import { FLOW_ACTIONS } from './actions/flows';

export const AGENT_ACTIONS: readonly AgentAction[] = [
	...TASK_ACTIONS,
	...FLOW_ACTIONS,
	...MEMORY_ACTIONS,
	...WORKSPACE_ACTIONS,
	...LIBRARY_ACTIONS,
	...SYSTEM_ACTIONS
] as unknown as AgentAction[];

const byId = new Map(AGENT_ACTIONS.map((action) => [action.id, action]));
if (byId.size !== AGENT_ACTIONS.length) throw new Error('Agent action ids must be unique');

export function getAgentAction(id: string): AgentAction | null {
	return byId.get(id) ?? null;
}

export interface AgentCaller {
	/** The chat session the call came from, when known. */
	sessionId: string | null;
	/** The project that session belongs to. */
	projectId: string | null;
}

export interface AgentStep {
	action: string;
	args?: Record<string, unknown>;
	/** Name this step's result for later `$name.path` references. */
	as?: string;
	/** A failure here does not stop the batch. */
	optional?: boolean;
}

export type StepStatus = 'ok' | 'error' | 'pending' | 'skipped';

export interface StepReport {
	index: number;
	action: string;
	status: StepStatus;
	risk: ControlRisk | null;
	text: string;
	data?: unknown;
}

interface ResolvedCaller {
	user: AuthUser;
	projectId: string;
	sessionId: string | null;
	isAssistant: boolean;
	actor: string;
}

function resolveCaller(caller: AgentCaller): ResolvedCaller {
	const user = getOwner();
	if (!user) throw new Error('Clopen has no owner yet.');
	const session = caller.sessionId ? sessionQueries.getById(caller.sessionId) : null;
	const project = projectQueries.getById(session?.project_id ?? caller.projectId ?? '') ?? ensureAssistantProject();
	const isAssistant = isAssistantProject(project);
	return { user, projectId: project.id, sessionId: session?.id ?? null, isAssistant, actor: isAssistant ? 'assistant' : 'agent' };
}

function contextFor(caller: ResolvedCaller): ControlContext {
	return {
		user: caller.user,
		target: { projectId: caller.projectId, sessionId: caller.sessionId },
		call: (route, data, options) => callRouteAs(caller.user, route, data ?? {}, options?.projectId ?? caller.projectId)
	};
}

// ── References between steps ───────────────────────────────────────────────

const WHOLE_REF = /^\$([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+)*)$/;
const INLINE_REF = /\$([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+)+)/g;

function lookup(results: Map<string, unknown>, name: string, path: string): unknown {
	if (!results.has(name)) throw new Error(`"$${name}" refers to a step that has not run (name it with "as", or use its index).`);
	let value = results.get(name);
	for (const key of path.split('.').filter(Boolean)) {
		if (value === null || typeof value !== 'object') throw new Error(`"$${name}${path}" does not exist in that step's result.`);
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

export function resolveRefs(value: unknown, results: Map<string, unknown>): unknown {
	if (typeof value === 'string') {
		const whole = WHOLE_REF.exec(value);
		if (whole) return lookup(results, whole[1], whole[2]);
		return value.replace(INLINE_REF, (_match, name: string, path: string) => String(lookup(results, name, path)));
	}
	if (Array.isArray(value)) return value.map((item) => resolveRefs(item, results));
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveRefs(item, results)]));
	}
	return value;
}

/** Names models reach for instead of the one an action declares — `content` for `body`, `prompt` for `goal`. */
const ALIASES: Record<string, string[]> = {
	body: ['content', 'text', 'instructions'],
	goal: ['prompt', 'task', 'request'],
	text: ['message', 'content'],
	name: ['title'],
	query: ['q', 'search']
};

/** Rename aliases to the declared names when the declared one is missing — never overriding what was given. */
function withAliases(action: AgentAction, args: Record<string, unknown>): Record<string, unknown> {
	const declared = (action.args as { properties?: Record<string, unknown> }).properties ?? {};
	const out = { ...args };
	for (const [name, aliases] of Object.entries(ALIASES)) {
		if (!(name in declared) || out[name] !== undefined) continue;
		const alias = aliases.find((key) => !(key in declared) && out[key] !== undefined);
		if (!alias) continue;
		out[name] = out[alias];
		delete out[alias];
	}
	return out;
}

function checkArgs(action: AgentAction, input: Record<string, unknown>): Record<string, unknown> {
	const args = withAliases(action, input);
	try {
		return Value.Decode(action.args, Value.Convert(action.args, Value.Default(action.args, args))) as Record<string, unknown>;
	} catch {
		const errors = [...Value.Errors(action.args, args)].slice(0, 3).map((error) => `${error.path || '(root)'} ${error.message}`);
		// Show the right shape, not just what is wrong: a model fixes a call from an example in one try.
		const example = action.example ? ` Example args: ${JSON.stringify(action.example)}` : '';
		throw new Error(`Arguments do not fit ${action.id}: ${errors.join('; ') || 'invalid'}.${example}`);
	}
}

/** Argument names whose values never reach the audit trail. */
const SECRET_ARG = /^(value|password|passphrase|token|secret|api[-_]?key|key)$/i;

function redact(args: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, SECRET_ARG.test(key) && typeof value === 'string' ? '••••' : value]));
}

function audit(caller: ResolvedCaller, action: string, args: Record<string, unknown>, risk: ControlRisk, outcome: 'ok' | 'error' | 'blocked' | 'pending', error?: string): void {
	try {
		controlAuditQueries.add({ actor: caller.actor, sessionId: caller.sessionId, projectId: caller.projectId, action, args: redact(args), risk, outcome, error: error ?? null });
	} catch (failure) {
		debug.warn('control', 'Writing the control audit failed:', failure);
	}
}

// ── Running ────────────────────────────────────────────────────────────────

function maskData(data: unknown): unknown {
	if (data === undefined || data === null) return data;
	const raw = JSON.stringify(data);
	const masked = maskSecrets(raw);
	return masked === raw ? data : JSON.parse(masked);
}

export async function runAgentBatch(callerInput: AgentCaller, steps: AgentStep[], onError: 'stop' | 'continue' = 'stop'): Promise<StepReport[]> {
	const caller = resolveCaller(callerInput);
	const ctx = contextFor(caller);
	const settings = getAssistantSettings();
	const results = new Map<string, unknown>();
	const reports: StepReport[] = [];
	let stopped = false;

	for (const [index, step] of steps.entries()) {
		if (stopped) {
			reports.push({ index, action: step.action, status: 'skipped', risk: null, text: 'Not run: an earlier step stopped the batch.' });
			continue;
		}
		const action = getAgentAction(step.action);
		let risk: ControlRisk | null = null;
		try {
			if (!action) throw new Error(`There is no action "${step.action}". The tool description lists them.`);
			if (action.scope === 'assistant' && !caller.isAssistant) {
				throw new Error(`${action.id} is only available in Clopen's own chat. From a project session you can use: ${AGENT_ACTIONS.filter((entry) => entry.scope === 'any').map((entry) => entry.id).join(', ')}.`);
			}
			const args = checkArgs(action, resolveRefs(step.args ?? {}, results) as Record<string, unknown>);
			action.validate?.(args as never);
			risk = riskOf(action, args);

			if (risk === 'irreversible' && !settings.allowIrreversible) {
				const item = raiseInboxItem({
					kind: 'approval',
					title: `${action.title}${typeof args.project === 'string' ? ` in ${args.project}` : ''}`,
					body: `An agent wants to run ${action.id}, which cannot be undone from Clopen:\n\n${JSON.stringify(args, null, 2).slice(0, 3000)}`,
					data: { action: action.id, args, caller: { sessionId: caller.sessionId, projectId: caller.projectId } },
					sessionId: caller.sessionId,
					projectId: caller.projectId
				});
				audit(caller, action.id, args, risk, 'pending');
				reports.push({
					index,
					action: action.id,
					status: 'pending',
					risk,
					text: `Waiting for the owner's approval (Inbox item ${item.id}). You will be told the outcome in this chat. Carry on with work that does not depend on it.`,
					data: { approvalId: item.id }
				});
				stopped = true;
				continue;
			}

			const result = await action.run(ctx, args as never);
			audit(caller, action.id, args, risk, 'ok');
			const data = result.data ?? null;
			results.set(String(index), data);
			if (step.as) results.set(step.as, data);
			// What the agent reads never holds a saved secret (a later step can still pass one on by reference).
			reports.push({ index, action: action.id, status: 'ok', risk, text: maskSecrets(result.text), data: maskData(result.data) });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (action) audit(caller, action.id, step.args ?? {}, risk ?? 'write', 'error', message);
			reports.push({ index, action: step.action, status: 'error', risk, text: maskSecrets(message) });
			if (!step.optional && onError === 'stop') stopped = true;
		}
	}
	return reports;
}

// ── Approvals ──────────────────────────────────────────────────────────────

/**
 * The owner approved or declined an irreversible action. Approved: it runs as
 * the agent that asked. Either way, that agent hears the outcome in its own
 * session, so it can carry on.
 */
export async function settleApproval(itemId: string, approved: boolean): Promise<{ ok: boolean; text: string }> {
	const row = inboxQueries.getById(itemId);
	if (!row || row.kind !== 'approval' || row.status !== 'open') throw new Error('That approval is no longer waiting.');
	const item = toInboxItem(row);
	const actionId = String(item.data.action ?? '');
	const args = (item.data.args ?? {}) as Record<string, unknown>;
	const callerData = (item.data.caller ?? {}) as AgentCaller;
	const action = getAgentAction(actionId);
	const caller = resolveCaller({ sessionId: callerData.sessionId ?? null, projectId: callerData.projectId ?? null });

	let outcome: string;
	let ok = false;
	if (!approved || !action) {
		outcome = approved ? `The action ${actionId} no longer exists.` : `The owner declined ${actionId}. Do not retry it; find another way, or ask the owner what they want instead.`;
		audit(caller, actionId, args, 'irreversible', 'blocked', approved ? 'unknown action' : 'declined by the owner');
	} else {
		try {
			const result = await action.run(contextFor(caller), args as never);
			audit(caller, actionId, args, 'irreversible', 'ok');
			outcome = `The owner approved ${actionId}. It ran:\n${result.text}`;
			ok = true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			audit(caller, actionId, args, 'irreversible', 'error', message);
			outcome = `The owner approved ${actionId}, but it failed: ${message}`;
		}
	}
	resolveInboxItem(itemId, 'resolved', { approved, ok });

	if (caller.sessionId) {
		const session = sessionQueries.getById(caller.sessionId);
		const project = session ? projectQueries.getById(session.project_id) : null;
		if (session && project) {
			try {
				await sendPromptAsOwner({ project, session, text: `[Clopen · approval] ${outcome}` });
			} catch (error) {
				debug.warn('control', 'Telling the agent about an approval failed:', error);
			}
		}
	}
	return { ok, text: outcome };
}

// ── Description ────────────────────────────────────────────────────────────

/** `{ a, b?, c? }` from a TypeBox object schema — enough for the tool description. */
function argKeys(action: AgentAction): string {
	const schema = action.args as { properties?: Record<string, unknown>; required?: string[] };
	const required = new Set(schema.required ?? []);
	const keys = Object.keys(schema.properties ?? {}).map((key) => (required.has(key) ? key : `${key}?`));
	return keys.length ? `{ ${keys.join(', ')} }` : '{}';
}

export function describeAgentActions(): Array<{ id: string; group: string; description: string; args: string; risk: string; scope: string }> {
	return AGENT_ACTIONS.map((action) => ({
		id: action.id,
		group: action.group,
		description: action.description,
		args: argKeys(action),
		risk: typeof action.risk === 'function' ? 'depends on arguments' : action.risk,
		scope: action.scope
	}));
}
