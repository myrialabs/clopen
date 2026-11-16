/**
 * What Clopen remembers beyond the current chat: earlier chats, the journal,
 * the owner's profile, and secrets.
 *
 * A chat with Clopen carries only a small context capsule; everything older is
 * read on demand through these actions, so a long relationship does not make
 * every turn longer.
 */

import { t } from 'elysia';
import { forgetSecretValues, scrubSecretFromChat } from '$backend/assistant/scrub';
import { journalQueries, normaliseSecretName, secretQueries, sessionQueries } from '$backend/database/queries';
import { ensureAssistantProject } from '$backend/assistant/project';
import { closeForRouting, recentExchanges } from '$backend/assistant/conversation';
import { formatJournal, journal } from '$backend/assistant/journal';
import { getProfile, PROFILE_MAX, saveProfile } from '$backend/assistant/profile';
import { notifyAssistantChanged } from '$backend/assistant/events';
import { defineAgentAction } from '../define';

export const chatHistory = defineAgentAction({
	id: 'chat.history',
	group: 'memory',
	title: 'Earlier chats with Clopen',
	description:
		'Your earlier chats with the owner, newest first: id, title, when. Read one with chat.read. Use it when the owner refers to something not in your context ("what we discussed last week").',
	args: t.Object({ limit: t.Optional(t.Number({ minimum: 1, maximum: 50 })) }),
	risk: 'read',
	scope: 'assistant',
	async run(_ctx, args) {
		const project = ensureAssistantProject();
		const sessions = sessionQueries
			.getByProjectId(project.id)
			.sort((a, b) => (b.last_message_at ?? b.started_at ?? '').localeCompare(a.last_message_at ?? a.started_at ?? ''))
			.slice(0, args.limit ?? 15);
		return {
			text:
				sessions.map((session) => `- ${session.id} · ${(session.last_message_at ?? session.started_at ?? '').slice(0, 16)} · ${session.title || session.head_title || '(untitled)'}`).join('\n') ||
				'No earlier chats.',
			data: { chats: sessions.map((session) => ({ id: session.id, title: session.title ?? session.head_title ?? null, at: session.last_message_at ?? session.started_at })) }
		};
	}
});

export const chatRead = defineAgentAction({
	id: 'chat.read',
	group: 'memory',
	title: 'Read an earlier chat',
	description: 'The last exchanges of one of your earlier chats with the owner (text only).',
	args: t.Object({ chatId: t.String({ minLength: 1 }), exchanges: t.Optional(t.Number({ minimum: 1, maximum: 60 })) }),
	risk: 'read',
	scope: 'assistant',
	async run(_ctx, args) {
		const exchanges = recentExchanges(args.chatId, args.exchanges ?? 20);
		return {
			text: exchanges.map((exchange) => `${exchange.role === 'owner' ? 'Owner' : 'Clopen'} (${exchange.at.slice(0, 16)}): ${exchange.text}`).join('\n\n') || '(empty)',
			data: { exchanges }
		};
	}
});

export const chatNewTopic = defineAgentAction({
	id: 'chat.new-topic',
	group: 'memory',
	title: 'Start the next message in a fresh chat',
	description:
		'Close this chat for new messages: the owner’s next message opens a fresh chat that carries a short summary of this one. Use it when the conversation has moved on and this history would only get in the way.',
	args: t.Object({}),
	risk: 'read',
	scope: 'assistant',
	async run(ctx) {
		if (!ctx.target.sessionId) throw new Error('There is no chat to close.');
		closeForRouting(ctx.target.sessionId);
		return { text: 'The next message starts a fresh chat.', data: { closed: ctx.target.sessionId } };
	}
});

export const journalSearch = defineAgentAction({
	id: 'journal.search',
	group: 'memory',
	title: 'Search the journal',
	description: 'What happened, in order: every exchange with the owner, task and automation result. Every word must match; no query gives the latest entries.',
	args: t.Object({ query: t.Optional(t.String()), limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })) }),
	risk: 'read',
	scope: 'assistant',
	async run(_ctx, args) {
		const entries = args.query ? journalQueries.search(args.query, args.limit ?? 30) : journalQueries.latest(args.limit ?? 30);
		return { text: formatJournal(entries) || 'Nothing found.', data: { entries } };
	}
});

