/**
 * Chat apps — control Clopen from a chat app. Chat with any session (or with
 * none, from Home), reply to an earlier message to continue from that point,
 * edit a sent message like Edit Message, and drive the rest of Clopen through
 * the control catalog: sessions, files, skills, projects, models and engine
 * accounts. Questions and answers of the turns a chat starts come back to it
 * as part of the same conversation.
 *
 *   platforms/        per-platform shape (Telegram first; Task 14 adds the rest)
 *   runtime.ts        the one ChatKit, its adapters, webhook-or-polling delivery, menus
 *   media.ts          files and albums in, images of an answer out
 *   outbound.ts       what is sent, and keeping sent messages true
 *   turns.ts          turns a chat started: mapping, typing, progress
 *   inbound.ts        every inbound message, and the checks before each
 *   conversation.ts   the active target, sending, going back, menus, commands
 *   questions.ts      answering AskUserQuestion from a chat
 *   messages.ts       the wording, as pure functions
 *   pairing.ts        one-time codes binding a chat to Clopen
 *
 * A chat app is a CAPABILITY of a connected account (`control`), not a panel:
 * the bot token lives on its `integration_accounts` row like every other
 * credential. Pairing and what the chat is told about unprompted sit in
 * Settings → Chat Apps. WHAT the chat can do
 * is not here at all: it is the control catalog (`backend/control/`), shared
 * with every other remote surface.
 *
 * Importing this module wires the stream hooks and the webhook subscriber;
 * `startChatApps()` opens the bots.
 */

import type { AskUserQuestion } from '$shared/types/unified';
import {
	integrationAccountQueries,
	channelLinkQueries,
	type ChannelLinkRow
} from '$backend/database/queries';
import { onAccountsChanged, onWebhook, registerAccountProbe } from '$backend/integrations';
import { streamManager, type StreamEvent } from '$backend/chat/stream-manager';
import { debug } from '$shared/utils/logger';
import { channelRuntime } from './runtime';
import { listChannelPlatforms, getChannelPlatform } from './platforms';
import { announceQuestion, announceRunEnded, forgetSession, settleToolUses } from './outbound';
import { handleInboundMessage } from './inbound';
import { issuePairingCode, revokePairingCode, PAIRING_TTL_MS } from './pairing';
import { onToolActivity, onUserMessage } from './turns';
import { CHAT_COMMANDS, REPLIES, describeToolUse, textCard } from './messages';
import { commandReference, setPublicOriginResolver, type CommandEntry } from '$backend/control';
import type { ChannelCommand } from './platforms';
import { notifyLinksChanged } from './link-events';

export { registerComposer, onLinksChanged } from './inbound';

/** Told when a bot's running state may have changed, so Settings can refresh. */
export function onBotsChanged(listener: () => void): void {
	channelRuntime.onStatusChanged(listener);
}
export type { Composer } from './inbound';

// ── Wiring ──────────────────────────────────────────────────────────────────

/** Telegram's ceiling, and a sane one for any menu. */
const MAX_MENU_COMMANDS = 100;
const MAX_MENU_DESCRIPTION = 256;

/**
 * The `/` menu: EXACTLY what `/help` lists, in the same order — the chat's own
 * commands, then the catalog's. Generated, so a new catalog action shows up in
 * every chat app without touching this module.
 */
export function botCommands(): ChannelCommand[] {
	return commandReference(CHAT_COMMANDS)
		.slice(0, MAX_MENU_COMMANDS)
		.map((entry) => {
			const described = entry.hint ? `${entry.description} (${entry.hint})` : entry.description;
			return { command: entry.command, description: described.length > MAX_MENU_DESCRIPTION ? `${described.slice(0, MAX_MENU_DESCRIPTION - 1)}…` : described };
		});
}

channelRuntime.setInboundHandler(handleInboundMessage);
channelRuntime.setCommandMenu({
	commands: botCommands,
	chatsOf: (accountId) => channelLinkQueries.listByAccount(accountId).map((link) => link.conversation_id)
});
// Links in catalog results use the runtime's origin, which remembers the last
// real domain a browser used — better than a bare lookup.
setPublicOriginResolver(() => channelRuntime.publicOrigin());

