/**
 * The channel runtime — one backend-owned `ChatKit`, one adapter per connected
 * bot, kept in step with the accounts table.
 *
 * DELIVERY IS ADAPTIVE, the way Share Link is. A platform that can push to a
 * webhook gets one when Clopen has a public HTTPS origin: the configured URL,
 * else the non-local origin a browser last reached Clopen on, else a
 * Cloudflare quick tunnel started for it — the same three steps Remote Access
 * resolves. When none can be had (the tunnel binary cannot be fetched, the
 * platform refuses the URL) the bot long-polls instead, which needs no public
 * URL at all. Either way the user connected a bot and it works.
 *
 * A quick tunnel's URL changes every time it restarts, so the runtime watches
 * tunnelkit and re-registers when it moves. If the tunnel disappears the bot
 * drops to polling rather than starting it again: a tunnel the user stopped by
 * hand is a decision, and restarting it behind their back would be a fight.
 * The next boot (or reconnecting the bot) brings webhooks back.
 *
 * Every reconcile is serialised on one promise chain. Adding and removing
 * adapters, and registering webhooks, are all network round-trips, and two of
 * them interleaving for one account is how a bot ends up registered twice.
 */

import { createHash, createHmac } from 'crypto';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { ChatKit, splitRuns, type AccountHealth, type SendResult, type TextRun, type UniversalMessage } from '@myrialabs/chatkit';
import { SqliteStore } from '@myrialabs/chatkit/store';
import { integrationAccountQueries, type IntegrationAccountRow } from '$backend/database/queries';
import { getMasterKey } from '$backend/database/crypto';
import { getProvider, withGeneratedCredentials, type WebhookEvent } from '$backend/integrations';
import { findPublicOrigin, isLocalHostname, resolvePublicOrigin, type PublicOrigin } from '$backend/tunnel/public-origin';
import { tunnelKit } from '$backend/tunnel/tunnel-config';
import { getClopenDir } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';
import {
	getChannelPlatform,
	listChannelPlatforms,
	type ChannelButton,
	type ChannelCard,
	type ChannelCommand,
	type ChannelFile,
	type ChannelPlatform,
	type DeliveryMode
} from './platforms';

export interface ActiveChannel {
	accountId: string;
	platform: ChannelPlatform;
	mode: DeliveryMode;
	/** The origin the webhook points at; null while polling. */
	origin: PublicOrigin | null;
	/** Changes when anything the adapter was built from changes. */
	fingerprint: string;
}

export interface ChannelStatus {
	running: boolean;
	mode: DeliveryMode | null;
	originSource: PublicOrigin['source'] | null;
	connection: AccountHealth['state'] | null;
	error: string | null;
}

export type InboundHandler = (message: UniversalMessage, channel: ActiveChannel) => Promise<void>;

export type MenuRole = 'admin' | 'member';

/**
 * What a bot's `/` menu holds. Every chat gets the member menu by default; a
 * chat paired by an admin gets its own, longer one — the same list `/help`
 * shows that person.
 */
export interface CommandMenu {
	forRole(role: MenuRole): ChannelCommand[];
	/** The paired chats of a bot and their owner's role, to publish their own menus. */
	chatsOf(accountId: string): Array<{ conversationId: string; role: MenuRole }>;
}

/** A file a chat sent, read out of ChatKit's media store. */
export interface InboundFile {
	data: Uint8Array;
	mime: string | null;
	filename: string | null;
}

/** The hook URL the gateway serves for a provider. */
function hookUrl(origin: string, provider: string): string {
	return `${origin}/api/integrations/hooks/${provider}`;
}

/** Push platforms only deliver to HTTPS, and never to a host they cannot reach. */
function usableForWebhook(origin: PublicOrigin | null): origin is PublicOrigin {
	if (!origin) return false;
	try {
		const url = new URL(origin.origin);
		return url.protocol === 'https:' && !isLocalHostname(url.hostname);
	} catch {
		return false;
	}
}

