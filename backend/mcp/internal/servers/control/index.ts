/**
 * Control — internal MCP server that lets an agent drive Clopen itself.
 *
 * One tool, `run`, taking a batch of steps, following the Browser
 * and Memory servers: the whole surface is in one description
 * the agent reads once, and a plan (create a project, start a task, hand it
 * to a specialist) is a single call instead of a round trip per step.
 *
 * The actions, their risk and who may run them live in `backend/control/agent`
 * — this server is only the MCP shape around them. The caller is identified
 * from the stream that made the call, so Clopen's own chat gets the whole
 * surface and an agent in a project session gets the project-safe part.
 */

import { z } from 'zod';
import { defineServer } from '../helper';
import { projectContextService } from '../../project-context';
import { describeAgentActions, runAgentBatch, type StepReport } from '$backend/control/agent';
import { CONTROL_GROUP_LABELS, type ControlGroup } from '$backend/control/types';

const step = z.object({
	action: z.string().min(1).describe('Action id, e.g. "task.create". See the list in the tool description.'),
	args: z.record(z.string(), z.any()).optional().describe('Arguments for the action. Strings like "$name.field" or "$0.field" refer to earlier steps’ results.'),
	as: z.string().optional().describe('Name this step’s result so later steps can refer to it as "$<name>.<field>".'),
	optional: z.boolean().optional().describe('When true, a failure here does not stop the batch.')
});

const schema = {
	actions: z.array(step).min(1).max(40).describe('Steps to run, in order.'),
	onError: z.enum(['stop', 'continue']).optional().describe('What a failing step does to the rest of the batch. Default: stop.')
};

function buildDescription(): string {
	const actions = describeAgentActions();
	const groups = new Map<string, typeof actions>();
	for (const action of actions) {
		const list = groups.get(action.group) ?? [];
		list.push(action);
		groups.set(action.group, list);
	}
	const sections = [...groups.entries()].map(([group, list]) => {
		const label = CONTROL_GROUP_LABELS[group as ControlGroup] ?? group;
		const lines = list.map((action) => {
			const flags = [action.scope === 'any' ? 'any session' : null, action.risk === 'irreversible' ? 'needs approval' : null].filter(Boolean);
			return `- ${action.id} ${action.args}${flags.length ? ` [${flags.join(', ')}]` : ''}: ${action.description}`;
		});
		return `## ${label}\n${lines.join('\n')}`;
	});
	return [
		'Control Clopen itself: background tasks that drive specialist agents in projects, flows that run on their own, scripts, skills, secrets, memory of earlier chats, what needs the owner, project files, the shell, git, databases the owner opened to agents, and Clopen’s whole API.',
		'',
		'Send a batch of steps; each step is { action, args, as?, optional? }. Use "$name.field" (or "$0.field") in args to pass an earlier step’s result. Actions marked [needs approval] cannot be undone and wait for the owner’s approval unless they allowed them — the batch stops there and you are told the outcome later.',
		'Actions not marked [any session] are available only in Clopen’s own chat.',
		'',
		...sections
	].join('\n');
}

function formatReports(reports: StepReport[]): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
	const ok = reports.filter((report) => report.status === 'ok').length;
	const lines = [`Clopen — ${ok}/${reports.length} step(s) succeeded`];
	for (const report of reports) {
		const mark = report.status === 'ok' ? '✓' : report.status === 'pending' ? '⏸' : report.status === 'skipped' ? '·' : '✗';
		lines.push('', `[${report.index}] ${mark} ${report.action}${report.status === 'ok' ? '' : ` (${report.status})`}`);
		lines.push(report.text.split('\n').map((line) => `  ${line}`).join('\n'));
		if (report.status === 'ok' && report.data !== undefined && report.data !== null) {
			const data = JSON.stringify(report.data);
			if (data && data !== '{}' && data.length <= 4000) lines.push(`  data: ${data}`);
			else if (data && data.length > 4000) lines.push(`  data: (${data.length} chars; use the text above)`);
		}
	}
	return { content: [{ type: 'text', text: lines.join('\n') }], ...(ok === 0 && reports.length > 0 && !reports.some((report) => report.status === 'pending') ? { isError: true } : {}) };
}

/**
 * The intent tools — one per thing the owner asks for most. Flat arguments,
 * plain words, no nesting: usage showed small models failing on nested
 * schemas, not on the work. Each is one `run` step under the hood, so risk,
 * scope and the audit trail apply exactly as they do there.
 */
async function intent(action: string, args: Record<string, unknown>) {
	try {
		const reports = await runAgentBatch(
			{ sessionId: projectContextService.getCurrentChatSessionId(), projectId: projectContextService.getCurrentProjectId() },
			[{ action, args: Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined && value !== null && value !== '')) }],
			'stop'
		);
		const report = reports[0];
		const data = report?.status === 'ok' && report.data !== undefined ? `\n${JSON.stringify(report.data).slice(0, 3000)}` : '';
		return {
			content: [{ type: 'text' as const, text: `${report?.text ?? 'Nothing happened.'}${data}` }],
			...(report?.status === 'error' ? { isError: true } : {})
		};
	} catch (error) {
		return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
	}
}

