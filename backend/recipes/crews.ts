/**
 * Crews — how delegated project work is staffed and staged.
 *
 * Sized to the request, never to a quota. A planner reads the request once and
 * fills a small shape — what kind of work it is, whether facts must be
 * gathered first, who (if anyone) should judge the result, whether it ends in
 * a launch. Code builds the recipe from it:
 *
 *   build     Developer builds → Tester tries it in a real browser → the
 *             Developer fixes what the Tester found, until it passes → the
 *             Developer shares a link. (A Researcher first only when the
 *             request depends on facts the team does not have.)
 *   document  Writer writes it into the project → one reviewer → revisions.
 *   general   one Specialist does it in the project → one reviewer → fixes.
 *
 * Every crew works in a project folder (Clopen's own chat never does project
 * work), every stage hands over a full report rather than a chat reply, and a
 * review can end the loop three ways besides passing: it needs something only
 * the owner has (they are asked once), it is impossible as asked (the task
 * ends honestly), or it stops improving (the task is reported unfinished).
 */

import { judge, think } from '$backend/assistant/think';
import type { Recipe, RecipeStep } from '$shared/types/recipe';
import { debug } from '$shared/utils/logger';

export type CrewKind = 'build' | 'document' | 'general';

export interface CrewPlan {
	kind: CrewKind;
	title: string;
	/** Folder-safe project name. */
	projectName: string;
	/** Facts must be gathered before building (prices, regulations, real data). */
	research: boolean;
	/** The one role that judges the result ("Nutritionist", "Editor"); null for a plain QA check. */
	reviewer: string | null;
	/** Ends with publishing or marketing — only when the request asks for it. */
	launch: boolean;
	/** Checkable acceptance criteria shown on the task. */
	criteria: string[];
}

const PLAN_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		kind: {
			type: 'string',
			enum: ['build', 'document', 'general'],
			description: 'build: software, websites, apps, tools, scripts. document: a report, article, plan, slides or spreadsheet. general: any other project work.'
		},
		title: { type: 'string', description: 'Short title, in the language of the request.' },
		projectName: { type: 'string', description: 'A short folder-safe name, lowercase with dashes.' },
		research: { type: 'boolean', description: 'True only if the work depends on facts the team must look up first. False for most requests.' },
		reviewer: { type: ['string', 'null'], description: 'One expert whose judgement the result really needs (in English), or null when a plain check is enough. Null for most requests.' },
		launch: { type: 'boolean', description: 'True only if the request explicitly asks to publish, post, market or advertise.' },
		criteria: { type: 'array', items: { type: 'string' }, description: '2 to 5 checkable acceptance criteria about the thing itself, in the language of the request. Only what the request asks for. Never about delivering, sending, sharing or linking it — that happens after.' }
	},
	required: ['kind', 'title', 'projectName', 'research', 'reviewer', 'launch', 'criteria']
};

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[^\w\s-]/g, '')
			.trim()
			.replace(/[\s_]+/g, '-')
			.slice(0, 40) || 'project'
	);
}

/** The plan when the planner is unavailable: the smallest crew that can do anything. */
export function fallbackPlan(goal: string): CrewPlan {
	const title = goal.replace(/\s+/g, ' ').trim().slice(0, 60);
	return { kind: 'general', title, projectName: slug(title), research: false, reviewer: null, launch: false, criteria: [] };
}

/** Read the request once and fill the plan. */
export async function planCrew(goal: string, detail?: string): Promise<CrewPlan> {
	try {
		const plan = await think<CrewPlan>(
			[
				'Plan the smallest team that can do this request well. Add nothing the request does not need.',
				'',
				`Request: ${goal}`,
				detail ? `Details: ${detail}` : ''
			].join('\n'),
			PLAN_SCHEMA
		);
		// A launch (posts, publishing, a "publish?" card) only when the owner's own words ask for one —
		// a detail line about a public preview link or a style change is not a request to market anything.
		const launch = plan.launch ? await judge('Does this request explicitly ask to publish, post, market or advertise something?', goal).then((verdict) => verdict.answer).catch(() => false) : false;
		return { ...plan, launch, criteria: plan.criteria.slice(0, 5), projectName: slug(plan.projectName || plan.title) };
	} catch (error) {
		debug.warn('assistant', 'Planning a crew failed; using the smallest crew:', error);
		return fallbackPlan(goal);
	}
}

