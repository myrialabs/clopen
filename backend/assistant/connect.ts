/**
 * "Connect Notion" — services connected from the chat, never from Settings.
 *
 * Clopen finds the service — an installed connector, a well-known official
 * one, or a registry entry that signs in on its own — installs it, and checks
 * it. A registry entry that needs a key for some third party's gateway (a
 * "Smithery token") is never picked: the owner cannot be expected to have one.
 * When there is no safe connector, the answer says so and the work is done in
 * the browser instead.
 *
 * When it needs the owner, it asks for exactly that, right where they are, in
 * their language:
 *
 *   - a sign-in (OAuth): a "Connect <service>" card with ONE link, reused
 *     until it is used or expires — asking again never invalidates the link
 *     the owner may already have open. The link returns through the callback
 *     relay, so it works from a phone too;
 *   - a key or token: a card with a field for it — the value goes straight
 *     into the connector's encrypted config and the secrets vault, never
 *     through the model.
 *
 * "Connected" is only ever said after Clopen checked it. When the owner
 * finishes, the card closes and the chat that asked is told, so the work it
 * was doing carries on.
 */

import { inboxQueries, mcpServerQueries, secretQueries, settingsQueries, type McpConfigField, type McpServerRow } from '$backend/database/queries';
import { toInboxItem } from './mappers';
import {
	listRegistryServers,
	probeServer,
	refreshInternalEnabledCache,
	resolveServerRow,
	slugifyRegistryName,
	startAuthorization,
	getValidAccessToken
} from '$backend/mcp';
import { debug } from '$shared/utils/logger';
import { relayRedirectUri } from '$backend/mcp/external/oauth-relay';
import { completeCard, openCardsFor, raiseCard, type CardField, type CardRefs } from './cards';
import { journal } from './journal';
import { inOwnersLanguage, ownerSample } from './think';

/** A sign-in link is reused for this long; after that a fresh one is made. */
const LINK_REUSE_MS = 25 * 60_000;

/** Registry connectors whose "key" is an account at a third-party gateway, not at the service. */
const GATEWAY_HOSTS = ['smithery.ai', 'smithery.run'];

/** Official remote MCP endpoints for services people ask for by name. */
const KNOWN: Record<string, { name: string; url: string; transport?: 'http' | 'sse' }> = {
	notion: { name: 'Notion', url: 'https://mcp.notion.com/mcp' },
	linear: { name: 'Linear', url: 'https://mcp.linear.app/mcp' },
	sentry: { name: 'Sentry', url: 'https://mcp.sentry.dev/mcp' },
	atlassian: { name: 'Atlassian (Jira, Confluence)', url: 'https://mcp.atlassian.com/v1/sse', transport: 'sse' },
	jira: { name: 'Atlassian (Jira, Confluence)', url: 'https://mcp.atlassian.com/v1/sse', transport: 'sse' },
	confluence: { name: 'Atlassian (Jira, Confluence)', url: 'https://mcp.atlassian.com/v1/sse', transport: 'sse' },
	asana: { name: 'Asana', url: 'https://mcp.asana.com/sse', transport: 'sse' },
	stripe: { name: 'Stripe', url: 'https://mcp.stripe.com' },
	vercel: { name: 'Vercel', url: 'https://mcp.vercel.com' },
	supabase: { name: 'Supabase', url: 'https://mcp.supabase.com/mcp' },
	canva: { name: 'Canva', url: 'https://mcp.canva.com/mcp' }
};

export type ConnectStatus = 'connected' | 'needs-sign-in' | 'needs-key' | 'needs-approval' | 'not-found' | 'not-available' | 'failed';

export interface ConnectResult {
	status: ConnectStatus;
	service: string;
	text: string;
	serverId?: number;
	url?: string;
}

