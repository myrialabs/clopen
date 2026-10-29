/**
 * Telegram, through ChatKit's Bot API adapter.
 *
 * Buttons are inline keyboards; their `callback_data` holds at most 64 bytes,
 * which is why a button carries a prompt id and the meaning lives in
 * `channel_messages`. A message is re-rendered with `editMessageText`
 * carrying a fresh keyboard — an empty one removes the buttons once a question
 * is settled, so a stale tap has nothing to land on.
 */

import { TelegramAdapter } from '@myrialabs/chatkit/adapters';
import { telegramButtons, telegramEditMessage, type TelegramButton } from '@myrialabs/chatkit/interactive';
import { media, richText, type Adapter, type MediaType, type TextRun, type UniversalMessage } from '@myrialabs/chatkit';
import type { ChannelButton, ChannelCard, ChannelFile, ChannelPlatform, DeliveryMode } from './types';

/** Telegram caps a message at 4096 UTF-16 units. Callers split longer output; this is the last guard. */
const MAX_TEXT = 4096;
/** `getFile` refuses anything bigger: a bot never sees larger uploads. */
const MAX_INBOUND_FILE = 20 * 1024 * 1024;
/** A photo is recompressed and capped at 10 MB; anything else goes as a document. */
const MAX_PHOTO = 10 * 1024 * 1024;
/** Caption ceiling for any media message. */
const MAX_CAPTION = 1024;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Trim runs to Telegram's ceiling — only ever reached by a card nobody split. */
function clampRuns(runs: TextRun[]): TextRun[] {
	// An empty message is refused outright; a space is the smallest valid one.
	if (!runs.some((run) => run.text.length > 0)) return [{ text: ' ' }];
	let room = MAX_TEXT - 1;
	const out: TextRun[] = [];
	for (const run of runs) {
		if (room <= 0) break;
		if (run.text.length <= room) {
			out.push(run);
			room -= run.text.length;
		} else {
			out.push({ ...run, text: `${run.text.slice(0, room)}…` });
			room = 0;
		}
	}
	return out;
}

function plain(runs: TextRun[]): string {
	return runs.map((run) => run.text).join('') || ' ';
}

function toTelegramButton(button: ChannelButton): TelegramButton {
	return 'url' in button ? { text: button.label, url: button.url } : { text: button.label, data: button.data };
}

function rowsOf(card: ChannelCard): TelegramButton[][] {
	return (card.buttons ?? []).map((row) => row.map(toTelegramButton));
}

function asTelegram(adapter: Adapter): TelegramAdapter {
	if (!(adapter instanceof TelegramAdapter)) throw new Error('Not a Telegram adapter');
	return adapter;
}

/** `getMe` is cached per adapter: the username does not change while the token does not. */
const botInfo = new WeakMap<TelegramAdapter, Promise<{ username: string }>>();

