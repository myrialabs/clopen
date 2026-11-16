/**
 * A repeating task from a sentence — "every morning at 7, tell me if my site
 * is down" — for the owner who should never see recipe syntax. One sentence
 * carries both what should happen and when.
 *
 * The model writes the steps as JSON, not recipe text: indentation is where
 * text drafts went wrong (an "Else:" one level off made the whole plan
 * unreadable, or quietly moved a branch's steps into the other branch).
 * Before the plan is shown it is checked against the sentence — every branch
 * and every destination it names — and handed back once with what is missing.
 */

import { judge, think } from '$backend/assistant/think';
import { findInstalled } from '$backend/assistant/connect';
import { mcpServerQueries } from '$backend/database/queries';
import { describeWhen, parseWhen, WHEN_EXAMPLES } from '$backend/jobs/when';
import { normaliseRecipe, recipeToText, RecipeError, walkSteps } from '$shared/utils/recipe-text';
import type { Recipe } from '$shared/types/recipe';
import { debug } from '$shared/utils/logger';

export interface FlowDraft {
	name: string;
	recipe: Recipe;
	recipeText: string;
	/** The "when" as typed for the scheduler, or null for "only when I run it". */
	when: string | null;
	/** The "when" in words, with its time zone. */
	whenText: string;
	/** Services the plan uses that are not connected yet. */
	needsConnect: string[];
}

const SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		name: { type: 'string', description: 'A short name, in the language of the description.' },
		when: { type: ['string', 'null'], description: `When it runs, in English (${WHEN_EXAMPLES}), or null when the description gives no time.` },
		steps: { type: 'string', description: 'The steps as a JSON array (see the format).' }
	},
	required: ['name', 'when', 'steps']
};

const FORMAT = `Steps format — a JSON array of step objects, nested for branches:
- {"kind":"do","goal":"…","name":"result"} — anything that needs looking up, reading or judgement (checking email, a price, a page). "name" keeps its result as $result for later steps.
- {"kind":"tell","text":"… $result …"} — a message to the owner. It reaches them in Clopen AND in their chat apps (Telegram included): never use a service to message the owner.
- {"kind":"use","service":"discord","tool":"send_message","args":{"text":"…"}} — a connected service, for anything that is not the owner's own chat (Discord, Slack, Notion, someone else's email…).
- {"kind":"if","when":"condition in words, about earlier results","then":[…],"else":[…]} — two outcomes; put each outcome's steps in its own list.
- {"kind":"choose","by":"$result","cases":[{"label":"…","steps":[…]}],"otherwise":[…]} — more than two outcomes.
- {"kind":"each","items":"$list","steps":[…]}, {"kind":"repeat","until":"…","steps":[…],"max":5}, {"kind":"parallel","branches":[[…],[…]]}
- {"kind":"http","url":"…","name":"…"}, {"kind":"wait","minutes":5}, {"kind":"ask","question":"…"}, {"kind":"approve","what":"…"}`;

function connectedServices(): string[] {
	return mcpServerQueries
		.getAll()
		.filter((row) => row.source !== 'internal')
		.map((row) => row.name || row.slug);
}

function readSteps(raw: string, title: string): Recipe {
	let value: unknown;
	try {
		value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
	} catch {
		// Recipe text after all: the parser is forgiving about how branches are indented.
		return normaliseRecipe(raw, title);
	}
	return normaliseRecipe(Array.isArray(value) ? { title, steps: value } : value, title);
}

interface Drafted {
	name: string;
	when: string | null;
	recipe: Recipe;
}

async function attempt(prompt: string): Promise<Drafted> {
	const draft = await think<{ name: string; when: string | null; steps: string }>(prompt, SCHEMA);
	const name = draft.name?.trim().slice(0, 80) || 'Repeating task';
	return { name, when: draft.when, recipe: readSteps(draft.steps, name) };
}

/** Whether the plan does all the sentence asks; what is missing when it does not. */
async function missing(description: string, recipe: Recipe): Promise<string | null> {
	try {
		const verdict = await judge(
			'Does this plan do everything the description asks — each condition with each of its outcomes going where the description says, and every place a message should go? Wording does not matter.',
			`Description: ${description}\n\nPlan:\n${recipeToText(recipe)}`
		);
		return verdict.answer ? null : verdict.reason || 'It does not match the description.';
	} catch (error) {
		debug.warn('jobs', 'Checking a drafted flow failed:', error);
		return null;
	}
}

export async function draftFlow(description: string, when?: string | null): Promise<FlowDraft> {
	const services = connectedServices();
	const prompt = [
		'Turn this description of something that should happen on its own into a repeating task: a name, when it runs (read from the description), and its steps.',
		'Keep it as small as the description: usually one to four steps.',
		FORMAT,
		services.length ? `Connected services: ${services.join(', ')}.` : 'No services are connected yet; a service the description names is still used with "use".',
		'Step contents (goals, messages) stay in the language of the description; the JSON keys stay English.',
		'',
		`Description: ${description}`,
		when ? `When (as the owner gave it): ${when}` : ''
	].join('\n');

	let drafted: Drafted | null = null;
	let problem: string | null = null;
	for (let round = 0; round < 3; round++) {
		const ask = problem ? `${prompt}\n\nYour last plan was not right: ${problem}\nWrite it again.` : prompt;
		try {
			drafted = await attempt(ask);
		} catch (error) {
			if (!(error instanceof RecipeError) && !(error instanceof SyntaxError)) throw error;
			problem = error.message;
			continue;
		}
		problem = round < 2 ? await missing(description, drafted.recipe) : null;
		if (!problem) break;
	}
	if (!drafted) throw new Error(problem ? `The plan could not be read: ${problem}` : 'The plan could not be drafted.');

	// The owner's words first; when the scheduler cannot read them, the model's English version of them.
	let whenRaw: string | null = null;
	let whenText = 'Only when you run it';
	for (const candidate of [when?.trim(), drafted.when?.trim()]) {
		if (!candidate) continue;
		try {
			whenText = describeWhen(parseWhen(candidate));
			whenRaw = candidate;
			break;
		} catch {
			// Try the next reading.
		}
	}
	const recipe = { ...drafted.recipe, title: drafted.name };
	const needsConnect = [
		...new Set(
			walkSteps(recipe.steps)
				.map((entry) => entry.step)
				.filter((step) => step.kind === 'use' && !findInstalled(step.service))
				.map((step) => (step.kind === 'use' ? step.service : ''))
		)
	];
	return { name: drafted.name, recipe, recipeText: recipeToText(recipe), when: whenRaw, whenText, needsConnect };
}