for (const platform of listChannelPlatforms()) {
	onWebhook(platform.provider, (event) => channelRuntime.receiveWebhook(event));

	registerAccountProbe(platform.provider, async (accountId) => {
		const row = integrationAccountQueries.getById(accountId);
		if (!row) return null;
		if (!integrationAccountQueries.capabilitiesOf(row).includes('control')) {
			return { status: 'unknown', detail: '"Control Clopen" is switched off for this bot' };
		}
		const status = channelRuntime.status(accountId);
		const adapter = channelRuntime.adapterFor(accountId);
		if (!adapter || !status.mode) {
			return { status: 'error', detail: status.error ?? 'The bot is not running' };
		}
		const health = await platform.probe(adapter, status.mode);
		const via = status.mode === 'webhook' && status.originSource ? ` via ${status.originSource}` : '';
		return { status: health.status, detail: health.detail ? `${health.detail}${via}` : null };
	});
}

// Any account change may add, drop or rebuild a bot. Cheap when nothing moved:
// the runtime compares fingerprints before touching an adapter.
onAccountsChanged(() => {
	if (channelRuntime.isStarted) void channelRuntime.reconcile();
});

// Server-side stream events: these fire whether or not a browser is attached,
// which is exactly when a chat that started a turn still needs its answer.
streamManager.on('stream:message', (payload: {
	event: StreamEvent;
	projectId?: string;
	chatSessionId: string;
	requestedByUserId?: string;
}) => {
	if (!channelRuntime.isStarted || !payload.projectId) return;
	const message = payload.event.data?.message;
	const blocks: any[] = Array.isArray(message?.content) ? message.content : [];

	// A user message a chat sent: map it, and start that chat's live feedback.
	// Matched by the prompt's own id, so a photo with no caption counts too.
	if (message?.type === 'user' && typeof payload.event.data?.message_id === 'string' && typeof message.messageId === 'string' && !message.parent?.toolUseId) {
		onUserMessage(payload.chatSessionId, payload.event.data.message_id, message.messageId);
	}

	// What the turn is doing, for the progress line of a turn a chat started.
	for (const block of blocks) {
		if (block?.type === 'tool_use' && typeof block.name === 'string' && block.name !== 'AskUserQuestion') {
			onToolActivity(payload.chatSessionId, describeToolUse(block.name, block.input));
		}
	}

	const settled = blocks.filter((block) => block?.type === 'tool_result' && typeof block.toolUseId === 'string').map((block) => block.toolUseId as string);
	if (settled.length > 0) void settleToolUses(settled).catch((error) => debug.warn('chat-apps', 'Settling channel questions failed:', error));

	const ask = blocks.find((block) => block?.type === 'tool_use' && block.name === 'AskUserQuestion');
	if (ask && Array.isArray(ask.input?.questions)) {
		void announceQuestion({
			projectId: payload.projectId,
			chatSessionId: payload.chatSessionId,
			toolUseId: ask.id,
			questions: ask.input.questions as AskUserQuestion[]
		}).catch((error) => debug.warn('chat-apps', 'Announcing a channel question failed:', error));
	}
});

streamManager.on('stream:lifecycle', (event: {
	status: 'completed' | 'error' | 'cancelled';
	projectId?: string;
	chatSessionId?: string;
	reason?: string;
}) => {
	if (!channelRuntime.isStarted || !event.projectId || !event.chatSessionId) return;
	void announceRunEnded({
		status: event.status,
		projectId: event.projectId,
		chatSessionId: event.chatSessionId,
		reason: event.reason
	}).catch((error) => debug.warn('chat-apps', 'Announcing a finished run failed:', error));
});