function fingerprintOf(row: IntegrationAccountRow, credentials: Record<string, string>): string {
	return createHash('sha256').update(JSON.stringify([row.provider, credentials])).digest('hex');
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * ChatKit's own state (dedup keys, polling offsets, any adapter auth state)
 * is sealed with a key DERIVED from Clopen's master key — so it rotates,
 * backs up and restores with everything else Clopen seals, and is never a
 * second secret for the operator to keep.
 */
function deriveStateKey(): string {
	return createHmac('sha256', getMasterKey().key).update('clopen/chatkit-state/v1').digest('base64url');
}

/** Namespace for Clopen's own entries in ChatKit's kv area. */
const KV_NAMESPACE = 'clopen';
const KV_BROWSER_ORIGIN = 'browser-origin';

/** Coalesces a burst of bot status changes into one "refresh" for Settings. */
const STATUS_DEBOUNCE_MS = 400;

/** Coalesces a burst of tunnel status events into one re-evaluation. */
const TUNNEL_DEBOUNCE_MS = 1500;

class ChannelRuntime {
	private chat: ChatKit | null = null;
	private readonly active = new Map<string, ActiveChannel>();
	private readonly failures = new Map<string, string>();
	private chain: Promise<void> = Promise.resolve();
	private inboundHandler: InboundHandler | null = null;
	private menu: CommandMenu | null = null;
	private statusListener: (() => void) | null = null;
	private statusTimer: ReturnType<typeof setTimeout> | null = null;
	/** `${accountId}\u0000${conversationId}` → the role whose menu that chat has. */
	private readonly chatMenus = new Map<string, MenuRole>();
	private browserOrigin: string | null = null;
	private tunnelTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly onTunnelChange = (): void => {
		if (this.tunnelTimer) clearTimeout(this.tunnelTimer);
		this.tunnelTimer = setTimeout(() => {
			this.tunnelTimer = null;
			this.enqueue(() => this.reevaluateDelivery());
		}, TUNNEL_DEBOUNCE_MS);
	};

	setInboundHandler(handler: InboundHandler): void {
		this.inboundHandler = handler;
	}

	/**
	 * Told whenever what `status()` reports may have changed: a bot came up,
	 * went down, moved between webhook and polling, or its connection dropped
	 * or recovered. Settings refreshes on it instead of waiting to be reopened.
	 */
	onStatusChanged(listener: () => void): void {
		this.statusListener = listener;
	}

	/** Coalesced: a polling loop that drops and recovers would otherwise fire on every retry. */
	private statusChanged(): void {
		if (this.statusTimer) return;
		this.statusTimer = setTimeout(() => {
			this.statusTimer = null;
			try {
				this.statusListener?.();
			} catch (error) {
				debug.warn('chat-apps', 'Status listener failed:', describe(error));
			}
		}, STATUS_DEBOUNCE_MS);
		this.statusTimer.unref?.();
	}

	/** The command menus every bot publishes when it comes up. */
	setCommandMenu(menu: CommandMenu): void {
		this.menu = menu;
	}

	/**
	 * Publish a bot's menus: the member one as the default, then each admin's
	 * chat its own. Best effort: a bot whose menu could not be published still
	 * works by typing.
	 */
	private publishCommands(platform: ChannelPlatform, accountId: string): void {
		const adapter = this.chat?.adapterFor(platform.chatkit, accountId);
		const menu = this.menu;
		if (!adapter || !menu) return;
		void platform.registerCommands(adapter, menu.forRole('member')).catch((error) => {
			debug.warn('chat-apps', 'Publishing the bot command menu failed:', describe(error));
		});
		for (const chat of menu.chatsOf(accountId)) void this.syncChatMenu(accountId, chat.conversationId, chat.role, { force: true });
	}

	/**
	 * Make one chat's menu match its owner's role. Cheap to call on every
	 * message: it only talks to the platform when the role changed (an admin
	 * demoted, a member promoted) or `force` is set.
	 */
	async syncChatMenu(accountId: string, conversationId: string, role: MenuRole | null, options: { force?: boolean } = {}): Promise<void> {
		const channel = this.active.get(accountId);
		const adapter = channel ? this.chat?.adapterFor(channel.platform.chatkit, accountId) : null;
		if (!channel || !adapter || !this.menu) return;
		const key = `${accountId}\u0000${conversationId}`;
		const published = this.chatMenus.get(key) ?? null;
		if (!options.force && published === role) return;
		try {
			if (role === 'admin') {
				await channel.platform.registerCommands(adapter, this.menu.forRole('admin'), conversationId);
				this.chatMenus.set(key, 'admin');
			} else {
				// A member's chat uses the default menu; drop any admin one it had.
				if (published === 'admin' || options.force) await channel.platform.clearCommands(adapter, conversationId).catch(() => {});
				if (role) this.chatMenus.set(key, role);
				else this.chatMenus.delete(key);
			}
		} catch (error) {
			debug.warn('chat-apps', 'Publishing a chat command menu failed:', describe(error));
		}
	}

	get isStarted(): boolean {
		return this.chat !== null;
	}

	async start(): Promise<void> {
		if (this.chat) return;
		const dir = join(getClopenDir(), 'chatkit');
		mkdirSync(dir, { recursive: true });

		const chat = new ChatKit({
			store: new SqliteStore({ path: join(dir, 'state.db'), stateKey: deriveStateKey() }),
			logger: {
				debug: (message, fields) => debug.log('chat-apps', `[chatkit] ${message}`, fields ?? ''),
				info: (message, fields) => debug.log('chat-apps', `[chatkit] ${message}`, fields ?? ''),
				warn: (message, fields) => debug.warn('chat-apps', `[chatkit] ${message}`, fields ?? ''),
				error: (message, fields) => debug.error('chat-apps', `[chatkit] ${message}`, fields ?? '')
			}
		});
		chat.on('message', (message) => this.dispatchInbound(message));
		chat.on('connection', () => this.statusChanged());
		chat.on('error', ({ platform, account, error }) => {
			debug.warn('chat-apps', `Channel ${platform ?? '?'}:${account ?? '?'} error:`, error.message);
		});
		await chat.start();
		this.chat = chat;

		this.browserOrigin = await chat.store.kvGet(KV_NAMESPACE, KV_BROWSER_ORIGIN).catch(() => null);
		tunnelKit.on('status-changed', this.onTunnelChange);
		this.reconcile();
	}

	async stop(): Promise<void> {
		tunnelKit.off('status-changed', this.onTunnelChange);
		if (this.tunnelTimer) clearTimeout(this.tunnelTimer);
		await this.chain.catch(() => {});
		const chat = this.chat;
		this.chat = null;
		this.active.clear();
		this.chatMenus.clear();
		// Webhooks stay registered on purpose: the platform queues what arrives
		// while Clopen is down and redelivers once it is reachable again.
		await chat?.stop().catch((error) => debug.warn('chat-apps', 'ChatKit stop failed:', error));
	}

	/** Run `task` after every earlier one. Failures are logged, never propagated down the chain. */
	private enqueue(task: () => Promise<void>): Promise<void> {
		const next = this.chain
			.then(task)
			.catch((error) => debug.error('chat-apps', 'Channel runtime task failed:', error))
			.finally(() => this.statusChanged());
		this.chain = next;
		return next;
	}

	/** Bring the running adapters in line with the accounts table. */
	reconcile(): Promise<void> {
		return this.enqueue(() => this.reconcileNow());
	}

	private desiredAccounts(): Array<{ row: IntegrationAccountRow; platform: ChannelPlatform; credentials: Record<string, string> }> {
		const providers = new Set(listChannelPlatforms().map((platform) => platform.provider));
		const out: Array<{ row: IntegrationAccountRow; platform: ChannelPlatform; credentials: Record<string, string> }> = [];
		for (const row of integrationAccountQueries.getAll()) {
			if (!providers.has(row.provider) || row.is_enabled !== 1) continue;
			if (!integrationAccountQueries.capabilitiesOf(row).includes('control')) continue;
			const platform = getChannelPlatform(row.provider)!;
			let credentials = integrationAccountQueries.credentialsOf(row);
			// An account sealed before its provider generated a secret (or one
			// whose secret was lost with the key) gets one now, persisted, so the
			// webhook it is about to register can be verified.
			const provider = getProvider(row.provider);
			if (provider) {
				const filled = withGeneratedCredentials(provider, credentials);
				if (JSON.stringify(filled) !== JSON.stringify(credentials)) {
					integrationAccountQueries.setCredentials(row.id, filled);
					credentials = filled;
				}
			}
			out.push({ row, platform, credentials });
		}
		return out;
	}

	private async reconcileNow(): Promise<void> {
		if (!this.chat) return;
		const desired = this.desiredAccounts();
		const desiredIds = new Set(desired.map((entry) => entry.row.id));

		for (const [accountId, channel] of [...this.active]) {
			if (!desiredIds.has(accountId)) await this.teardown(channel, { unregister: true });
		}
		for (const accountId of [...this.failures.keys()]) {
			if (!desiredIds.has(accountId)) this.failures.delete(accountId);
		}

		for (const { row, platform, credentials } of desired) {
			const fingerprint = fingerprintOf(row, credentials);
			const current = this.active.get(row.id);
			if (current?.fingerprint === fingerprint) continue;
			if (current) await this.teardown(current, { unregister: false });
			await this.setup(row, platform, credentials, fingerprint, { allowTunnelStart: true });
		}
	}

	/** The webhook origin to use right now, optionally starting a tunnel to get one. */
	private async resolveOrigin(allowTunnelStart: boolean): Promise<PublicOrigin | null> {
		const found = findPublicOrigin(this.browserOrigin ?? undefined);
		if (found || !allowTunnelStart) return usableForWebhook(found) ? found : null;
		try {
			const started = await resolvePublicOrigin(this.browserOrigin ?? undefined);
			return usableForWebhook(started) ? started : null;
		} catch (error) {
			debug.warn('chat-apps', 'No public origin for channel webhooks, falling back to polling:', describe(error));
			return null;
		}
	}

	private async setup(
		row: IntegrationAccountRow,
		platform: ChannelPlatform,
		credentials: Record<string, string>,
		fingerprint: string,
		options: { allowTunnelStart: boolean }
	): Promise<void> {
		const chat = this.chat;
		if (!chat) return;
		const secret = credentials[getProvider(row.provider)?.webhook?.secretField ?? ''] ?? '';

		if (platform.deliveryModes.includes('webhook') && secret) {
			const origin = await this.resolveOrigin(options.allowTunnelStart);
			if (origin) {
				const adapter = platform.createAdapter({ account: row.id, credentials, mode: 'webhook' });
				try {
					await chat.add(adapter);
					await platform.registerWebhook(adapter, hookUrl(origin.origin, row.provider), secret);
					this.active.set(row.id, { accountId: row.id, platform, mode: 'webhook', origin, fingerprint });
					this.failures.delete(row.id);
					this.publishCommands(platform, row.id);
					debug.log('chat-apps', `Channel ${row.provider} "${row.label}" receiving by webhook via ${origin.source}`);
					return;
				} catch (error) {
					debug.warn('chat-apps', `Webhook for ${row.provider} "${row.label}" refused, falling back to polling:`, describe(error));
					await chat.remove(platform.chatkit, row.id).catch(() => {});
				}
			}
		}

		if (!platform.deliveryModes.includes('polling')) {
			this.failures.set(row.id, 'No public HTTPS address to receive messages at');
			return;
		}
		const adapter = platform.createAdapter({ account: row.id, credentials, mode: 'polling' });
		try {
			await chat.add(adapter);
			this.active.set(row.id, { accountId: row.id, platform, mode: 'polling', origin: null, fingerprint });
			this.failures.delete(row.id);
			this.publishCommands(platform, row.id);
			debug.log('chat-apps', `Channel ${row.provider} "${row.label}" receiving by polling`);
		} catch (error) {
			this.failures.set(row.id, describe(error));
			debug.warn('chat-apps', `Channel ${row.provider} "${row.label}" failed to start:`, describe(error));
		}
	}

	private async teardown(channel: ActiveChannel, options: { unregister: boolean }): Promise<void> {
		const chat = this.chat;
		this.active.delete(channel.accountId);
		if (!chat) return;
		const adapter = chat.adapterFor(channel.platform.chatkit, channel.accountId);
		if (options.unregister && adapter && channel.mode === 'webhook') {
			await channel.platform.unregisterWebhook(adapter).catch((error) => {
				debug.warn('chat-apps', 'Could not unregister channel webhook:', describe(error));
			});
		}
		await chat.remove(channel.platform.chatkit, channel.accountId).catch(() => {});
	}

	/**
	 * Re-check every running bot against the origin available NOW, without
	 * starting a tunnel: a webhook whose origin moved or vanished is moved or
	 * dropped to polling, and a polling bot is promoted once an origin exists.
	 */
	private async reevaluateDelivery(): Promise<void> {
		if (!this.chat) return;
		const origin = await this.resolveOrigin(false);
		for (const channel of [...this.active.values()]) {
			if (!channel.platform.deliveryModes.includes('webhook')) continue;
			const stale = channel.mode === 'webhook' ? channel.origin?.origin !== origin?.origin : origin !== null;
			if (!stale) continue;
			const row = integrationAccountQueries.getById(channel.accountId);
			if (!row) continue;
			const credentials = integrationAccountQueries.credentialsOf(row);
			await this.teardown(channel, { unregister: false });
			await this.setup(row, channel.platform, credentials, channel.fingerprint, { allowTunnelStart: false });
		}
	}

	/**
	 * A browser reached Clopen on this origin. A non-local one is a real
	 * deployment's address — better than a tunnel, so remember it (across
	 * restarts, which is when the server has no browser to ask) and move any
	 * bot that is on a tunnel or polling over to it.
	 */
	rememberBrowserOrigin(origin: string | undefined): void {
		if (!origin || origin === this.browserOrigin) return;
		try {
			if (isLocalHostname(new URL(origin).hostname)) return;
		} catch {
			return;
		}
		this.browserOrigin = origin;
		void this.chat?.store.kvSet(KV_NAMESPACE, KV_BROWSER_ORIGIN, origin).catch(() => {});
		this.enqueue(() => this.reevaluateDelivery());
	}

	/**
	 * Where a link back into Clopen should point, or null when there is no
	 * address another device can open. Never starts a tunnel — a link in a
	 * notification is a convenience, not a reason to expose the server.
	 */
	publicOrigin(): string | null {
		const origin = findPublicOrigin(this.browserOrigin ?? undefined);
		return usableForWebhook(origin) ? origin.origin : null;
	}

	get(accountId: string): ActiveChannel | null {
		return this.active.get(accountId) ?? null;
	}

	status(accountId: string): ChannelStatus {
		const channel = this.active.get(accountId);
		const health = channel ? this.chat?.health(channel.platform.chatkit, accountId)[0] : undefined;
		return {
			running: Boolean(channel),
			mode: channel?.mode ?? null,
			originSource: channel?.origin?.source ?? null,
			connection: health?.state ?? null,
			error: this.failures.get(accountId) ?? null
		};
	}

	/** Deliver a verified webhook from the integration gateway to its bot. */
	async receiveWebhook(event: WebhookEvent): Promise<void> {
		const chat = this.chat;
		const channel = this.active.get(event.accountId);
		if (!chat || !channel) {
			debug.warn('chat-apps', `Dropping ${event.provider} delivery for an account with no running channel`);
			return;
		}
		const headers: Record<string, string> = {};
		event.headers.forEach((value, key) => {
			headers[key.toLowerCase()] = value;
		});
		await chat.receive(channel.platform.chatkit, event.accountId, { method: 'POST', headers, body: event.rawBody });
	}

	private dispatchInbound(message: UniversalMessage): void {
		const channel = this.active.get(message.address.account);
		if (!channel || !this.inboundHandler) return;
		void this.inboundHandler(message, channel).catch((error) => {
			debug.error('chat-apps', 'Handling an inbound channel message failed:', error);
		});
	}

	private require(accountId: string): { chat: ChatKit; channel: ActiveChannel } {
		const channel = this.active.get(accountId);
		if (!this.chat || !channel) throw new Error('That channel is not running');
		return { chat: this.chat, channel };
	}

	/**
	 * Read a file a chat sent out of ChatKit's media store — and drop it from
	 * there. ChatKit downloads every attachment as it arrives; whatever Clopen
	 * does not take out must not stay in memory for the life of the process.
	 */
	async takeMedia(url: string | undefined): Promise<InboundFile | null> {
		const store = this.chat?.media.store;
		const id = url && store ? store.idFromUrl(url) : null;
		if (!store || !id) return null;
		try {
			const stored = await store.get(id);
			return stored ? { data: stored.data, mime: stored.mime ?? null, filename: stored.filename ?? null } : null;
		} finally {
			await store.delete(id).catch(() => {});
		}
	}

	/** Send a file, inline when the platform can show it. */
	async sendFile(accountId: string, conversationId: string, file: ChannelFile, replyTo?: string | null): Promise<SendResult> {
		const { chat, channel } = this.require(accountId);
		return chat.send({
			to: { platform: channel.platform.chatkit, account: accountId, conversation_id: conversationId },
			...channel.platform.renderFile(file),
			...(replyTo ? { reply_to: replyTo } : {})
		});
	}

	async send(accountId: string, conversationId: string, card: ChannelCard, replyTo?: string | null): Promise<SendResult> {
		const { chat, channel } = this.require(accountId);
		return chat.send({
			to: { platform: channel.platform.chatkit, account: accountId, conversation_id: conversationId },
			...channel.platform.render(card),
			...(replyTo ? { reply_to: replyTo } : {})
		});
	}

	/**
	 * Send formatted output of any length: split into as many messages as the
	 * platform needs, cutting at paragraph or line boundaries with formatting
	 * intact on both sides. Buttons ride on the last message, and only the
	 * first replies to `replyTo` — the rest follow it.
	 */
	async sendLong(
		accountId: string,
		conversationId: string,
		runs: TextRun[],
		options: { buttons?: ChannelButton[][]; replyTo?: string | null } = {}
	): Promise<SendResult[]> {
		const { channel } = this.require(accountId);
		const chunks = splitRuns(runs, channel.platform.maxMessageLength);
		if (chunks.length === 0) chunks.push([{ text: ' ' }]);
		const results: SendResult[] = [];
		for (const [index, chunk] of chunks.entries()) {
			const last = index === chunks.length - 1;
			results.push(
				await this.send(
					accountId,
					conversationId,
					{ runs: chunk, ...(last && options.buttons ? { buttons: options.buttons } : {}) },
					index === 0 ? options.replyTo : null
				)
			);
		}
		return results;
	}

	/** Best effort: "typing…" while a turn the chat started is running. */
	async setTyping(accountId: string, conversationId: string): Promise<void> {
		const channel = this.active.get(accountId);
		if (!this.chat || !channel) return;
		await this.chat.setTyping(channel.platform.chatkit, accountId, conversationId, true);
	}

	/** Best effort: remove a message the bot sent (a progress line once the answer is in). */
	async deleteMessage(accountId: string, conversationId: string, platformMessageId: string): Promise<void> {
		try {
			const { chat, channel } = this.require(accountId);
			await chat.deleteMessage({
				address: { platform: channel.platform.chatkit, account: accountId, conversation_id: conversationId },
				platform_message_id: platformMessageId
			});
		} catch (error) {
			debug.log('chat-apps', 'Channel message delete skipped:', describe(error));
		}
	}

	/**
	 * Re-render a sent message. Never throws: an edit is cosmetic, and the
	 * common failures (the message was deleted, or its content is unchanged)
	 * must not abort whatever state change prompted it.
	 */
	async edit(accountId: string, conversationId: string, platformMessageId: string, card: ChannelCard): Promise<void> {
		try {
			const { chat, channel } = this.require(accountId);
			await chat.send({
				to: { platform: channel.platform.chatkit, account: accountId, conversation_id: conversationId },
				...channel.platform.renderEdit(platformMessageId, card)
			});
		} catch (error) {
			debug.log('chat-apps', 'Channel message edit skipped:', describe(error));
		}
	}

	/** The adapter behind a running channel — for pairing links and probes. */
	adapterFor(accountId: string) {
		const channel = this.active.get(accountId);
		return channel ? this.chat?.adapterFor(channel.platform.chatkit, accountId) ?? null : null;
	}
}

export const channelRuntime = new ChannelRuntime();
