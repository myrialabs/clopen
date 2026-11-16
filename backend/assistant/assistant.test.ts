/**
 * Pure pieces of the assistant: how a stalled mission is recognised, how a
 * watched target is compared, and which model a new user (and Clopen itself)
 * starts on.
 */

import { describe, expect, it } from 'bun:test';
import { turnSignature } from './missions';
import { changeContext } from '$backend/jobs/watch';
import { pickDefaultModel, isFreeModel } from '$shared/constants/engines';
import type { EngineModel } from '$shared/types/unified';

describe('turnSignature', () => {
	it('counts any changed file as progress', () => {
		expect(turnSignature({ files: [{ path: 'a.ts', status: 'modified' }], answer: 'done', error: null })).toBeNull();
	});

	it('treats the same answer with no changes as the same turn', () => {
		const a = turnSignature({ files: [], answer: 'I could not find the file.', error: null });
		const b = turnSignature({ files: [], answer: 'I  could not find the file.', error: null });
		expect(a).not.toBeNull();
		expect(a).toBe(b);
	});

	it('ignores commit hashes and ids that differ between otherwise identical failures', () => {
		const a = turnSignature({ files: [], answer: '', error: 'Build failed at 3f9a1c2d' });
		const b = turnSignature({ files: [], answer: '', error: 'Build failed at 77be0aa1' });
		expect(a).toBe(b);
	});

	it('tells different answers apart', () => {
		expect(turnSignature({ files: [], answer: 'Step one', error: null })).not.toBe(turnSignature({ files: [], answer: 'Step two', error: null }));
	});
});

describe('changeContext', () => {
	const now = { fingerprint: '200:abc', summary: 'https://x answered 200', excerpt: 'Hello' };

	it('records a baseline without reporting a change', () => {
		expect(changeContext(null, now)).toBeNull();
	});

	it('stays quiet while nothing changed', () => {
		expect(changeContext(JSON.stringify({ fingerprint: '200:abc' }), now)).toBeNull();
	});

	it('reports a change with what it looks like now', () => {
		const context = changeContext(JSON.stringify({ fingerprint: '200:old' }), now);
		expect(context).toContain('answered 200');
		expect(context).toContain('Hello');
	});
});

function model(id: string, options: { tools?: boolean; cost?: number; reasoning?: boolean; image?: boolean; context?: number }): EngineModel {
	return {
		engine: { type: 'opencode', provider: 'opencode', model: { id, name: id }, account: { id: 0, name: '' } },
		limit: { input: options.context ?? 100_000, output: 8_000 },
		modalities: {
			input: { text: true, image: options.image ?? false, audio: false, video: false, pdf: false },
			output: { text: true, image: false, audio: false, video: false, pdf: false }
		},
		capabilities: { reasoning: options.reasoning ?? false, tools: options.tools ?? true, structuredOutput: true },
		cost: { input: options.cost ?? 0, output: options.cost ?? 0 }
	} as EngineModel;
}

describe('pickDefaultModel', () => {
	it('prefers a free model that can call tools over a more capable paid one', () => {
		const pick = pickDefaultModel([model('paid', { cost: 3, reasoning: true, image: true }), model('free', { cost: 0 })]);
		expect(pick?.engine.model.id).toBe('free');
	});

	it('never picks a model without tools when one with tools exists', () => {
		const pick = pickDefaultModel([model('chatty', { tools: false, reasoning: true, image: true }), model('agent', { tools: true })]);
		expect(pick?.engine.model.id).toBe('agent');
	});

	it('among free tool models, picks the most capable, then the larger context', () => {
		const pick = pickDefaultModel([model('a', { reasoning: false }), model('b', { reasoning: true }), model('c', { reasoning: true, context: 200_000 })]);
		expect(pick?.engine.model.id).toBe('c');
	});

	it('knows what free means', () => {
		expect(isFreeModel(model('x', { cost: 0 }))).toBe(true);
		expect(isFreeModel(model('y', { cost: 0.1 }))).toBe(false);
	});
});
