/**
 * Databases, agents, Clopen's settings and the raw API — the rest of what an
 * agent can reach.
 *
 * Databases follow the access the owner set per connection in DB Client:
 * `none` (the default — the agent does not even see the connection), `schema`
 * (structure only, never a row), `read`, or `write`. It is enforced here, by
 * classifying each statement the way the query console does, not by asking
 * the model to behave. Connection secrets never cross this boundary: an agent
 * sees ids, names and drivers.
 *
 * `api.call` reaches any WebSocket route the web UI uses, minus the blocklist
 * in `risk.ts`, with the same risk rules as the curated actions.
 */

import { t } from 'elysia';
import { dbAgentAccessQueries, dbClientConnectionQueries, controlAuditQueries } from '$backend/database/queries';
import { connectionManager } from '$backend/db-client/connection-manager';
import { classifyQuery } from '$backend/db-client/query-executor';
import { describeRoutes } from '../../invoke';
import { getAssistantSettings } from '$backend/assistant/settings';
import type { DbAgentAccess } from '$shared/types/assistant';
import type { DbClientSchemaNodeType } from '$shared/types/db-client';
import { isBlockedRoute, routeRisk } from '../risk';
import { defineAgentAction } from '../define';

const ACCESS_RANK: Record<DbAgentAccess, number> = { none: 0, schema: 1, read: 2, write: 3 };

function requireAccess(connectionId: string, needed: DbAgentAccess): { id: string; name: string; driver: string } {
	const connection = dbClientConnectionQueries.getRedacted(connectionId);
	const access = dbAgentAccessQueries.get(connectionId);
	if (!connection || access === 'none') throw new Error('There is no database connection with that id available to agents.');
	if (ACCESS_RANK[access] < ACCESS_RANK[needed]) {
		throw new Error(`The owner gave agents "${access}" access to ${connection.name}; this needs "${needed}". Ask the owner (inbox.ask) if you need more.`);
	}
	return { id: connection.id, name: connection.name, driver: connection.driver };
}

const MAX_ROWS = 200;

export const dbConnections = defineAgentAction({
	id: 'db.connections',
	group: 'db',
	title: 'Database connections',
	description: 'The DB Client connections the owner opened to agents, with the access each allows (schema, read or write).',
	args: t.Object({}),
	risk: 'read',
	scope: 'any',
	async run() {
		const access = dbAgentAccessQueries.all();
		const connections = dbClientConnectionQueries
			.listRedacted()
			.filter((connection) => (access[connection.id] ?? 'none') !== 'none')
			.map((connection) => ({ id: connection.id, name: connection.name, driver: connection.driver, database: connection.database, access: access[connection.id] }));
		return {
			text: connections.length
				? connections.map((connection) => `- ${connection.id} · ${connection.name} (${connection.driver}) · ${connection.access}`).join('\n')
				: 'No databases are open to agents. The owner can allow one in DB Client → connection → Agent access.',
			data: { connections }
		};
	}
});

export const dbSchema = defineAgentAction({
	id: 'db.schema',
	group: 'db',
	title: 'Database structure',
	description: 'Tables, views and collections of a connection (optionally of one database/schema).',
	args: t.Object({ connectionId: t.String({ minLength: 1 }), database: t.Optional(t.String()), schema: t.Optional(t.String()) }),
	risk: 'read',
	scope: 'any',
	async run(_ctx, args) {
		requireAccess(args.connectionId, 'schema');
		const adapter = await connectionManager.get(args.connectionId);
		if (!adapter.listObjects) throw new Error('This database does not list its objects.');
		const objects = await adapter.listObjects(args.database, args.schema);
		return { text: objects.map((node) => `${node.type} ${node.name}`).join('\n') || '(empty)', data: { objects: objects.map((node) => ({ name: node.name, type: node.type })) } };
	}
});

export const dbDescribe = defineAgentAction({
	id: 'db.describe',
	group: 'db',
	title: 'Describe a table',
	description: 'Columns, indexes and foreign keys of one table, view or collection.',
	args: t.Object({
		connectionId: t.String({ minLength: 1 }),
		name: t.String({ minLength: 1 }),
		type: t.Optional(t.String()),
		database: t.Optional(t.String()),
		schema: t.Optional(t.String())
	}),
	risk: 'read',
	scope: 'any',
	async run(_ctx, args) {
		requireAccess(args.connectionId, 'schema');
		const adapter = await connectionManager.get(args.connectionId);
		if (!adapter.getObjectDetails) throw new Error('This database does not describe its objects.');
		const details = await adapter.getObjectDetails(args.name, (args.type ?? 'table') as DbClientSchemaNodeType, args.database, args.schema);
		const columns = (details.columns ?? []).map((column) => `  ${column.name} ${column.type}${column.nullable ? '' : ' NOT NULL'}`).join('\n');
		return { text: `${details.type} ${details.name}\n${columns}${details.ddl ? `\n\n${details.ddl}` : ''}`, data: { columns: details.columns, indexes: details.indexes, foreignKeys: details.foreignKeys } };
	}
});