function getBot(adapter: TelegramAdapter): Promise<{ username: string }> {
	let pending = botInfo.get(adapter);
	if (!pending) {
		pending = adapter.getMe();
		// A failed lookup must not be cached — the next call should try again.
		pending.catch(() => botInfo.delete(adapter));
		botInfo.set(adapter, pending);
	}
	return pending;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const telegramPlatform: ChannelPlatform = {
	provider: 'telegram',
	chatkit: 'telegram',
	deliveryModes: ['webhook', 'polling'],
	maxMessageLength: MAX_TEXT,
	maxInboundFileBytes: MAX_INBOUND_FILE,

	createAdapter({ account, credentials, mode }) {
		const token = credentials.botToken ?? '';
		// The integration gateway checks the secret header first (it is how it
		// knows WHICH bot sent a delivery), and ChatKit refuses any webhook its
		// adapter cannot verify itself. Both read the same generated secret, so
		// the two checks cannot disagree.
		return new TelegramAdapter({ token, account, polling: mode === 'polling', secretToken: credentials.webhookSecret || undefined });
	},

	async registerWebhook(adapter, url, secret) {
		await asTelegram(adapter).setWebhook({ url, secretToken: secret });
	},

	async unregisterWebhook(adapter) {
		await asTelegram(adapter).deleteWebhook();
	},

	async registerCommands(adapter, commands) {
		await asTelegram(adapter).setMyCommands(commands, {});
	},

	async clearCommands(adapter, conversationId) {
		await asTelegram(adapter).deleteMyCommands({ scope: { type: 'chat', chat_id: conversationId } });
	},

	render(card) {
		const runs = clampRuns(card.runs);
		if (!card.buttons?.length) return { content: richText(runs) };
		return telegramButtons(plain(runs), rowsOf(card), { rich: runs });
	},

	renderEdit(platformMessageId, card) {
		const runs = clampRuns(card.runs);
		return telegramEditMessage(platformMessageId, plain(runs), {
			rich: runs,
			...(card.buttons?.length ? { buttons: rowsOf(card) } : {})
		});
	},

	renderFile(file: ChannelFile) {
		// GIFs become silent videos as a photo; a document keeps them intact.
		const asPhoto = PHOTO_TYPES.has(file.mime) && file.data.byteLength <= MAX_PHOTO;
		const mediaType: MediaType = asPhoto ? 'image' : 'document';
		const caption = file.caption ? (file.caption.length > MAX_CAPTION ? `${file.caption.slice(0, MAX_CAPTION - 1)}…` : file.caption) : undefined;
		return { content: media({ mediaType, data: file.data, mime: file.mime, filename: file.filename, caption }) };
	},

	albumOf(message: UniversalMessage) {
		const raw = message.raw as { message?: { media_group_id?: string }; edited_message?: { media_group_id?: string } } | undefined;
		return raw?.message?.media_group_id ?? raw?.edited_message?.media_group_id ?? null;
	},

	async pairingLink(adapter, code) {
		const { username } = await getBot(asTelegram(adapter));
		return `https://t.me/${username}?start=${encodeURIComponent(code)}`;
	},

	async botName(adapter) {
		try {
			return `@${(await getBot(asTelegram(adapter))).username}`;
		} catch {
			return null;
		}
	},

	isDirect(message: UniversalMessage) {
		// In a private chat Telegram's chat id IS the user's id; in a group it is
		// the group's (negative) id. Reading the raw `chat.type` would say the
		// same thing, but this survives a callback whose raw shape differs.
		return message.from?.user_id != null && message.address.conversation_id === message.from.user_id;
	},

	parseCommand(input) {
		const match = /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(input.trim());
		if (!match) return null;
		return { command: match[1].toLowerCase(), argument: (match[2] ?? '').trim() };
	},

	async probe(adapter, mode: DeliveryMode) {
		const bot = asTelegram(adapter);
		let username: string;
		try {
			username = (await getBot(bot)).username;
		} catch (error) {
			const message = describeError(error);
			// 401 is the one answer that means "this token is wrong".
			return /\b401\b|Unauthorized/i.test(message)
				? { status: 'needs_auth', detail: 'Telegram rejected the bot token' }
				: { status: 'error', detail: message };
		}
		if (mode === 'polling') return { status: 'ok', detail: `@${username} · polling` };

		try {
			const info = await bot.getWebhookInfo();
			// Telegram keeps the last error for as long as it is the latest event,
			// so only a recent one says deliveries are failing NOW.
			const recentError = info.last_error_date && Date.now() / 1000 - info.last_error_date < 15 * 60;
			if (!info.url) return { status: 'error', detail: `@${username} · no webhook registered` };
			if (recentError) return { status: 'error', detail: `@${username} · Telegram cannot reach Clopen: ${info.last_error_message ?? 'delivery failed'}` };
			return { status: 'ok', detail: `@${username} · webhook` };
		} catch (error) {
			return { status: 'error', detail: describeError(error) };
		}
	}
};
