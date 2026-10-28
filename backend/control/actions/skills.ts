/**
 * Skills: running one of the user's slash skills (Settings → Skills).
 *
 * A skill runs exactly as typing `/<slug> args` in the web composer does:
 * the action hands the surface that text as a prompt, and the stream expands
 * it (`backend/skills/invoke.ts`) the same way for every engine. Which skills
 * are offered follows the session's profile, like the web "/" picker.
 */

import { t } from 'elysia';
import { defineAction } from '../define';
import { paged } from '../paging';
import { resolveTarget } from '../workspace';
import type { ControlContext } from '../types';

interface AvailableSkill {
	slug: string;
	name: string;
	description: string;
	argumentHint: string | null;
}

async function availableSkills(ctx: ControlContext): Promise<AvailableSkill[]> {
	const { project, session } = resolveTarget(ctx.target);
	const { skills } = await ctx.call<{ skills: AvailableSkill[] }>(
		'skills:available',
		{ profileId: session?.profile_id ?? null, projectId: project.id },
		{ projectId: project.id }
	);
	return skills;
}

/** What a person types for a skill: `/Review_PR`, `review-pr`, `review pr` all name `review-pr`. */
export function normaliseSkillName(input: string): string {
	return input.trim().replace(/^\/+/, '').toLowerCase().replace(/[\s_]+/g, '-');
}

/**
 * The skill a name refers to: an exact match, else the only skill that
 * starts with it. Otherwise the skills it might have meant, for buttons.
 */
export function matchSkill(skills: AvailableSkill[], input: string): { skill: AvailableSkill | null; similar: AvailableSkill[] } {
	const wanted = normaliseSkillName(input);
	const exact = skills.find((skill) => skill.slug === wanted);
	if (exact) return { skill: exact, similar: [] };
	const starts = skills.filter((skill) => skill.slug.startsWith(wanted));
	if (starts.length === 1) return { skill: starts[0], similar: [] };
	const similar = starts.length ? starts : skills.filter((skill) => skill.slug.includes(wanted) || wanted.includes(skill.slug));
	return { skill: null, similar: similar.slice(0, 8) };
}

export const listSkills = defineAction({
	id: 'skills.list',
	group: 'skills',
	title: 'Skills',
	description: 'Your skills',
	args: t.Object({ page: t.Optional(t.Number({ minimum: 0 })) }),
	command: { name: 'skills' },
	async run(ctx, args) {
		const skills = await availableSkills(ctx);
		if (skills.length === 0) return { text: 'No skills yet. Add them in Clopen → Settings → Skills.' };
		const { choices, range } = paged(
			skills,
			args.page,
			(skill) => ({
				label: skill.slug,
				detail: skill.argumentHint ? `${skill.description} (needs: ${skill.argumentHint})` : skill.description,
				action: 'skills.run',
				args: { slug: skill.slug }
			}),
			{ action: 'skills.list' }
		);
		return { text: `**🧩 Skills**${range}\n_Tap one to run it here. To give it input: /run name input._`, choices };
	}
});

/**
 * Skills run through `/run`, never as `/<name>`: a bot command name shares
 * one namespace with Clopen's own commands (a skill called `new` or `status`
 * would never run), cannot hold the dashes skill names use, and a new skill
 * must not be able to shadow a command. (A message that starts with a skill's
 * own `/slug`, dashes and all, is not a bot command to Telegram: it is sent
 * to the session as text and expanded by Clopen, exactly as in the web.)
 */
export const runSkill = defineAction({
	id: 'skills.run',
	group: 'skills',
	title: 'Run a skill',
	description: 'Run a skill',
	args: t.Object({ slug: t.Optional(t.String()), input: t.Optional(t.String()) }),
	command: { name: 'run', argument: { keys: ['slug', 'input'], hint: '<skill> [input]' } },
	async run(ctx, args) {
		const skills = await availableSkills(ctx);
		if (!args.slug?.trim()) {
			return { text: 'Which skill? Pick one, or type /run name input.', choices: skills.slice(0, 20).map((skill) => ({ label: skill.slug, action: 'skills.run', args: { slug: skill.slug } })) };
		}
		const { skill, similar } = matchSkill(skills, args.slug);
		if (!skill) {
			if (similar.length === 0) return { text: `There is no skill called “${args.slug.trim()}”. /skills lists yours.` };
			return {
				text: `There is no skill called “${args.slug.trim()}”. Did you mean one of these?`,
				choices: similar.map((entry) => ({ label: entry.slug, detail: entry.description, action: 'skills.run', args: { slug: entry.slug, ...(args.input ? { input: args.input } : {}) } }))
			};
		}
		const input = args.input?.trim();
		if (!input && skill.argumentHint) {
			return { text: `${skill.slug} needs ${skill.argumentHint}. Send it like this:\n\n\`/run ${skill.slug} ${skill.argumentHint}\`` };
		}
		return { text: `▶️ Running ${skill.slug}…`, prompt: input ? `/${skill.slug} ${input}` : `/${skill.slug}` };
	}
});