const HANDOFF = 'End with a handoff report for whoever continues: what you did, where the files are, how to run or open it, and anything unfinished. Be complete — they only see this report.';

/** Agents in a crew never stop to ask: the owner hears from Clopen, once. */
const NO_QUESTIONS =
	'Do not ask the owner anything: where something is unclear, choose a sensible default and list your choices in the report. Do not wait with a long sleep: start long work in the background and check on it in short steps. A file from a web page comes down with the browser download action. Files for the owner go with owner.send.';

/** Build, check, fix — until the check passes (or stops improving, needs the owner, or is impossible). */
function checked(input: { work: RecipeStep; check: RecipeStep; verdict: string; fix: RecipeStep; rounds: number }): RecipeStep[] {
	return [
		input.work,
		{
			kind: 'repeat',
			until: `$${input.verdict}.passed`,
			max: input.rounds,
			steps: [input.check, { kind: 'if', when: `not $${input.verdict}.passed`, then: [input.fix] }]
		}
	];
}

/**
 * The work and its check, for a kind of crew. `request` is what to do — the
 * owner's request, or a change they asked for afterwards.
 */
function stages(kind: CrewKind, request: string, criteria: string, reviewer: string | null, where: { project: string }, revising = false): RecipeStep[] {
	const steps: RecipeStep[] = [];
	if (kind === 'build') {
		steps.push(
			...checked({
				work: {
					kind: 'do',
					role: 'Developer',
					title: revising ? 'Make the change' : 'Build it',
					goal: `${revising ? 'Make this change in this project, run it, and fix every error' : 'Build this in this project folder, run it, and fix every error'}:\n${request}\n\nIt must meet:\n${criteria}\n\n${NO_QUESTIONS}\n${HANDOFF}`,
					name: 'build',
					...where
				},
				check: {
					kind: 'do',
					role: 'Tester',
					title: 'Test in the browser',
					goal: `Test round $round. Start the app from this project and try it yourself in the real browser (the browse tool), at a desktop size and a phone size, against:\n${criteria}\n\nOn round 1 check everything. On a later round, check only the problems reported last time and what their fixes could have touched — not everything again.\n\nThe developer's report:\n$build\n\nReport what works and the problems that break a criterion, with steps to reproduce; mention small polish points separately. Do not fix anything yourself. Keep it quick. ${NO_QUESTIONS}`,
					name: 'test',
					...where
				},
				verdict: 'qa',
				fix: { kind: 'do', role: 'Developer', title: 'Fix what the test found', goal: `Fix these problems the tester found, then run it again:\n$qa.issues\n\nThe test report:\n$test\n\n${NO_QUESTIONS}\n${HANDOFF}`, name: 'build', ...where },
				rounds: 2
			})
		);
		// The check step above is a test run; the verdict on it comes from a single review.
		const loop = steps[steps.length - 1] as Extract<RecipeStep, { kind: 'repeat' }>;
		loop.steps.splice(1, 0, { kind: 'review', title: 'Does it pass?', target: '$test', reviewers: [reviewer ?? 'QA lead'], criteria: `Based on this test report, does it meet every one of these?\n${criteria}`, name: 'qa' });
		steps.push({
			kind: 'do',
			role: 'Developer',
			title: 'Share a link',
			goal: 'Make it usable by the owner: start it and keep it running, create a public link with the run tool action share.link (port or folder), and take a screenshot of it with the browse tool, saved in this project. Reply with the link and the screenshot file path.',
			name: 'release',
			...where
		});
		return steps;
	}
	const role = kind === 'document' ? 'Writer' : 'Specialist';
	const name = kind === 'document' ? 'draft' : 'work';
	return checked({
		work: {
			kind: 'do',
			role,
			title: revising ? 'Make the change' : kind === 'document' ? 'Write it' : 'Do it',
			goal: `${revising ? 'Make this change, in this project folder' : kind === 'document' ? 'Write this, and save it as a file in this project' : 'Do this, working in this project folder'}:\n${request}\n\nIt must meet:\n${criteria}\n\n${NO_QUESTIONS}\n${HANDOFF}`,
			name,
			...where
		},
		check: { kind: 'review', title: 'Does it pass?', target: `$${name}`, reviewers: [reviewer ?? 'Reviewer'], criteria: `Does it meet every one of these?\n${criteria}`, name: 'check' },
		verdict: 'check',
		fix: { kind: 'do', role, title: 'Fix what the check found', goal: `Fix these points:\n$check.issues\n\n${NO_QUESTIONS}\n${HANDOFF}`, name, ...where },
		rounds: 2
	});
}

