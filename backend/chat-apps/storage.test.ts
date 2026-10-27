/**
 * The account, gateway, storage and Home rules the channel depends on —
 * everything that decides WHO a message is from and WHERE an answer may go,
 * exercised against the real schema rather than a fake.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';

import { initializeDatabase, closeDatabase } from '$backend/database';
import {
	authQueries,
	channelMessageQueries,
	integrationAccountQueries,
	channelLinkQueries,
	projectQueries
} from '$backend/database/queries';
import { integrationAccounts } from '$backend/integrations/accounts';
import { handleInboundDelivery, onWebhook, type WebhookEvent } from '$backend/integrations/webhooks/gateway';
import { ensureHomeProject } from '$backend/projects/home';
import { assignProjectToUser } from '$backend/auth/auth-service';

const userA = `channel-test-a-${randomUUID()}`;
const userB = `channel-test-b-${randomUUID()}`;
const delivered: WebhookEvent[] = [];

function createUser(id: string): void {
	authQueries.createUser({
		id,
		name: id,
		color: '#000000',
		avatar: 'CT',
		role: 'member',
		personal_access_token_hash: `hash-${randomUUID()}`,
		created_at: new Date().toISOString()
	});
}

function clearAccounts(): void {
	for (const account of integrationAccountQueries.getAll()) integrationAccountQueries.remove(account.id);
}

function connectBot(label: string) {
	return integrationAccounts.connect({ provider: 'telegram', label, credentials: { botToken: `123:${label}` } });
}

function secretOf(accountId: string): string {
	return integrationAccountQueries.credentialsOf(integrationAccountQueries.getById(accountId)!).webhookSecret ?? '';
}

function linkFor(accountId: string, userId: string, conversationId: string, status: 'pending' | 'approved' = 'approved') {
	return channelLinkQueries.upsert({ accountId, userId, conversationId, platformUserId: conversationId, displayName: null, status });
}

function questionRow(linkId: string) {
	return channelMessageQueries.create({
		linkId,
		kind: 'question',
		projectId: 'p',
		chatSessionId: 's',
		toolUseId: 't',
		questionIndex: 0,
		platformMessageId: '10',
		payload: {}
	});
}

beforeAll(async () => {
	await initializeDatabase();
	createUser(userA);
	createUser(userB);
	onWebhook('telegram', (event) => void delivered.push(event));
});

beforeEach(() => {
	clearAccounts();
	delivered.length = 0;
});

afterAll(() => {
	clearAccounts();
	authQueries.deleteUser(userA);
	authQueries.deleteUser(userB);
	closeDatabase();
});

describe('a Telegram account', () => {
	it('offers the single control capability, and gets a generated webhook secret the hub never reports', () => {
		const account = connectBot('Bot');
		expect(account.capabilities).toEqual(['control']);
		expect(secretOf(account.id)).toMatch(/^[A-Za-z0-9_-]{40,}$/);
		expect(account.configuredFields).toEqual(['botToken']);
	});

	it('keeps its secret when the token changes, and ignores a client trying to set it', () => {
		const account = connectBot('Bot');
		const before = secretOf(account.id);
		integrationAccounts.updateCredentials(account.id, { botToken: '123:new', webhookSecret: 'chosen-by-client' });
		expect(secretOf(account.id)).toBe(before);
	});

	it('ignores a secret supplied at connect time', () => {
		const account = integrationAccounts.connect({ provider: 'telegram', label: 'Bot', credentials: { botToken: '1:a', webhookSecret: 'mine' } });
		expect(secretOf(account.id)).not.toBe('mine');
	});
});

describe('the webhook gateway', () => {
	const withSecret = (secret: string) => new Headers({ 'x-telegram-bot-api-secret-token': secret });
	const body = (updateId: number) => new TextEncoder().encode(`{"update_id":${updateId}}`);

	it('routes a delivery to the bot whose secret it carries', async () => {
		connectBot('First');
		const second = connectBot('Second');
		const response = await handleInboundDelivery('telegram', body(Date.now()), withSecret(secretOf(second.id)));
		expect(response.status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(delivered.map((event) => event.accountId)).toEqual([second.id]);
	});

	it('answers 404 for a wrong secret, and for a bot with control switched off', async () => {
		const account = connectBot('On');
		expect((await handleInboundDelivery('telegram', body(Date.now() + 1), withSecret('nope'))).status).toBe(404);
		expect((await handleInboundDelivery('telegram', body(Date.now() + 2), withSecret(secretOf(account.id)))).status).toBe(200);

		integrationAccounts.setCapabilities(account.id, []);
		expect((await handleInboundDelivery('telegram', body(Date.now() + 3), withSecret(secretOf(account.id)))).status).toBe(404);
	});
});

describe('links and channel messages', () => {
	it('re-pairing a chat to another user closes what the old owner could still act on, and forgets where it was', () => {
		const account = connectBot('Bot');
		const link = linkFor(account.id, userA, '777');
		channelLinkQueries.setActive(link.id, 'some-project', 'some-session');
		const row = questionRow(link.id);

		const moved = linkFor(account.id, userB, '777');
		expect(moved.id).toBe(link.id);
		expect(moved.user_id).toBe(userB);
		expect(moved.active_project_id).toBeNull();
		expect(moved.active_session_id).toBeNull();
		expect(channelMessageQueries.getById(row.id)?.state).toBe('closed');
	});

	it('a member chat waits for approval, can be switched off, and keeps its approval when its owner re-pairs', () => {
		const account = connectBot('Bot');
		const pending = linkFor(account.id, userA, '42', 'pending');
		expect(pending.status).toBe('pending');
		expect(channelLinkQueries.isActive(pending)).toBe(false);

		channelLinkQueries.approve(pending.id);
		const approved = channelLinkQueries.getById(pending.id)!;
		expect(channelLinkQueries.isActive(approved)).toBe(true);

		channelLinkQueries.setEnabled(pending.id, false);
		expect(channelLinkQueries.isActive(channelLinkQueries.getById(pending.id)!)).toBe(false);

		// The same person re-pairing keeps their approval and is switched back on.
		const again = linkFor(account.id, userA, '42', 'pending');
		expect(again.status).toBe('approved');
		expect(again.is_enabled).toBe(1);

		// Someone else taking the chat over starts from what they are entitled to.
		expect(linkFor(account.id, userB, '42', 'pending').status).toBe('pending');
	});

	it('a question settles exactly once', () => {
		const account = connectBot('Bot');
		const link = linkFor(account.id, userA, '1');
		const row = questionRow(link.id);
		expect(channelMessageQueries.settle(row.id, 'answered')).toBe(true);
		expect(channelMessageQueries.settle(row.id, 'closed')).toBe(false);
		expect(channelMessageQueries.openQuestionsForLink(link.id)).toEqual([]);
	});

	it('a reply finds the newest row for a message, and an edit finds the user message it maps to', () => {
		const account = connectBot('Bot');
		const link = linkFor(account.id, userA, '1');
		channelMessageQueries.create({ linkId: link.id, kind: 'answer', chatSessionId: 's', clopenMessageId: 'old', platformMessageId: '50' });
		channelMessageQueries.create({ linkId: link.id, kind: 'user', chatSessionId: 's', clopenMessageId: 'u1', platformMessageId: '50' });
		expect(channelMessageQueries.getByMessage(link.id, '50')?.kind).toBe('user');
		expect(channelMessageQueries.getUserMessage(link.id, 'u1')?.platform_message_id).toBe('50');
	});

	it('forgetting a session clears it as the active one everywhere', () => {
		const account = connectBot('Bot');
		const link = linkFor(account.id, userA, '1');
		channelLinkQueries.setActive(link.id, 'p', 'gone');
		channelLinkQueries.clearActiveSession('gone');
		expect(channelLinkQueries.getById(link.id)?.active_session_id).toBeNull();
		expect(channelLinkQueries.getById(link.id)?.active_project_id).toBe('p');
	});

	it('disconnecting the bot removes its links and their messages', () => {
		const account = connectBot('Bot');
		const link = linkFor(account.id, userA, '1');
		const row = questionRow(link.id);
		integrationAccounts.disconnect(account.id);
		expect(channelLinkQueries.getById(link.id)).toBeNull();
		expect(channelMessageQueries.getById(row.id)).toBeNull();
	});
});

describe('Home', () => {
	it('is one per user, on disk, and theirs alone', () => {
		const first = ensureHomeProject(userA);
		const again = ensureHomeProject(userA);
		const other = ensureHomeProject(userB);
		expect(again.id).toBe(first.id);
		expect(other.id).not.toBe(first.id);
		expect(first.kind).toBe('home');
		expect(first.owner_user_id).toBe(userA);
		expect(existsSync(first.path)).toBe(true);
		expect(projectQueries.userHasProject(userA, first.id)).toBe(true);
		expect(projectQueries.userHasProject(userB, first.id)).toBe(false);
	});

	it('cannot be shared with another user', () => {
		const home = ensureHomeProject(userA);
		expect(() => assignProjectToUser(userB, home.id)).toThrow(/cannot be shared/);
	});
});
