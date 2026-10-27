/**
 * The per-platform contract of the chat-channel surface.
 *
 * ChatKit already makes sending, receiving, button presses, edits and rich
 * text universal, so what is left per platform is small and genuinely
 * platform-shaped: how a bot is built from a credential, how it is pointed at
 * a webhook, how a card with buttons is rendered and re-rendered, how long a
 * message may be, what a pairing link looks like, and how its command menu is
 * published. Everything else — what to send, when, and where an answer goes —
 * is Clopen's and lives once, above this line.
 *
 * Adding a platform (`Task 14`) is one file implementing this and one line in
 * `platforms/index.ts`. Anything that needs MORE than this is a gap in ChatKit,
 * not a reason to grow this interface.
 */

import type { Adapter, OutboundContent, PlatformId, TextRun, UniversalMessage } from '@myrialabs/chatkit';

/** A tappable control. `data` comes back as a postback; `url` opens a page. */
export type ChannelButton = { label: string; data: string } | { label: string; url: string };

/** A message as Clopen composes it: formatted runs plus optional rows of buttons. */
export interface ChannelCard {
	runs: TextRun[];
	buttons?: ChannelButton[][];
}

/** What `chat.send()` takes besides the address. */
export interface ChannelFragment {
	content: OutboundContent;
	platform_meta?: Record<string, unknown>;
}

export type DeliveryMode = 'webhook' | 'polling';

export interface ChannelHealth {
	status: 'ok' | 'needs_auth' | 'needs_config' | 'error';
	detail: string | null;
}

export interface ChannelCommand {
	command: string;
	description: string;
}

/** A file Clopen sends: bytes in hand, and what they are. */
export interface ChannelFile {
	data: Uint8Array;
	filename: string;
	mime: string;
	caption?: string;
}

export interface ChannelPlatform {
	/** Integration provider id — the account this platform's bots are stored under. */
	provider: string;
	/** The ChatKit platform its adapters register as. */
	chatkit: PlatformId;
	/** Which delivery modes the platform supports, in order of preference. */
	deliveryModes: DeliveryMode[];
	/** Longest message the platform accepts, in the unit it counts. Longer output is split. */
	maxMessageLength: number;
	/** Largest file a bot may download from a chat. Bigger ones never reach Clopen. */
	maxInboundFileBytes: number;

	/** Build an adapter for one account. `account` is the integration account id. */
	createAdapter(input: { account: string; credentials: Record<string, string>; mode: DeliveryMode }): Adapter;

	/**
	 * Point the bot at `url` (webhook mode), echoing `secret` back on every
	 * delivery. Throws when the platform refuses — the caller falls back to
	 * polling rather than leaving the bot deaf.
	 */
	registerWebhook(adapter: Adapter, url: string, secret: string): Promise<void>;
	/** Undo `registerWebhook`. Best effort: called on disconnect, and failure is not fatal. */
	unregisterWebhook(adapter: Adapter): Promise<void>;
	/**
	 * Publish the command menu — the bot's default one, or one chat's own when
	 * `conversationId` is given (an admin's chat lists more than a member's).
	 * Best effort: a platform without a menu ignores it.
	 */
	registerCommands(adapter: Adapter, commands: ChannelCommand[], conversationId?: string): Promise<void>;
	/** Drop a chat's own menu, so it falls back to the default. */
	clearCommands(adapter: Adapter, conversationId: string): Promise<void>;

	render(card: ChannelCard): ChannelFragment;
	/** Re-render a sent message in place — new text, new (or no) buttons. */
	renderEdit(platformMessageId: string, card: ChannelCard): ChannelFragment;
	/** A file: shown inline when the platform can (a photo), else as a document. */
	renderFile(file: ChannelFile): ChannelFragment;

	/**
	 * The album a message belongs to, when the platform sends several photos
	 * or files as separate messages that the user picked together. Null for a
	 * message on its own.
	 */
	albumOf(message: UniversalMessage): string | null;

	/** A link that opens a chat with the bot and hands it `code`. */
	pairingLink(adapter: Adapter, code: string): Promise<string>;
	/** The bot's display handle, for the settings UI. */
	botName(adapter: Adapter): Promise<string | null>;

	/** True for a one-to-one chat with the bot. Group chats are never paired. */
	isDirect(message: UniversalMessage): boolean;

	/**
	 * `/start <code>`-style commands, normalised: the command without its
	 * slash (and without a `@botname` suffix) and whatever followed it.
	 */
	parseCommand(text: string): { command: string; argument: string } | null;

	/** Live check of the credential and of webhook delivery. */
	probe(adapter: Adapter, mode: DeliveryMode): Promise<ChannelHealth>;
}