function key(service: string): string {
	return service.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** The installed connector for a service name (slug or display name), if any. */
export function findInstalled(service: string): McpServerRow | null {
	const wanted = key(service);
	const external = mcpServerQueries.getAll().filter((row) => row.source !== 'internal');
	return (
		external.find((row) => key(row.slug) === wanted || key(row.name) === wanted) ??
		external.find((row) => key(row.slug).includes(wanted) || key(row.name).includes(wanted)) ??
		null
	);
}

function uniqueSlug(base: string): string {
	const root = slugifyRegistryName(base);
	if (!mcpServerQueries.getBySlug(root)) return root;
	for (let i = 2; i < 1000; i++) if (!mcpServerQueries.getBySlug(`${root}-${i}`)) return `${root}-${i}`;
	return `${root}-${Date.now()}`;
}

type RegistryEntry = Awaited<ReturnType<typeof listRegistryServers>>['servers'][number];

/** The registry connector Clopen would install for a service, if one can be finished by the owner. */
async function registryPick(service: string): Promise<RegistryEntry | null> {
	const page = await listRegistryServers({ search: service, limit: 10 });
	const wanted = key(service);
	const ranked = [...page.servers].sort((a, b) => {
		const score = (title: string, slug: string) => (key(title) === wanted ? 3 : key(title).includes(wanted) || key(slug).includes(wanted) ? 1 : 0);
		const remote = (transport: string) => (transport === 'stdio' ? 0 : 1);
		return score(b.title, b.slug) * 2 + remote(b.transport) - (score(a.title, a.slug) * 2 + remote(a.transport));
	});
	// Only a connector the owner can actually finish: it signs in by itself, or asks for a key of the
	// service itself — never a gateway's token, and never a local server that needs secrets nobody has.
	const pick = ranked.find((entry) => {
		if (entry.url && GATEWAY_HOSTS.some((host) => entry.url!.includes(host))) return false;
		// A key the owner would have to get from somewhere else is not something they can finish.
		return ![...entry.envVars, ...entry.headerVars].some((field) => field.isRequired);
	});
	return pick ?? null;
}

const APPROVED_KEY = 'assistant:approved-connectors';

function approvedConnectors(): string[] {
	try {
		return JSON.parse(settingsQueries.get(APPROVED_KEY)?.value ?? '[]') as string[];
	} catch {
		return [];
	}
}

/** Who published a registry connector: the namespace of its registry name ("ai.waystation/gmail" → "ai.waystation"). */
function publisherOf(entry: { registryName?: string | null; url?: string | null }): string {
	const namespace = entry.registryName?.split('/')[0];
	if (namespace) return namespace;
	try {
		return entry.url ? new URL(entry.url).hostname : 'an unknown publisher';
	} catch {
		return 'an unknown publisher';
	}
}

/** One approval card per connector, naming who published it. */
async function askToApprove(service: string, pick: RegistryEntry, id: string, refs: CardRefs): Promise<ConnectResult> {
	const waiting = openCardsFor((data) => (data.target as { type?: string; connector?: string } | undefined)?.type === 'connector-approval' && (data.target as { connector?: string }).connector === id);
	if (!waiting.length) {
		const sample = ownerSample(refs.sessionId);
		raiseCard({
			card: 'approve',
			title: await inOwnersLanguage(`Connect ${service} with a connector that is not ${service}'s own?`, sample),
			body: await inOwnersLanguage(
				`This is not ${service}'s own connector: it is published by ${publisherOf(pick)}, and it will act on your ${service} account.${pick.url ? ` It runs at ${new URL(pick.url).hostname}.` : ''}`,
				sample
			),
			target: { type: 'connector-approval', connector: id, service },
			refs
		});
	}
	return {
		status: 'needs-approval',
		service,
		text: `${service} has no official connector here. Asked the owner to approve one by ${publisherOf(pick)}. Do not say it is connected; wait for "[Clopen · connected]" or "[Clopen · declined]".`
	};
}

/** The owner decided on a third-party connector: connect it, or let the asker know it was declined. */
export async function onConnectorDecision(item: { id: string; data: Record<string, unknown>; sessionId: string | null; missionId?: string | null }, approved: boolean): Promise<void> {
	const target = item.data.target as { connector?: string; service?: string } | undefined;
	if (!target?.connector || !target.service) return;
	// Answered by a message that has its own turn: that turn carries on; no second one.
	const { wasAnsweredInTurn } = await import('./cards');
	const inTurn = wasAnsweredInTurn(item.id);
	if (!approved) {
		if (inTurn) return;
		await tellAsker(item.sessionId, `[Clopen · declined] The owner declined connecting ${target.service} through that third-party connector. Do not try another one for it; say in a few words what you can do instead.`);
		return;
	}
	settingsQueries.set(APPROVED_KEY, JSON.stringify([...new Set([...approvedConnectors(), target.connector])]));
	const result = await connectService(target.service, { sessionId: item.sessionId, missionId: item.missionId ?? null });
	if (result.status === 'connected' && !inTurn) await tellAsker(item.sessionId, `[Clopen · connected] ${result.service} is connected. Its tools are available now — continue what you were doing.`);
}

async function install(service: string): Promise<McpServerRow | null> {
	const known = KNOWN[key(service)];
	if (known) {
		return mcpServerQueries.insert({
			slug: uniqueSlug(key(service)),
			name: known.name,
			description: `${known.name} (official)`,
			transport: known.transport ?? 'http',
			url: known.url,
			source: 'custom'
		});
	}
	const pick = await registryPick(service);
	if (!pick) return null;
	const configSchema: McpConfigField[] = [
		...pick.envVars.map((field) => ({ name: field.name, kind: 'env' as const, description: field.description, isRequired: field.isRequired, isSecret: field.isSecret })),
		...pick.headerVars.map((field) => ({ name: field.name, kind: 'header' as const, description: field.description, isRequired: field.isRequired, isSecret: field.isSecret }))
	];
	return mcpServerQueries.insert({
		slug: uniqueSlug(pick.slug),
		name: pick.title,
		description: pick.description,
		registryName: pick.registryName,
		version: pick.version,
		transport: pick.transport,
		command: pick.command ?? null,
		args: pick.args ?? [],
		url: pick.url ?? null,
		configSchema,
		source: 'registry'
	});
}

function missingFields(row: McpServerRow): McpConfigField[] {
	let schema: McpConfigField[] = [];
	try {
		schema = JSON.parse(row.config_schema) as McpConfigField[];
	} catch {
		schema = [];
	}
	const env = JSON.parse(row.env || '{}') as Record<string, string>;
	const headers = JSON.parse(row.headers || '{}') as Record<string, string>;
	return schema.filter((field) => field.isRequired && !((field.kind === 'header' ? headers : env)[field.name] ?? '').trim());
}

/** Connect a service by name. Idempotent: an existing, working connection is reported as such. */
export async function connectService(service: string, refs: CardRefs = {}): Promise<ConnectResult> {
	const name = service.trim();
	if (!name) return { status: 'not-found', service: name, text: 'Which service?' };
	let row = findInstalled(name);
	// A connector that leads nowhere (a gateway that needs its own token, or one that no longer answers) is
	// dropped rather than reported: the owner wants the service, not an explanation of a broken connector.
	if (row && row.source === 'registry') {
		const gateway = Boolean(row.url && GATEWAY_HOSTS.some((host) => row!.url!.includes(host)));
		const health = gateway ? null : await probeServer(resolveServerRow(row)).catch(() => null);
		if (gateway || health?.state === 'error') {
			mcpServerQueries.remove(row.id);
			refreshInternalEnabledCache();
			for (const card of openCardsFor((data) => (data.target as { serverId?: number } | undefined)?.serverId === row!.id)) completeCard(card.id, 'Removed');
			row = null;
		}
	}
	// Not the service's own connector but someone else's: the owner says yes first, knowing who made it.
	if (!row && !KNOWN[key(name)]) {
		const pick = await registryPick(name).catch(() => null);
		const id = pick ? (pick.registryName ?? pick.slug) : null;
		if (pick && id && !approvedConnectors().includes(id)) return askToApprove(name, pick, id, refs);
	}
	try {
		if (!row) row = await install(name);
	} catch (error) {
		debug.warn('assistant', `Installing a connector for ${name} failed:`, error);
	}
	if (!row) return askForLogin(name, refs);
	if (row.is_enabled !== 1) {
		mcpServerQueries.setEnabled(row.id, true);
		refreshInternalEnabledCache();
	}

	const missing = missingFields(row);
	if (missing.length) {
		const fields: CardField[] = missing.map((field) => ({ name: `${field.kind}:${field.name}`, label: field.description || field.name, secret: field.isSecret !== false }));
		const existing = openCardsFor((data) => (data.target as { serverId?: number } | undefined)?.serverId === row!.id);
		const card =
			existing[0] ??
			raiseCard({
				card: 'secret',
				title: await inOwnersLanguage(`${row.name} needs ${missing.length === 1 ? 'a key' : 'a few details'}`, ownerSample(refs.sessionId)),
				body: missing.map((field) => field.description || field.name).join('\n'),
				fields,
				target: { type: 'mcp', serverId: row.id, service: row.name },
				refs
			});
		return { status: 'needs-key', service: row.name, serverId: row.id, text: `Asked the owner for ${row.name}'s ${missing.map((field) => field.name).join(', ')} (card ${card.id}). Wait for "[Clopen · connected]".` };
	}

	if (row.oauth) await getValidAccessToken(row.id).catch(() => null);
	const health = await probeServer(resolveServerRow(mcpServerQueries.getById(row.id)!));
	if (health.state === 'ok' || health.state === 'local') {
		return { status: 'connected', service: row.name, serverId: row.id, text: `${row.name} is connected${health.toolCount ? ` (${health.toolCount} tools)` : ''}. Its tools are available from the next turn.` };
	}
	if (health.state === 'needs_auth' && row.url) {
		// One link per service: the owner may already have it open (in Telegram, on a phone).
		const pending = openCardsFor((data) => (data.target as { serverId?: number } | undefined)?.serverId === row!.id && data.card === 'connect');
		const fresh = pending.find((card) => Date.now() - new Date(card.createdAt).getTime() < LINK_REUSE_MS && typeof card.data.url === 'string');
		if (fresh) {
			return {
				status: 'needs-sign-in',
				service: row.name,
				serverId: row.id,
				url: String(fresh.data.url),
				text: `${row.name} is NOT connected yet: the owner has not finished signing in with the link already sent (card ${fresh.id}). Do not say it is connected. Wait for "[Clopen · connected]".`
			};
		}
		const redirect = (await relayRedirectUri()) ?? undefined;
		const { authorizationUrl } = await startAuthorization(row.id, row.url, undefined, redirect);
		for (const old of pending) completeCard(old.id, 'Expired');
		const sample = ownerSample(refs.sessionId);
		raiseCard({
			card: 'connect',
			title: await inOwnersLanguage(`Connect ${row.name}`, sample),
			body: await inOwnersLanguage('Sign in and allow access. Clopen carries on by itself.', sample),
			url: authorizationUrl,
			target: { type: 'mcp', serverId: row.id, service: row.name },
			refs
		});
		return { status: 'needs-sign-in', service: row.name, serverId: row.id, url: authorizationUrl, text: `${row.name} is not connected yet. Sent the owner a sign-in card. Do not say it is connected; wait for "[Clopen · connected]".` };
	}
	if (health.state === 'needs_config') {
		const card = raiseCard({
			card: 'secret',
			title: await inOwnersLanguage(`${row.name} needs a key`, ownerSample(refs.sessionId)),
			body: health.message ?? 'An API key or token is required.',
			fields: [{ name: 'header:Authorization', label: `${row.name} API key or token`, secret: true }],
			target: { type: 'mcp', serverId: row.id, service: row.name, bearer: true },
			refs
		});
		return { status: 'needs-key', service: row.name, serverId: row.id, text: `Asked the owner for ${row.name}'s key (card ${card.id}).` };
	}
	return { status: 'failed', service: row.name, serverId: row.id, text: `${row.name} could not be reached: ${health.message ?? health.state}.` };
}

function loginSecretNames(service: string): { login: string; password: string } {
	const base = slugifyRegistryName(service).toLowerCase() || 'service';
	return { login: `${base}-login`, password: `${base}-password` };
}

/**
 * No connector the owner can finish: ask once for the account itself — the
 * login and password go to the vault (never through the model), and Clopen
 * signs in with the browser. A login already saved is simply used.
 */
async function askForLogin(service: string, refs: CardRefs): Promise<ConnectResult> {
	const names = loginSecretNames(service);
	if (secretQueries.get(names.password)) {
		return {
			status: 'connected',
			service,
			text: `There is no connector for ${service}; its login is saved. Sign in with the browser (browse) using secret.get "${names.login}" and "${names.password}", then do the task. Tell the owner only the result.`
		};
	}
	const pending = openCardsFor((data) => (data.target as { type?: string; service?: string } | undefined)?.type === 'login' && (data.target as { service?: string }).service === service);
	if (!pending.length) {
		const sample = ownerSample(refs.sessionId);
		raiseCard({
			card: 'secret',
			title: await inOwnersLanguage(`Sign in to ${service}`, sample),
			body: await inOwnersLanguage('Your login is stored encrypted and used only to sign in for you.', sample),
			fields: [
				{ name: 'login', label: await inOwnersLanguage('Email or username', sample), secret: false },
				{ name: 'password', label: await inOwnersLanguage('Password', sample), secret: true }
			],
			target: { type: 'login', service, ...names },
			refs
		});
	}
	return {
		status: 'needs-key',
		service,
		text: `Sent the owner a sign-in card for ${service}. When "[Clopen · saved]" arrives, sign in with the browser using those secrets and do the task. Say nothing about connectors.`
	};
}

/**
 * The owner filled a secret card (web field or chat reply). The value goes
 * into the connector's config and the vault; the model never sees it.
 */
export async function fillSecretCard(item: { id: string; data: Record<string, unknown>; sessionId: string | null }, values: Record<string, string>, source: 'web' | 'telegram' | null = 'web'): Promise<string> {
	if (source) {
		const { maskedCardLine, noteCardAnswer } = await import('./cards');
		const full = toInboxItem(inboxQueries.getById(item.id)!);
		noteCardAnswer(full, maskedCardLine(full, values), source);
	}
	const target = (item.data.target ?? {}) as { type?: string; serverId?: number; service?: string; bearer?: boolean; secret?: string; login?: string; password?: string };
	if (target.type === 'login' && target.login && target.password) {
		if (!values.login?.trim() || !values.password) throw new Error('Both the login and the password are needed.');
		secretQueries.save({ name: target.login, value: values.login.trim(), description: `${target.service} login`, createdBy: 'user' });
		secretQueries.save({ name: target.password, value: values.password, description: `${target.service} password`, createdBy: 'user' });
		completeCard(item.id, 'Saved');
		await tellAsker(
			item.sessionId,
			`[Clopen · saved] The owner's ${target.service} login is in the vault as "${target.login}" and "${target.password}". Sign in with the browser using secret.get and finish what they asked. Tell them only the result.`
		);
		return 'Saved.';
	}
	if (target.type === 'secret' && target.secret) {
		const value = Object.values(values)[0] ?? '';
		secretQueries.save({ name: target.secret, value, createdBy: 'user' });
		completeCard(item.id, 'Saved');
		await tellAsker(item.sessionId, `[Clopen · saved] The owner gave "${target.secret}". It is in the secrets vault — use secret.get "${target.secret}" and continue.`);
		return 'Saved.';
	}
	if (target.type !== 'mcp' || typeof target.serverId !== 'number') throw new Error('That card no longer leads anywhere.');
	const row = mcpServerQueries.getById(target.serverId);
	if (!row) throw new Error('That connector was removed.');
	const env = JSON.parse(row.env || '{}') as Record<string, string>;
	const headers = JSON.parse(row.headers || '{}') as Record<string, string>;
	for (const [field, raw] of Object.entries(values)) {
		const value = raw.trim();
		if (!value) continue;
		const [kind, name] = field.includes(':') ? (field.split(/:(.*)/s, 2) as [string, string]) : ['env', field];
		if (kind === 'header') headers[name] = target.bearer && name === 'Authorization' && !/^bearer /i.test(value) ? `Bearer ${value}` : value;
		else env[name] = value;
		secretQueries.save({ name: `${slugifyRegistryName(row.name)}-${name}`.toLowerCase(), value, description: `${row.name} ${name}`, createdBy: 'user' });
	}
	mcpServerQueries.updateConfig(row.id, env, headers);
	completeCard(item.id, 'Saved');
	const result = await connectService(row.name, { sessionId: item.sessionId });
	if (result.status === 'connected') await onServiceConnected(row.id);
	return result.status === 'connected' ? `${row.name} is connected.` : result.text;
}

/** A service finished connecting (OAuth callback or a filled key): close its cards, tell whoever asked. */
export async function onServiceConnected(serverId: number): Promise<void> {
	const row = mcpServerQueries.getById(serverId);
	if (!row) return;
	journal('note', `Connected ${row.name}`);
	const cards = openCardsFor((data) => (data.target as { serverId?: number } | undefined)?.serverId === serverId);
	const sessions = new Set<string>();
	for (const card of cards) {
		completeCard(card.id, 'Connected');
		if (card.sessionId) sessions.add(card.sessionId);
	}
	for (const sessionId of sessions) {
		await tellAsker(sessionId, `[Clopen · connected] ${row.name} is connected. Its tools are available now — continue what you were doing.`);
	}
}

async function tellAsker(sessionId: string | null, text: string): Promise<void> {
	if (!sessionId) return;
	try {
		const { sessionQueries, projectQueries } = await import('$backend/database/queries');
		const { sendPromptAsOwner } = await import('./prompt');
		const session = sessionQueries.getById(sessionId);
		const project = session ? projectQueries.getById(session.project_id) : null;
		if (session && project) await sendPromptAsOwner({ project, session, text, synthetic: true });
	} catch (error) {
		debug.warn('assistant', 'Telling a chat about a connection failed:', error);
	}
}
