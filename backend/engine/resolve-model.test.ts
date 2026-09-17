/**
 * `resolveGenerationTarget` is the last place a misconfigured one-shot
 * generation can be caught before it becomes an opaque adapter failure.
 *
 * Handed a blank or stale model id, engines don't refuse — they run with no
 * model and return nothing, which surfaced as "OpenCode returned empty
 * response". That sentence names the symptom and nothing else: not the cause,
 * not the fix, and a different wording per engine for the same situation. These
 * tests pin that each of those cases now throws *here*, naming the settings page
 * that owns the choice.
 */

import { describe, expect, test } from 'bun:test';
import { registerModels } from '$shared/constants/engines';
import type { EngineModel, EngineType } from '$shared/types/unified';
import { resolveGenerationTarget, GENERATION_SETTINGS } from './resolve-model';
import type { AIEngine } from './types';

/** The parts of an EngineModel this resolution actually reads. */
function model(engineType: EngineType, provider: string, id: string, accountId = 0): EngineModel {
	return {
		engine: {
			type: engineType,
			provider,
			model: { id, name: id },
			account: { id: accountId, name: 'test' }
		}
	} as EngineModel;
}

/** A stand-in engine whose catalog the test controls. */
function fakeEngine(engineType: EngineType, catalog: EngineModel[] | Error): AIEngine {
	return {
		name: engineType,
		getAvailableModels: async () => {
			if (catalog instanceof Error) throw catalog;
			return catalog;
		}
	} as unknown as AIEngine;
}

describe('resolveGenerationTarget', () => {
	test('resolves the provider and account from the catalog, ignoring a stale hint', async () => {
		registerModels('opencode', [model('opencode', 'anthropic', 'claude-sonnet-5', 7)]);
		const target = await resolveGenerationTarget(
			fakeEngine('opencode', []),
			'claude-sonnet-5',
			'openai' // drifted: the catalog is the source of truth
		);
		expect(target).toEqual({ providerSlug: 'anthropic', modelId: 'claude-sonnet-5', accountId: 7 });
	});

	test('a blank model id is rejected, naming the settings page that owns it', async () => {
		registerModels('opencode', []);
		const promise = resolveGenerationTarget(
			fakeEngine('opencode', [model('opencode', 'anthropic', 'claude-sonnet-5')]),
			'',
			'anthropic',
			GENERATION_SETTINGS.artifact
		);
		await expect(promise).rejects.toThrow(/No model is selected.*Settings → Models → Artifacts/);
	});

	test('whitespace is not a model id either', async () => {
		registerModels('opencode', []);
		await expect(
			resolveGenerationTarget(fakeEngine('opencode', []), '   ', undefined, GENERATION_SETTINGS.commit)
		).rejects.toThrow(/Settings → Models → Commit message/);
	});

	test('an engine with no models at all says so, and points at Engines', async () => {
		registerModels('opencode', []);
		const promise = resolveGenerationTarget(
			fakeEngine('opencode', []),
			'some-model',
			undefined,
			GENERATION_SETTINGS.artifact
		);
		// "Pick a model again" would be useless advice when there is nothing to pick.
		await expect(promise).rejects.toThrow(/no models available.*Settings → Engines/s);
	});

	test('a model the catalog no longer offers is rejected, not passed through', async () => {
		// This is the OpenCode case exactly: the catalog is fetched live, the saved
		// id disappeared, and the provider hint still looks plausible. Trusting the
		// hint here is what sent an unknown model id to the engine.
		registerModels('opencode', []);
		const promise = resolveGenerationTarget(
			fakeEngine('opencode', [model('opencode', 'anthropic', 'claude-sonnet-5')]),
			'gone-model',
			'anthropic',
			GENERATION_SETTINGS.artifact
		);
		await expect(promise).rejects.toThrow(/"gone-model" is no longer offered.*Settings → Models → Artifacts/);
	});

	test('an unreachable catalog falls back to the hint instead of blocking', async () => {
		// Offline or a crashed engine process: we cannot verify, so we also cannot
		// claim the model is wrong. Let the adapter try and report what it finds.
		registerModels('opencode', []);
		const target = await resolveGenerationTarget(
			fakeEngine('opencode', new Error('server unreachable')),
			'claude-sonnet-5',
			'anthropic'
		);
		expect(target).toEqual({ providerSlug: 'anthropic', modelId: 'claude-sonnet-5' });
	});
});