export const profileUpdate = defineAgentAction({
	id: 'profile.update',
	group: 'memory',
	title: 'Update the owner’s profile',
	description: `Rewrite the short profile of the owner you see in every brief: name, language, work, accounts and tools they use, how they like answers. Send the whole new text (max ${PROFILE_MAX} characters); never put passwords or keys in it — those go to secret.save.`,
	args: t.Object({ text: t.String({ maxLength: PROFILE_MAX }) }),
	risk: 'write',
	scope: 'assistant',
	async run(_ctx, args) {
		const before = getProfile();
		const text = saveProfile(args.text);
		if (text !== before) journal('learned', 'Updated the owner’s profile');
		return { text: 'Profile updated.', data: { profile: text } };
	}
});

// ── Secrets ────────────────────────────────────────────────────────────────

export const secretList = defineAgentAction({
	id: 'secret.list',
	group: 'secret',
	title: 'List secrets',
	description: 'Saved secrets by name and description — never their values.',
	args: t.Object({}),
	risk: 'read',
	scope: 'any',
	async run() {
		const secrets = secretQueries.list();
		return {
			text: secrets.map((secret) => `- ${secret.name}${secret.description ? `: ${secret.description}` : ''}`).join('\n') || 'No secrets saved.',
			data: { secrets }
		};
	}
});

export const secretGet = defineAgentAction({
	id: 'secret.get',
	group: 'secret',
	title: 'Use a secret',
	description:
		'Whether a secret is saved, and how to use it without reading it: type it into a page with the browser type action `secret: "<name>"`, or put {{secret:<name>}} in a terminal.run command. Its value is never shown to you.',
	args: t.Object({ name: t.String({ minLength: 1 }) }),
	risk: 'read',
	scope: 'any',
	async run(_ctx, args) {
		const saved = secretQueries.get(args.name);
		if (!saved) throw new Error(`There is no secret "${args.name}". Ask the owner for it once and save it with secret.save.`);
		return {
			text: `"${saved.name}" is saved. Use it by name: browser type {secret: "${saved.name}"}, or {{secret:${saved.name}}} in a terminal.run command.`,
			data: { name: saved.name }
		};
	}
});

export const secretSave = defineAgentAction({
	id: 'secret.save',
	group: 'secret',
	title: 'Save a secret',
	description:
		'Keep a password, token or key the owner gave you, encrypted, under a clear name ("gmail-password", "openai-key"). Do this as soon as the owner shares one, then refer to it by name everywhere else (memory, scripts, briefs). Saving under an existing name replaces it.',
	args: t.Object({ name: t.String({ minLength: 1, maxLength: 80 }), value: t.String({ minLength: 1 }), description: t.Optional(t.String({ maxLength: 200 })) }),
	risk: 'write',
	scope: 'assistant',
	async run(ctx, args) {
		const secret = secretQueries.save({ name: args.name, value: args.value, description: args.description, createdBy: 'assistant' });
		forgetSecretValues();
		journal('secret', `Saved secret "${secret.name}"`);
		notifyAssistantChanged('secrets', secret.id);
		// Typed into the chat: it leaves the chat's history and the chat app now that the vault has it.
		const scrubbed = await scrubSecretFromChat(ctx.target.sessionId, args.value).catch(() => 0);
		// A card still waiting for this secret — or for anything, in the chat it was just typed into — is answered now.
		const { completeCard, openCardsFor } = await import('$backend/assistant/cards');
		const waitingFor = (data: Record<string, unknown>, card: { sessionId?: string | null }): boolean => {
			const target = (data.target ?? {}) as { type?: string; secret?: string; password?: string };
			const names = [target.secret, target.password].filter((name): name is string => typeof name === 'string').map(normaliseSecretName);
			if (names.includes(secret.name)) return true;
			return Boolean(scrubbed) && data.card === 'secret' && card.sessionId === ctx.target.sessionId;
		};
		for (const card of openCardsFor(waitingFor)) completeCard(card.id, 'Saved');
		return { text: `Saved secret "${secret.name}".${scrubbed ? ' It was removed from the chat.' : ''}`, data: { name: secret.name } };
	}
});

export const secretDelete = defineAgentAction({
	id: 'secret.delete',
	group: 'secret',
	title: 'Delete a secret',
	description: 'Delete a saved secret.',
	args: t.Object({ name: t.String({ minLength: 1 }) }),
	risk: 'irreversible',
	scope: 'assistant',
	async run(_ctx, args) {
		if (!secretQueries.delete(args.name)) throw new Error(`There is no secret "${args.name}".`);
		notifyAssistantChanged('secrets', args.name);
		return { text: `Deleted secret "${args.name}".`, data: { deleted: args.name } };
	}
});

export const MEMORY_ACTIONS = [chatHistory, chatRead, chatNewTopic, journalSearch, profileUpdate, secretList, secretGet, secretSave, secretDelete];