const WHEN = 'In English: "every 5 minutes", "hourly", "every day at 07:00", "weekdays at 09:00", "every monday at 08:00", "in 10 minutes", "today at 15:48", "tomorrow at 07:00", or a cron like "0 7 * * *". Translate from the owner\'s language.';

const server = defineServer({
	name: 'control',
	title: 'Clopen Control',
	description:
		'Drive Clopen itself — delegate work to crews, flows that run on their own, reminders, connecting services, sending files and questions to the owner, and (through `run`) everything else.',
	version: '1.0.0',
	tools: {
		delegate: {
			description:
				'Hand project work — building or changing software or a website, writing a document or report, anything that makes or changes files — to agents in a project, in the background. They test their own work; you never verify it. Not for one-off actions you can do yourself (a screenshot, a lookup, a message, a reminder, a note in a connected service). Returns at once; the owner hears when it ends.',
			schema: {
				goal: z.string().min(1).describe('What the owner wants, in their own words.'),
				detail: z.string().optional().describe('Constraints, accounts, taste, deadlines — anything that matters.'),
				project: z.string().optional().describe('An existing project to work in; omit and a new one is made.'),
				continues: z.string().optional().describe('The id of the task this changes or continues ("make it 8-bit", "now 3D") — from the tasks in your brief. The change goes into that task, its project and its team, instead of a new task.')
			},
			handler: async (args) => intent('task.delegate', args)
		},
		automate: {
			description:
				'Make something happen on its own: on a schedule, when a page changes, or on an event. Give "what" in plain words, or a full "recipe" (numbered steps; see run → flow.create) for precise control. Say the schedule back to the owner.',
			schema: {
				name: z.string().min(1).describe('Short name.'),
				what: z.string().optional().describe('What to do each time, in plain words — used when there is no recipe.'),
				recipe: z.string().optional().describe('Optional exact steps, one per line: "1. HTTP GET <url> → $data", "2. Do: summarise $data → $summary", "3. Tell: $summary".'),
				when: z.string().optional().describe(WHEN),
				watch_url: z.string().optional().describe('Run when this web page changes.'),
				on_event: z.string().optional().describe('Run on a connected integration\'s event, e.g. "github:issues".'),
				project: z.string().optional(),
				delivery: z.enum(['always', 'changes', 'failures']).optional().describe('always · changes (default for watches) · failures')
			},
			handler: async (args) =>
				intent('flow.create', {
					name: args.name,
					recipe: args.recipe?.trim() ? args.recipe : `1. Do: ${args.what ?? args.name} → $result\n2. Tell: $result`,
					when: args.when,
					watchUrl: args.watch_url,
					onEvent: args.on_event,
					project: args.project,
					delivery: args.delivery
				})
		},
		remind: {
			description: 'Remind the owner — once, or on a schedule.',
			schema: { text: z.string().min(1).describe('The reminder, in the owner\'s language.'), when: z.string().min(1).describe(WHEN) },
			handler: async (args) => intent('owner.remind', args)
		},
		connect: {
			description:
				'Connect a service by name (Notion, Linear, GitHub, Gmail…). Clopen installs it and sends the owner exactly what is needed — a sign-in link or a key field. Never send the owner to Settings.',
			schema: { service: z.string().min(1) },
			handler: async (args) => intent('service.connect', args)
		},
		send: {
			description: 'Send the owner files (screenshots, images, documents — absolute paths) and/or a message, where they are (their chat app and Clopen). Your normal reply already reaches them; use this to deliver files.',
			schema: { text: z.string().optional(), files: z.array(z.string()).optional() },
			handler: async (args) => intent('owner.send', args)
		},
		ask: {
			description:
				'Ask the owner what only they can give: a password or key (set secret to a name; it is stored encrypted and never shown to you — read it with run → secret.get), a choice, or missing information. Never use it to hand them a task you could do.',
			schema: {
				question: z.string().min(1),
				options: z.array(z.string()).optional(),
				secret: z.string().optional().describe('Store the answer as this secret (e.g. "gmail-password").')
			},
			handler: async (args) => intent('owner.ask', args)
		},
		status: {
			description: 'What is going on: tasks under way, the next flows, and what is waiting for the owner.',
			schema: {},
			handler: async () => intent('clopen.status', {})
		},
		run: {
			// Filled in lazily below: the action list is read on first use, not at import.
			description: '',
			schema,
			handler: async (args) => {
				try {
					const reports = await runAgentBatch(
						{
							sessionId: projectContextService.getCurrentChatSessionId(),
							projectId: projectContextService.getCurrentProjectId()
						},
						args.actions as Array<{ action: string; args?: Record<string, unknown>; as?: string; optional?: boolean }>,
						args.onError ?? 'stop'
					);
					return formatReports(reports);
				} catch (error) {
					return {
						content: [{ type: 'text' as const, text: `Clopen call failed before starting: ${error instanceof Error ? error.message : 'Unknown error'}` }],
						isError: true
					};
				}
			}
		}
	}
});

/**
 * The description lists every agent action, so it is built on first read
 * rather than at import: this module loads early (with the MCP registry), and
 * the action catalog it describes pulls in half the backend.
 */
let description: string | null = null;
Object.defineProperty(server.meta.toolDefs.run, 'description', {
	get: () => (description ??= buildDescription()),
	enumerable: true,
	configurable: true
});

export default server;