/** What kind of crew a recipe is, read from who does its work. */
export function crewKindOf(recipe: Recipe): CrewKind {
	const roles = new Set<string>();
	const walk = (steps: RecipeStep[]) => {
		for (const step of steps) {
			if (step.kind === 'do' && step.role) roles.add(step.role);
			if (step.kind === 'repeat' || step.kind === 'each') walk(step.steps);
			if (step.kind === 'if') walk([...step.then, ...(step.else ?? [])]);
		}
	};
	walk(recipe.steps);
	return roles.has('Developer') ? 'build' : roles.has('Writer') ? 'document' : 'general';
}

/**
 * A change the owner asked for after a task — "make it realistic", "ok, use
 * the defaults" — done by the same crew in the same project and chats: the
 * work, then the same check as before.
 */
export function reviseRecipe(original: Recipe, change: string, previous: string, project: string): Recipe {
	const request = `${change}\n\nWhat was delivered before:\n${previous.slice(0, 6000)}`;
	return { title: original.title, steps: stages(crewKindOf(original), request, `- ${change}\n- Everything that worked before still works`, null, { project }, true) };
}

/** The crew's recipe, run in `project` (an id). */
export function crewRecipe(plan: CrewPlan, goal: string, detail: string | undefined, project: string): Recipe {
	const where = { project };
	const ask = [goal, detail].filter(Boolean).join('\n\n');
	const criteria = plan.criteria.length ? plan.criteria.map((item) => `- ${item}`).join('\n') : `- ${goal}`;
	const steps: RecipeStep[] = [];

	if (plan.research) {
		steps.push({ kind: 'do', role: 'Researcher', title: 'Research', goal: `Look up what this needs, from reliable sources, and note each source. Save your findings as a file in this project.\n\nThe request:\n${ask}\n\n${NO_QUESTIONS}\n${HANDOFF}`, name: 'research', ...where });
	}
	const research = plan.research ? '\n\nThe research:\n$research' : '';

	steps.push(...stages(plan.kind, `${ask}${research}`, criteria, plan.reviewer, where));

	if (plan.launch) {
		const result = plan.kind === 'build' ? '$release' : plan.kind === 'document' ? '$draft' : '$work';
		steps.push({ kind: 'do', role: 'Marketer', title: 'Prepare the launch', goal: `Prepare the launch: the posts or messages, where to publish them, and who to reach. Do not publish yet.\n\n${result}\n\n${HANDOFF}`, name: 'launchPlan', ...where });
		steps.push({ kind: 'approve', title: 'Your OK to publish', what: `Publish the launch of ${plan.title}?\n$launchPlan` });
		steps.push({ kind: 'do', role: 'Marketer', title: 'Publish', goal: 'Publish the approved launch with the connected services. Report what was posted where, with links.', name: 'launch', ...where });
	}

	return { title: plan.title, steps };
}

/** The variable holding the crew's final result, for the report to the owner. */
export function crewResultVar(recipe: Recipe): string {
	const names = recipe.steps.map((step) => step.name).filter(Boolean) as string[];
	for (const preferred of ['launch', 'release', 'draft', 'work', 'build']) if (names.includes(preferred)) return preferred;
	return names[names.length - 1] ?? 'work';
}