streamManager.on('session:cleanup', (chatSessionId: string) => {
	try {
		forgetSession(chatSessionId);
	} catch (error) {
		debug.warn('chat-apps', 'Dropping channel prompts for a deleted session failed:', error);
	}
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

export async function startChatApps(): Promise<void> {
	try {
		await channelRuntime.start();
	} catch (error) {
		// A chat app failing to open must never keep Clopen from starting.
		debug.error('chat-apps', 'Chat apps failed to start:', error);
	}
}

export async function stopChatApps(): Promise<void> {
	await channelRuntime.stop();
}

// ── What Settings → Chat Apps shows and does ────────────────────────────────

export interface ChannelLinkInfo {
	id: string;
	/** The chat's name on the platform. */
	displayName: string | null;
	/** Off: the chat can do nothing at all until it is switched back on. */
	isEnabled: boolean;
	createdAt: string;
	lastUsedAt: string | null;
}

export interface ChannelBotInfo {
	accountId: string;
	provider: string;
	label: string;
	botName: string | null;
	projectId: string | null;
	running: boolean;
	mode: 'webhook' | 'polling' | null;
	originSource: 'configured' | 'domain' | 'tunnel' | null;
	/** Whether the bot is actually reaching the platform right now. */
	connection: 'connecting' | 'open' | 'closed' | null;
	error: string | null;
	/** "Control Clopen" is on for this bot; without it a chat cannot drive anything. */
	control: boolean;
	/** The chats paired through this bot. */
	links: ChannelLinkInfo[];
}

function toLinkInfo(row: ChannelLinkRow): ChannelLinkInfo {
	return {
		id: row.id,
		displayName: row.display_name,
		isEnabled: row.is_enabled === 1,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at
	};
}

/** Every bot a chat can pair with, and the chats paired through it. */
export async function listChannelBots(requestOrigin?: string): Promise<ChannelBotInfo[]> {
	channelRuntime.rememberBrowserOrigin(requestOrigin);
	const bots: ChannelBotInfo[] = [];
	for (const row of integrationAccountQueries.getAll()) {
		const platform = getChannelPlatform(row.provider);
		if (!platform || row.is_enabled !== 1) continue;
		const capabilities = integrationAccountQueries.capabilitiesOf(row);
		const status = channelRuntime.status(row.id);
		const adapter = channelRuntime.adapterFor(row.id);
		const links = channelLinkQueries.listByAccount(row.id);
		bots.push({
			accountId: row.id,
			provider: row.provider,
			label: row.label,
			botName: adapter ? await platform.botName(adapter) : null,
			projectId: row.project_id,
			running: status.running,
			mode: status.mode,
			originSource: status.originSource,
			connection: status.connection,
			error: status.error,
			control: capabilities.includes('control'),
			links: links.map(toLinkInfo)
		});
	}
	return bots;
}

export async function createPairingLink(userId: string, accountId: string): Promise<{ url: string; expiresAt: string; ttlSeconds: number }> {
	const row = integrationAccountQueries.getById(accountId);
	const platform = row ? getChannelPlatform(row.provider) : null;
	const adapter = channelRuntime.adapterFor(accountId);
	if (!row || !platform || !adapter) throw new Error('That bot is not running. Check it in Settings → Integrations.');
	const { code, expiresAt } = issuePairingCode(userId, accountId);
	return { url: await platform.pairingLink(adapter, code), expiresAt, ttlSeconds: Math.round(PAIRING_TTL_MS / 1000) };
}

/** Close the pairing link the user was shown: scanning it afterwards does nothing. */
export function cancelPairingLink(userId: string, accountId: string): void {
	revokePairingCode(userId, accountId);
}

function requireLink(linkId: string): ChannelLinkRow {
	const link = channelLinkQueries.getById(linkId);
	if (!link) throw new Error('Linked chat not found');
	return link;
}

export async function setChannelLinkEnabled(linkId: string, enabled: boolean): Promise<void> {
	const link = requireLink(linkId);
	channelLinkQueries.setEnabled(linkId, enabled);
	// Switched off or back on from Clopen: the chat should know why it went quiet.
	if (enabled !== (link.is_enabled === 1)) {
		await channelRuntime.send(link.account_id, link.conversation_id, textCard(enabled ? REPLIES.chatOn : REPLIES.chatOff)).catch(() => {});
	}
	notifyLinksChanged();
}

export async function removeChannelLink(linkId: string): Promise<void> {
	const link = requireLink(linkId);
	channelLinkQueries.remove(linkId);
	// Tell the chat, so it does not keep waiting for messages that will never come.
	await channelRuntime.send(link.account_id, link.conversation_id, textCard(REPLIES.unlinked)).catch(() => {});
	notifyLinksChanged();
}

export async function sendChannelTest(linkId: string): Promise<void> {
	const link = requireLink(linkId);
	await channelRuntime.send(link.account_id, link.conversation_id, textCard(REPLIES.testMessage));
	channelLinkQueries.touch(linkId);
}

export type ChatAppCommandInfo = CommandEntry;

/** The command reference Settings shows — the same list `/help` and the `/` menu are. */
export function listChatAppCommands(): ChatAppCommandInfo[] {
	return commandReference(CHAT_COMMANDS);
}
