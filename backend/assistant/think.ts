/**
 * One structured question to a model — no chat, no tools, no session.
 *
 * What the recipe engine asks when a step needs judgement rather than work:
 * does this condition hold, which case is this, does this draft pass review,
 * how should this failing step change. Small, schema-bound and cheap, so the
 * structure of a run is decided by code and only the judgement by a model —
 * which is what keeps a cheap model and a flagship producing the same run.
 *
 * Runs on the owner's Background model (Settings → Models), or the free
 * model when none is picked for it.
 */

import { initializeEngine } from '$backend/engine';
import { resolveGenerationTarget, GENERATION_SETTINGS } from '$backend/engine/resolve-model';
import { debug } from '$shared/utils/logger';
import { getClopenDir } from '$backend/utils/paths';
import { getDatabase } from '$backend/database';
import { freeAssistantModel, getModelChoice, pickAssistantModel, type ModelPurpose } from './model';
import type { ModelChoice } from '$backend/control/workspace';

/** The owner's model choice for one purpose, as saved in Settings → Models. */
export function settingsModelFor(purpose: ModelPurpose): ModelChoice | null {
	return getModelChoice(purpose);
}

async function backgroundModel(): Promise<ModelChoice | null> {
	return settingsModelFor('background') ?? (await freeAssistantModel()) ?? (await pickAssistantModel());
}

/**
 * Ask for a JSON answer matching `schema` (OpenAI strict shape: every property
 * required, nullable for optional). Throws when no model is usable.
 */
export async function think<T>(prompt: string, schema: Record<string, unknown>): Promise<T> {
	const model = await backgroundModel();
	if (!model) throw new Error('No AI model is set up yet.');
	const engine = await initializeEngine(model.engine);
	if (!engine.generateStructured) throw new Error(`${model.engine} cannot answer structured questions.`);
	const target = await resolveGenerationTarget(engine, model.modelId, model.provider, GENERATION_SETTINGS.assistant);
	debug.log('assistant', `think() via ${model.engine}/${target.modelId}`);
	return engine.generateStructured<T>({
		prompt,
		providerSlug: target.providerSlug,
		modelId: target.modelId,
		schema,
		projectPath: getClopenDir(),
		...(target.accountId != null && { accountId: target.accountId })
	});
}

const YES_NO = {
	type: 'object',
	additionalProperties: false,
	properties: { answer: { type: 'boolean' }, reason: { type: 'string' } },
	required: ['answer', 'reason']
};

/** A yes/no judgement about some context. */
export async function judge(question: string, context: string): Promise<{ answer: boolean; reason: string }> {
	return think<{ answer: boolean; reason: string }>(
		`Answer the question about the context below with true or false, and one short reason.\n\nQuestion: ${question}\n\nContext:\n<<<\n${context.slice(0, 12_000)}\n>>>`,
		YES_NO
	);
}

/** Which of `labels` fits the context best (or `null` for none). */
export async function classify(question: string, labels: string[], context: string): Promise<string | null> {
	const result = await think<{ label: string | null }>(
		`${question}\nPick exactly one of these labels, or null if none fits: ${labels.map((label) => JSON.stringify(label)).join(', ')}.\n\nContext:\n<<<\n${context.slice(0, 12_000)}\n>>>`,
		{
			type: 'object',
			additionalProperties: false,
			properties: { label: { type: ['string', 'null'], enum: [...labels, null] } },
			required: ['label']
		}
	);
	return result.label && labels.includes(result.label) ? result.label : null;
}

/**
 * Say `text` to the owner in the language they wrote `sample` in (a task goal,
 * their last message). Clopen's fixed notices ("is stuck", "needs a key") are
 * written in English; this keeps them from landing in English in a chat held
 * in another language. Falls back to `text` when no model answers.
 */
export async function inOwnersLanguage(text: string, sample: string | null | undefined): Promise<string> {
	if (!sample?.trim()) return text;
	try {
		const result = await think<{ text: string }>(
			`Rewrite the message below in the same language as the sample, keeping its meaning, names, numbers and links exactly. Keep it as short as it is. If the sample is already in the message's language, return the message unchanged.\n\nSample:\n<<<\n${sample.slice(0, 600)}\n>>>\n\nMessage:\n<<<\n${text}\n>>>`,
			{ type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] }
		);
		return result.text.trim() || text;
	} catch {
		return text;
	}
}

/** The owner's latest words in a chat (skipping Clopen's own notes), as a language sample — or anywhere in Clopen's chats. */
export function ownerSample(sessionId: string | null | undefined): string | null {
	if (!sessionId) return latestOwnerWords();
	try {
		const rows = getDatabase()
			.prepare(`SELECT data FROM messages WHERE session_id = ? AND is_deleted = 0 AND json_extract(data, '$.type') = 'user' ORDER BY created_at DESC LIMIT 8`)
			.all(sessionId) as Array<{ data: string }>;
		for (const row of rows) {
			const message = JSON.parse(row.data) as { content?: Array<{ type?: string; text?: string }> };
			const text = (message.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join(' ').trim();
			if (text && !text.startsWith('[Clopen') && !text.startsWith('<')) return text.slice(0, 400);
		}
	} catch {
		// No sample: notices stay in English.
	}
	return latestOwnerWords();
}

/** What the owner last said to Clopen, from the chat timeline (cheap: one indexed row). */
function latestOwnerWords(): string | null {
	try {
		const row = getDatabase()
			.prepare(`SELECT text FROM assistant_timeline WHERE sender = 'owner' AND text <> '' ORDER BY created_at DESC LIMIT 1`)
			.get() as { text: string } | undefined;
		return row?.text.slice(0, 400) ?? null;
	} catch {
		return null;
	}
}
