/**
 * AI authoring — generate a draft artifact (Skill / Command / Subagent /
 * Instruction) from a single "purpose" sentence, so the user fills one input
 * instead of every field by hand. Reuses the engines' one-shot
 * `generateStructured` (the same path as git commit-message generation), so no
 * new model plumbing is introduced.
 *
 * Schemas follow the strict structured-output convention (OpenAI/Codex): every
 * object declares `additionalProperties: false`, every property is `required`,
 * and optional fields are nullable unions rather than omitted.
 */

import { initializeEngine } from '$backend/engine';
import { getClopenDir } from '$backend/utils/paths';
import type { EngineType } from '$shared/types/unified';
import { debug } from '$shared/utils/logger';

export type GeneratableType = 'skill' | 'command' | 'subagent' | 'instruction';

const SCHEMAS: Record<GeneratableType, Record<string, unknown>> = {
	skill: {
		type: 'object',
		additionalProperties: false,
		properties: {
			name: { type: 'string', description: 'Short human name for the skill' },
			description: { type: 'string', description: 'What it does AND when to use it (one or two sentences)' },
			body: { type: 'string', description: 'Markdown instructions the agent follows when the skill is active' }
		},
		required: ['name', 'description', 'body']
	},
	command: {
		type: 'object',
		additionalProperties: false,
		properties: {
			name: { type: 'string', description: 'Short human name for the command' },
			description: { type: 'string', description: 'One line describing what the command does' },
			argumentHint: { type: ['string', 'null'], description: 'Hint for expected arguments, e.g. "[pr-number]". Null if none.' },
			body: { type: 'string', description: 'The prompt the command runs. Use $ARGUMENTS where user input belongs.' }
		},
		required: ['name', 'description', 'argumentHint', 'body']
	},
	subagent: {
		type: 'object',
		additionalProperties: false,
		properties: {
			name: { type: 'string', description: 'Short human name for the subagent' },
			description: { type: 'string', description: 'What it does and when to delegate to it' },
			tools: { type: ['string', 'null'], description: 'Comma-separated tool allowlist (e.g. "Read, Grep, Bash"). Null = all tools.' },
			body: { type: 'string', description: 'The subagent system prompt (its role and behavior).' }
		},
		required: ['name', 'description', 'tools', 'body']
	},
	instruction: {
		type: 'object',
		additionalProperties: false,
		properties: {
			content: { type: 'string', description: 'The instruction block: concise directives the agent should always follow.' }
		},
		required: ['content']
	}
};

const GUIDANCE: Record<GeneratableType, string> = {
	skill: 'Author a reusable Agent Skill. The description must state what it does and when to use it. The body is step-by-step Markdown instructions.',
	command: 'Author a reusable slash-command prompt. The body is the prompt template; put $ARGUMENTS where the user-supplied text should be inserted.',
	subagent: 'Author a specialized subagent. The description tells the parent agent when to delegate. The body is the subagent system prompt. Only set tools if the purpose implies a restricted allowlist; otherwise null.',
	instruction: 'Author a shared instruction block — concise, imperative directives the agent should always follow. No preamble, just the directives.'
};

export interface GenerateModel {
	engine: EngineType;
	providerSlug: string;
	modelId: string;
	/** Optional cwd for the engine process; defaults to the Clopen data dir. */
	projectPath?: string;
	accountId?: number;
}

/** Generate a draft artifact of `type` from a free-text purpose. */
export async function generateArtifact(type: GeneratableType, purpose: string, model: GenerateModel): Promise<Record<string, unknown>> {
	const engine = await initializeEngine(model.engine);
	if (!engine.generateStructured) {
		throw new Error(`Engine "${model.engine}" does not support AI generation`);
	}

	const prompt = `${GUIDANCE[type]}

Produce a high-quality draft from this purpose:
"""
${purpose.trim()}
"""

Always write the draft in English, regardless of the language of the purpose. Be specific and immediately usable.`;

	debug.log('artifacts', `✨ Generating ${type} draft via ${model.engine}/${model.modelId}`);

	return engine.generateStructured<Record<string, unknown>>({
		prompt,
		providerSlug: model.providerSlug,
		modelId: model.modelId,
		schema: SCHEMAS[type],
		projectPath: model.projectPath || getClopenDir(),
		accountId: model.accountId
	});
}
