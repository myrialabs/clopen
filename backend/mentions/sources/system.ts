/**
 * The machine around the project: which ports are listening (and who holds
 * them), and the project's environment files.
 *
 * A port is the usual question when a dev server will not start ("address
 * already in use") or a request goes nowhere. An environment file is attached
 * by its variable names; the values are masked — they are usually secrets,
 * and what the model needs is which ones exist — except in templates like
 * `.env.example`, which exist to be read.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type { MentionCandidate } from '$shared/types/mentions';
import type { PortEntry } from '$shared/types/ports';
import { LOCAL_PORT_HOST } from '$shared/types/ports';
import { buildContextDocument } from '$shared/utils/context-document';
import { portMonitor } from '$backend/ports/monitor';
import { listEnvFileEntries, parseDotenv } from '$backend/env-files';
import { ago, rank, within } from '../shared';
import { refOptional, refString, type MentionContext, type MentionSource } from '../types';

const PORTS = 'ports';
const ENV = 'env';

function portLabel(entry: PortEntry): string {
	return `:${entry.port}${entry.origin.label ? ` · ${entry.origin.label}` : ''}`;
}

function processLine(entry: PortEntry): string {
	return entry.process?.command ? entry.process.command.split(/\s+/).slice(0, 4).join(' ') : entry.pid ? `pid ${entry.pid}` : 'unknown process';
}

function describePort(entry: PortEntry): string[] {
	return [
		`Port ${entry.port}/${entry.protocol} on ${entry.addresses.join(', ') || '*'}`,
		`  Owner: ${entry.origin.label}${entry.origin.detail ? ` — ${entry.origin.detail}` : ''} (${entry.origin.kind}, ${entry.origin.confidence})`,
		`  Process: ${entry.process?.command ?? 'unknown'}${entry.pid ? ` (pid ${entry.pid})` : ''}`,
		...(entry.process?.cwd ? [`  Working directory: ${entry.process.cwd}`] : []),
		...(entry.process?.startedAt ? [`  Started: ${entry.process.startedAt} (${ago(entry.process.startedAt)})`] : []),
		...(entry.workerPids.length > 1 ? [`  Workers: ${entry.workerPids.join(', ')}`] : []),
		`  Connections: ${entry.peerCount}`,
		...(entry.publicUrl ? [`  Public URL: ${entry.publicUrl}`] : [])
	];
}

async function scanPorts(): Promise<PortEntry[]> {
	const scan = await within(portMonitor.scanOnce(LOCAL_PORT_HOST), 15_000, null);
	return [...(scan?.entries ?? [])].sort((a, b) => a.port - b.port);
}

/** `KEY=value` with the value masked, unless the file is a template. */
function maskedLine(key: string, value: string, template: boolean): string {
	if (template) return `${key}=${value}`;
	if (!value) return `${key}= (empty)`;
	return `${key}=•••• (set, ${value.length} chars)`;
}

export const systemSource: MentionSource = {
	kinds: ['port', 'env-file'],

	categories: () => [
		{ id: PORTS, label: 'Ports', detail: 'What is listening on this machine', icon: 'lucide:ethernet-port', group: 'Ops' },
		{ id: ENV, label: 'Environment files', detail: 'Variable names from .env files', icon: 'lucide:key-round', group: 'Workspace' }
	],

	async list(ctx: MentionContext, request) {
		if (request.category === PORTS) {
			const entries = await scanPorts();
			const all: MentionCandidate = {
				key: 'port:all', kind: 'port', group: 'Ports', label: 'All listening ports',
				detail: `${entries.length} ${entries.length === 1 ? 'port' : 'ports'} on this machine`, icon: 'lucide:ethernet-port', ref: { all: true }
			};
			const rows = entries.map((entry): MentionCandidate => ({
				key: `port:${entry.key}`, kind: 'port', group: 'Ports', label: portLabel(entry), detail: processLine(entry),
				icon: 'lucide:ethernet-port', ref: { port: entry.port }
			}));
			return [...(request.query.trim() ? [] : [all]), ...rank(rows, request.query, (row) => [row.label, row.detail, String(row.ref.port)], request.limit)];
		}
		if (request.category === ENV) {
			const files = await listEnvFileEntries(ctx.root);
			const rows = files.map((file): MentionCandidate => ({
				key: `env-file:${file.name}`, kind: 'env-file', group: 'Environment files', label: file.name,
				detail: file.isTemplate ? 'Template · values included' : 'Values masked', icon: 'lucide:key-round', ref: { name: file.name }
			}));
			return rank(rows, request.query, (row) => [row.label], request.limit);
		}
		// Typing ":3000" at the root finds what holds that port. The colon is
		// required: "@3" names an attachment, and scanning on it would be waste.
		const typed = /^:(\d{2,5})$/.exec(request.query.trim());
		if (!request.category && typed) {
			const entry = (await scanPorts()).find((candidate) => candidate.port === Number(typed[1]));
			if (entry) {
				return [{ key: `port:${entry.key}`, kind: 'port', group: 'Ports', label: portLabel(entry), detail: processLine(entry), icon: 'lucide:ethernet-port', ref: { port: entry.port } }];
			}
		}
		return [];
	},

	async capture(ctx, kind, ref) {
		if (kind === 'env-file') {
			const name = refString(ref, 'name');
			const entry = (await listEnvFileEntries(ctx.root)).find((file) => file.name === name);
			if (!entry) throw new Error(`${name} is not an environment file of this project`);
			const assignments = parseDotenv(await readFile(join(ctx.root, entry.name), 'utf8')).filter((assignment) => !assignment.commented);
			const body = assignments.map((assignment) => maskedLine(assignment.key, assignment.value, entry.isTemplate)).join('\n');
			return {
				documents: [buildContextDocument({
					kind, label: entry.name, detail: `${assignments.length} variables${entry.isTemplate ? '' : ', values masked'}`,
					facts: [['File', entry.name], ['Values', entry.isTemplate ? 'included (template)' : 'masked: they are usually secrets']],
					sections: [{ title: 'Variables', body: body || '(none)', fence: 'dotenv' }]
				})]
			};
		}

		const entries = await scanPorts();
		if (ref.all) {
			return {
				documents: [buildContextDocument({
					kind, label: 'All listening ports', detail: `${entries.length} ports`,
					sections: [{ title: 'Ports', body: entries.map((entry) => describePort(entry).join('\n')).join('\n\n') || 'Nothing is listening.', fence: 'text' }]
				})]
			};
		}
		const port = Number(ref.port ?? refOptional(ref, 'port'));
		const held = entries.filter((entry) => entry.port === port);
		if (held.length === 0) throw new Error(`Nothing is listening on port ${port} any more`);
		return {
			documents: [buildContextDocument({
				kind, label: `:${port}`, detail: held.map((entry) => entry.origin.label).join(', '),
				sections: [{ title: 'Listener', body: held.map((entry) => describePort(entry).join('\n')).join('\n\n'), fence: 'text' }]
			})]
		};
	}
};
