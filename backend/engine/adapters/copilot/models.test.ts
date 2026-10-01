import { describe, expect, test } from 'bun:test';
import type { CopilotClient, ModelInfo } from '@github/copilot-sdk';
import { fetchCopilotModels } from './models';

function clientReturning(result: ModelInfo[] | Error): CopilotClient {
	return {
		listModels: async () => {
			if (result instanceof Error) throw result;
			return result;
		}
	} as unknown as CopilotClient;
}

const ids = (models: { engine: { model: { id: string } } }[]) => models.map(m => m.engine.model.id);

describe('fetchCopilotModels', () => {
	test('a Copilot Free account with no picker-enabled models still gets Auto', async () => {
		const { models } = await fetchCopilotModels(clientReturning([]), null);
		expect(ids(models)).toEqual(['auto']);
	});

	test('Auto leads the catalog and is never duplicated', async () => {
		const gpt = { id: 'gpt-6-luna', name: 'GPT-6 Luna', capabilities: {} } as ModelInfo;
		expect(ids((await fetchCopilotModels(clientReturning([gpt]), null)).models)).toEqual(['auto', 'gpt-6-luna']);

		const auto = { id: 'auto', name: 'Auto', capabilities: {} } as ModelInfo;
		expect(ids((await fetchCopilotModels(clientReturning([auto, gpt]), null)).models)).toEqual(['auto', 'gpt-6-luna']);
	});

	test('a rejected token surfaces as an actionable error instead of an empty list', async () => {
		const failure = new Error('Request models.list failed with message: Not authenticated. Please authenticate first.');
		expect(fetchCopilotModels(clientReturning(failure), null)).rejects.toThrow('Settings → Engines → Copilot');
	});

	test('a fine-grained PAT the models endpoint refuses falls back to Auto', async () => {
		const failure = new Error('Personal Access Tokens are not supported for this endpoint');
		const { models } = await fetchCopilotModels(clientReturning(failure), null);
		expect(ids(models)).toEqual(['auto']);
	});
});