export const dbQuery = defineAgentAction({
	id: 'db.query',
	group: 'db',
	title: 'Run a query',
	description: `Run SQL (or the driver’s query language). Reading needs "read" access; anything that changes data or structure needs "write" and waits for the owner’s approval unless they allowed it. At most ${MAX_ROWS} rows come back.`,
	args: t.Object({ connectionId: t.String({ minLength: 1 }), query: t.String({ minLength: 1 }), database: t.Optional(t.String()) }),
	risk: (args) => {
		const connection = dbClientConnectionQueries.getRedacted(args.connectionId);
		return connection && classifyQuery(connection.driver, args.query) === 'read' ? 'read' : 'irreversible';
	},
	scope: 'any',
	async run(_ctx, args) {
		const connection = dbClientConnectionQueries.getRedacted(args.connectionId);
		if (!connection) throw new Error('There is no database connection with that id available to agents.');
		const kind = classifyQuery(connection.driver, args.query);
		requireAccess(args.connectionId, kind === 'read' ? 'read' : 'write');
		const adapter = await connectionManager.get(args.connectionId);
		const result =
			kind === 'read'
				? await adapter.executeRead!(args.query, [], { database: args.database, limit: MAX_ROWS })
				: await adapter.executeWrite!(args.query, [], { database: args.database });
		const rows = result.rows.slice(0, MAX_ROWS);
		const header = result.columns.map((column) => column.name).join(' | ');
		const body = rows.map((row) => result.columns.map((column) => String(row[column.name] ?? 'NULL').slice(0, 80)).join(' | ')).join('\n');
		return {
			text: `${kind} · ${result.rowCount} row(s)${result.affectedRows !== null ? ` · ${result.affectedRows} affected` : ''} · ${result.durationMs}ms\n${header}\n${body}`,
			data: { columns: result.columns, rows, rowCount: result.rowCount, affectedRows: result.affectedRows }
		};
	}
});

// ── Agents and Clopen ──────────────────────────────────────────────────────

export const agentsStatus = defineAgentAction({
	id: 'agents.status',
	group: 'agents',
	title: 'Installed agents',
	description: 'Which coding agents and tools are installed (Claude Code, OpenCode, Codex, Copilot, Qwen, Pi, Cline, Cursor, Git, Chrome).',
	args: t.Object({}),
	risk: 'read',
	scope: 'assistant',
	async run(ctx) {
		const result = await ctx.call<{ tools: Array<{ status: { tool: string; installed: boolean; version: string | null } }> }>('agents:install-status-all', {});
		const tools = result.tools.map((entry) => entry.status);
		return { text: tools.map((tool) => `- ${tool.tool}: ${tool.installed ? `installed ${tool.version ?? ''}` : 'not installed'}`).join('\n'), data: { tools } };
	}
});

export const agentsInstall = defineAgentAction({
	id: 'agents.install',
	group: 'agents',
	title: 'Install an agent',
	description: 'Install a coding agent or tool into Clopen’s own folder (no global changes). To sign it in, ask the owner only for the key or login it needs, save it with secret.save, and connect it through api.call (agents:* routes).',
	args: t.Object({
		tool: t.Union(['git', 'claude', 'opencode', 'copilot', 'codex', 'qwen', 'pi', 'cline', 'cursor', 'chrome'].map((tool) => t.Literal(tool)))
	}),
	risk: 'write',
	scope: 'assistant',
	async run(ctx, args) {
		const started = await ctx.call<{ sessionId: string; displayCommand: string }>('agents:install-start', { tool: args.tool });
		return { text: `Installing ${args.tool} (${started.displayCommand}). Check agents.status in a minute.`, data: started };
	}
});

export const assistantSettings = defineAgentAction({
	id: 'assistant.settings',
	group: 'assistant',
	title: 'How Clopen is set to work',
	description: 'Your autonomy setting and whether irreversible actions need the owner’s approval.',
	args: t.Object({}),
	risk: 'read',
	scope: 'assistant',
	async run() {
		const settings = getAssistantSettings();
		return {
			text: `Autonomy: ${settings.autonomy === 'autonomous' ? 'autonomous — work until done' : 'ask first — discuss and get approval before acting'}\nIrreversible actions: ${settings.allowIrreversible ? 'allowed without asking' : 'need the owner’s approval in the Inbox'}`,
			data: settings
		};
	}
});

export const assistantAudit = defineAgentAction({
	id: 'assistant.audit',
	group: 'assistant',
	title: 'Recent actions',
	description: 'The latest actions agents ran through Clopen, with their outcome.',
	args: t.Object({ limit: t.Optional(t.Number({ minimum: 1, maximum: 200 })) }),
	risk: 'read',
	scope: 'assistant',
	async run(_ctx, args) {
		const rows = controlAuditQueries.list(args.limit ?? 30);
		return { text: rows.map((row) => `${row.created_at.slice(0, 19)} ${row.actor} ${row.action} [${row.risk}] → ${row.outcome}${row.error ? `: ${row.error}` : ''}`).join('\n') || 'Nothing yet.', data: { rows } };
	}
});

// ── The raw API ────────────────────────────────────────────────────────────

