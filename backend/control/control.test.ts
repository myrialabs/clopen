/**
 * The control catalog's own rules — the things every surface generated from
 * it relies on: unique ids and commands, argument parsing and validation,
 * help and descriptions filtered by role, and in-process route calls that go
 * through the same auth gate a browser does.
 */

import { describe, it, expect } from 'bun:test';
import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import {
	CONTROL_ACTIONS,
	checkArgs,
	commandReference,
	commandsFor,
	controlActionForCommand,
	controlHelp,
	describeControlActions,
	getControlAction,
	matchSkill,
	parseCommandArgument
} from './index';
import { defineAction } from './define';
import { botCommands } from '$backend/chat-apps';
import { CHAT_COMMANDS } from '$backend/chat-apps/messages';

const admin = { role: 'admin' as const };
const member = { role: 'member' as const };

describe('the catalog', () => {
	it('has unique ids and commands, all well-formed', () => {
		const ids = CONTROL_ACTIONS.map((action) => action.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const action of CONTROL_ACTIONS) {
			expect(action.id).toMatch(/^[a-z]+\.[a-z][a-z-]*$/);
			if (action.command) expect(controlActionForCommand(action.command.name)).toBe(action);
		}
	});

	it('every choice an action can offer names an action that exists', () => {
		const referenced = [
			'projects.open', 'projects.list', 'sessions.open', 'sessions.list', 'sessions.search', 'sessions.unqueue', 'files.get',
			'models.list', 'models.set', 'models.set-reasoning', 'accounts.list', 'accounts.switch', 'skills.run', 'projects.browse', 'projects.create'
		];
		expect(referenced.every((id) => getControlAction(id))).toBe(true);
		for (const id of referenced) expect(getControlAction(id)).not.toBeNull();
	});

	it("keeps admin-only actions out of a member's commands and help", () => {
		const memberCommands = commandsFor(member).map((action) => action.command!.name);
		expect(memberCommands).toContain('model');
		expect(memberCommands).not.toContain('newproject');
		expect(memberCommands).not.toContain('accounts');
		expect(controlHelp(member)).not.toContain('/accounts');
		expect(controlHelp(admin)).toContain('/accounts');
		expect(describeControlActions(member).some((action) => action.access === 'admin')).toBe(false);
	});

	it('offers nothing a person would not do in the web UI: no raw routes, no secrets typed into a chat', () => {
		const names = commandsFor(admin).map((action) => action.command!.name);
		for (const gone of ['api', 'routes', 'addaccount', 'models', 'deletesession', 'update', 'system', 'mcp', 'rename', 'profile', 'notify', 'whoami']) {
			expect(names).not.toContain(gone);
		}
		expect(names).toContain('delete');
	});

	it('keeps one command namespace: no catalog command shadows the chat’s own, Telegram’s, or a button prefix', () => {
		const own = [...CHAT_COMMANDS.map((entry) => entry.command), 'start'];
		const catalog = CONTROL_ACTIONS.flatMap((action) => (action.command ? [action.command.name] : []));
		for (const name of catalog) expect(own).not.toContain(name);
		expect(new Set([...own, ...catalog]).size).toBe(own.length + catalog.length);
		expect(catalog).not.toContain('settings');
		expect(() => defineAction({ id: 'chat.thing', group: 'sessions', title: 't', description: 'd', access: 'member', args: t.Object({}), async run() { return { text: '' }; } })).toThrow(/chat\./);
	});

	it('runs skills through /run, never as /<skill-name>', () => {
		expect(controlActionForCommand('run')?.id).toBe('skills.run');
		expect(controlActionForCommand('skills')?.id).toBe('skills.list');
		const skills = [
			{ slug: 'new', name: 'New', description: 'd', argumentHint: null },
			{ slug: 'review-pr', name: 'Review', description: 'd', argumentHint: '<number>' },
			{ slug: 'review-docs', name: 'Docs', description: 'd', argumentHint: null }
		];
		// A skill named like a command is reached by /run, not shadowed by /new.
		expect(matchSkill(skills, 'new').skill?.slug).toBe('new');
		// However it is typed: dashes, underscores, spaces, a leading slash, any case.
		for (const typed of ['review-pr', 'Review_PR', '/review-pr', 'review pr']) expect(matchSkill(skills, typed).skill?.slug).toBe('review-pr');
		// An unambiguous start is enough; an ambiguous one offers the candidates.
		expect(matchSkill(skills, 'review-p').skill?.slug).toBe('review-pr');
		const ambiguous = matchSkill(skills, 'review');
		expect(ambiguous.skill).toBeNull();
		expect(ambiguous.similar.map((skill) => skill.slug)).toEqual(['review-pr', 'review-docs']);
		expect(matchSkill(skills, 'zzz')).toEqual({ skill: null, similar: [] });
	});

	it('publishes a command menu every chat app accepts', () => {
		for (const role of ['admin', 'member'] as const) {
			const commands = botCommands(role);
			expect(commands.length).toBeLessThanOrEqual(100);
			for (const command of commands) {
				expect(command.command).toMatch(/^[a-z0-9_]{1,32}$/);
				expect(command.description.length).toBeGreaterThan(0);
				expect(command.description.length).toBeLessThanOrEqual(256);
			}
			expect(new Set(commands.map((command) => command.command)).size).toBe(commands.length);
		}
	});

	it('the menu, /help and the Settings reference list the same commands in the same order', () => {
		for (const user of [admin, member]) {
			const reference = commandReference(user, CHAT_COMMANDS).map((entry) => entry.command);
			expect(botCommands(user.role).map((command) => command.command)).toEqual(reference);
			const help = controlHelp(user, CHAT_COMMANDS);
			const inHelp = [...help.matchAll(/^\/([a-z0-9_]+)/gm)].map((match) => match[1]);
			expect(inHelp).toEqual(reference);
		}
	});

	it("never offers a member an admin-only command in the menu", () => {
		const memberMenu = botCommands('member').map((command) => command.command);
		for (const action of CONTROL_ACTIONS.filter((entry) => entry.access === 'admin' && entry.command)) {
			expect(memberMenu).not.toContain(action.command!.name);
		}
		expect(botCommands('admin').map((command) => command.command)).toContain('accounts');
	});
});

