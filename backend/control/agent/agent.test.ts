/**
 * The agent control surface's own rules: a well-formed, unique catalog with a
 * risk for every action, the project-safe subset an agent in a project gets,
 * and references between batch steps.
 */

import { describe, expect, it } from 'bun:test';
import { AGENT_ACTIONS, describeAgentActions, getAgentAction, resolveRefs } from './index';
import { riskOf } from './define';
import { CONTROL_ACTIONS } from '../index';

describe('the agent catalog', () => {
	it('has unique, well-formed ids that never collide with chat commands', () => {
		const ids = AGENT_ACTIONS.map((action) => action.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const action of AGENT_ACTIONS) {
			expect(action.id).toMatch(/^[a-z]+\.[a-z][a-z-]*$/);
			expect(action.command).toBeUndefined();
		}
		const chatIds = new Set(CONTROL_ACTIONS.map((action) => action.id));
		for (const id of ids) expect(chatIds.has(id)).toBe(false);
	});

	it('gives every action a risk and a scope', () => {
		for (const action of AGENT_ACTIONS) {
			expect(['assistant', 'any']).toContain(action.scope);
			expect(typeof action.risk === 'function' || ['read', 'write', 'irreversible'].includes(action.risk as string)).toBe(true);
		}
	});

	it('offers project agents only what cannot steer Clopen itself', () => {
		const projectSafe = AGENT_ACTIONS.filter((action) => action.scope === 'any').map((action) => action.id).sort();
		expect(projectSafe).toEqual(['db.connections', 'db.describe', 'db.query', 'db.schema', 'owner.ask', 'owner.send', 'script.list', 'script.run', 'secret.get', 'secret.list', 'share.link', 'skill.get', 'skill.list'].sort());
		for (const id of ['task.delegate', 'flow.create', 'api.call', 'terminal.run', 'skill.save']) {
			expect(getAgentAction(id)?.scope).toBe('assistant');
		}
	});

	it('gives Clopen nothing that changes a project — that is delegated', () => {
		for (const id of ['files.write', 'git.commit', 'git.branch', 'git.push', 'task.create', 'task.dispatch', 'task.complete']) {
			expect(getAgentAction(id)).toBeNull();
		}
		const call = getAgentAction('api.call')!;
		expect(() => call.validate?.({ route: 'files:write-file', data: {} })).toThrow(/delegated/);
		expect(() => call.validate?.({ route: 'git:commit', data: {} })).toThrow(/delegated/);
		expect(() => call.validate?.({ route: 'git:status', data: {} })).not.toThrow();
	});

	it('routes what cannot be undone through approval', () => {
		expect(riskOf(getAgentAction('terminal.run')!, { command: 'git push --force' })).toBe('irreversible');
		expect(riskOf(getAgentAction('terminal.run')!, { command: 'bun test' })).toBe('write');
		expect(riskOf(getAgentAction('api.call')!, { route: 'projects:delete' })).toBe('irreversible');
		expect(riskOf(getAgentAction('api.call')!, { route: 'git:status' })).toBe('read');
		expect(getAgentAction('flow.delete')?.risk).toBe('irreversible');
	});

	it('describes itself for the tool description', () => {
		const described = describeAgentActions();
		expect(described.length).toBe(AGENT_ACTIONS.length);
		const delegate = described.find((entry) => entry.id === 'task.delegate')!;
		expect(delegate.args).toBe('{ goal, detail?, project?, recipe?, continues? }');
	});
});

describe('references between steps', () => {
	const results = new Map<string, unknown>([
		['0', { missionId: 'm-1', nested: { list: ['a'] } }],
		['mission', { missionId: 'm-1' }],
		['project', { projectId: 'p-9' }]
	]);

	it('keeps the type of a whole-string reference', () => {
		expect(resolveRefs('$mission.missionId', results)).toBe('m-1');
		expect(resolveRefs('$0.nested', results)).toEqual({ list: ['a'] });
	});

	it('interpolates references inside text', () => {
		expect(resolveRefs('Mission $mission.missionId in $project.projectId', results)).toBe('Mission m-1 in p-9');
	});

	it('walks arrays and objects', () => {
		expect(resolveRefs({ ids: ['$mission.missionId'], deep: { p: '$project.projectId' } }, results)).toEqual({ ids: ['m-1'], deep: { p: 'p-9' } });
	});

	it('fails clearly on a step that has not run', () => {
		expect(() => resolveRefs('$later.id', results)).toThrow(/has not run/);
	});

	it('leaves ordinary dollar signs alone', () => {
		expect(resolveRefs('costs $5 per month', results)).toBe('costs $5 per month');
	});
});