export const apiDescribe = defineAgentAction({
	id: 'api.describe',
	group: 'api',
	title: 'Describe Clopen’s API',
	description:
		'List the WebSocket API routes (everything the web UI can do), or one namespace’s routes with their request schemas — "git", "notes", "work", "deployments", "preview", "worktrees", "memory", "mcp", "skills"… Use the curated actions first; reach for the API when none fits.',
	args: t.Object({ namespace: t.Optional(t.String()), route: t.Optional(t.String()) }),
	risk: 'read',
	scope: 'assistant',
	async run(_ctx, args) {
		const routes = describeRoutes().filter((route) => route.kind === 'request' && !isBlockedRoute(route.action));
		if (args.route) {
			const route = routes.find((entry) => entry.action === args.route);
			if (!route) throw new Error(`There is no reachable route "${args.route}".`);
			return { text: `${route.action} [${routeRisk(route.action)}]\nrequest: ${JSON.stringify(route.data ?? {}, null, 1).slice(0, 6000)}`, data: { route: route.action, risk: routeRisk(route.action), data: route.data } };
		}
		if (args.namespace) {
			const inNamespace = routes.filter((route) => route.action.startsWith(`${args.namespace}:`));
			return {
				text: inNamespace.map((route) => `${route.action} [${routeRisk(route.action)}] ${compactSchema(route.data)}`).join('\n') || `No routes in "${args.namespace}".`,
				data: { routes: inNamespace.map((route) => route.action) }
			};
		}
		const namespaces = new Map<string, number>();
		for (const route of routes) {
			const namespace = route.action.split(':')[0];
			namespaces.set(namespace, (namespaces.get(namespace) ?? 0) + 1);
		}
		return {
			text: [...namespaces.entries()].map(([namespace, count]) => `${namespace} (${count})`).join(', '),
			data: { namespaces: Object.fromEntries(namespaces) }
		};
	}
});

/** `{ a: string, b?: number }` — enough to call a route correctly at a glance. */
function compactSchema(schema: unknown): string {
	const properties = (schema as { properties?: Record<string, { type?: string; anyOf?: Array<{ type?: string; const?: unknown }> }>; required?: string[] } | null)?.properties;
	if (!properties) return '{}';
	const required = new Set((schema as { required?: string[] }).required ?? []);
	const fields = Object.entries(properties).map(([key, value]) => {
		const type = value.type ?? (value.anyOf ? value.anyOf.map((option) => (option.const !== undefined ? JSON.stringify(option.const) : option.type)).join('|') : 'any');
		return `${key}${required.has(key) ? '' : '?'}: ${type}`;
	});
	return `{ ${fields.join(', ')} }`;
}

/** Namespaces whose writes change a project's files, history or running state. */
const PROJECT_WRITE = /^(files|git|worktrees|terminal|snapshot|checkpoints?|deployments):/;

export const apiCall = defineAgentAction({
	id: 'api.call',
	group: 'api',
	title: 'Call Clopen’s API',
	description:
		'Call any reachable WebSocket API route with its request data (see api.describe). Credentials, sign-in, wiping Clopen and raw terminals are never reachable. Routes that delete, force or deploy wait for the owner’s approval.',
	args: t.Object({ route: t.String({ minLength: 3 }), data: t.Optional(t.Record(t.String(), t.Unknown())), projectId: t.Optional(t.String()) }),
	risk: (args) => routeRisk(args.route),
	scope: 'assistant',
	example: { route: 'notes:create', data: { scope: 'global', title: 'Ideas', content: '…' } },
	validate(args) {
		// Clopen reads projects but never changes one: that is the project agents' work.
		if (PROJECT_WRITE.test(args.route) && routeRisk(args.route) !== 'read') {
			throw new Error(`${args.route} changes a project. Project work is delegated (the delegate tool); you do not change projects yourself.`);
		}
		if (!isBlockedRoute(args.route)) return;
		const hint = /^(mcp|integrations):/.test(args.route)
			? ' To connect a service, use the connect tool (service.connect) — it handles sign-in and keys with the owner.'
			: /^agents:/.test(args.route)
				? ' To sign an agent in, ask the owner for the key with the ask tool and save it with secret.save.'
				: '';
		throw new Error(`${args.route} is not reachable by agents.${hint}`);
	},
	async run(ctx, args) {
		if (isBlockedRoute(args.route)) throw new Error(`${args.route} is not reachable by agents.`);
		if (PROJECT_WRITE.test(args.route) && routeRisk(args.route) !== 'read') throw new Error(`${args.route} changes a project; delegate project work.`);
		const result = await ctx.call(args.route, args.data ?? {}, { projectId: args.projectId ?? ctx.target.projectId });
		const text = JSON.stringify(result, null, 1) ?? 'null';
		return { text: text.length > 20_000 ? `${text.slice(0, 20_000)}\n…(truncated)` : text, data: result };
	}
});

export const SYSTEM_ACTIONS = [dbConnections, dbSchema, dbDescribe, dbQuery, agentsStatus, agentsInstall, assistantSettings, assistantAudit, apiDescribe, apiCall];