describe('arguments', () => {
	it('one key takes the whole text', () => {
		expect(parseCommandArgument(getControlAction('sessions.search')!, '  login bug  ')).toEqual({ query: 'login bug' });
	});

	it('several keys take a word each, the last taking the rest', () => {
		expect(parseCommandArgument(getControlAction('models.engines')!, 'claude')).toEqual({ engine: 'claude' });
		expect(parseCommandArgument(getControlAction('models.engines')!, 'opencode free gpt')).toEqual({ engine: 'opencode', query: 'free gpt' });
	});

	it('are validated, with the usage in the error', () => {
		expect(() => checkArgs(getControlAction('sessions.search')!, {})).toThrow(/Usage: \/search/);
		expect(checkArgs(getControlAction('accounts.switch')!, { engine: 'codex', accountId: '3' })).toEqual({ engine: 'codex', accountId: 3 });
	});

	it('destructive actions ask first', () => {
		for (const id of ['sessions.delete']) expect(getControlAction(id)?.confirm).toBeDefined();
	});
});

describe('in-process route calls', () => {
	const router = createRouter()
		.http('test:echo', { data: t.Object({ value: t.Number() }), response: t.Object({ value: t.Number(), userId: t.String() }) }, async ({ data, conn }) => ({
			value: data.value,
			userId: ws.getUserId(conn)
		}))
		.http('test:admin', { data: t.Object({}), response: t.Object({ ok: t.Boolean() }) }, async () => ({ ok: true }));
	router.setAuthMiddleware(async (conn, action) =>
		action === 'test:admin' && ws.getRole(conn) !== 'admin' ? { allowed: false, error: 'Admin access required' } : { allowed: true }
	);

	async function as(role: 'admin' | 'member', action: string, data: unknown) {
		const conn = ws.openVirtualConnection({ userId: 'u-1', role, projectId: 'p-1' });
		try {
			return await router.invoke(conn, action, data);
		} finally {
			ws.closeVirtualConnection(conn);
		}
	}

	it('runs the handler as the virtual user and returns its result', async () => {
		expect(await as('member', 'test:echo', { value: 7 })).toEqual({ value: 7, userId: 'u-1' });
	});

	it('goes through the auth gate and the request schema', async () => {
		await expect(as('member', 'test:admin', {})).rejects.toThrow('Admin access required');
		expect(await as('admin', 'test:admin', {})).toEqual({ ok: true });
		await expect(as('member', 'test:echo', { value: 'x' })).rejects.toThrow(/validation failed/);
		await expect(as('member', 'test:missing', {})).rejects.toThrow(/Unknown action/);
	});

	it('a virtual connection is never online', () => {
		const before = ws.getConnections().length;
		const conn = ws.openVirtualConnection({ userId: 'u-1', role: 'member' });
		expect(ws.isVirtual(conn)).toBe(true);
		expect(ws.getConnections().length).toBe(before);
		ws.closeVirtualConnection(conn);
		expect(ws.isVirtual(conn)).toBe(false);
	});
});
