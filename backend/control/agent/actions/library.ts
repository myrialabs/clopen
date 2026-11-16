/**
 * The Library from an agent's side — scripts, skills and recordings — plus
 * the owner's Inbox. Flows are in `flows.ts`.
 */

import { t } from 'elysia';
import { scriptQueries, skillQueries, inboxQueries } from '$backend/database/queries';
import { findScript, runScript, saveScript } from '$backend/assistant/scripts';
import { readSkill, revertSkill, saveSkillContent, skillVersions } from '$backend/assistant/skills';
import { listRecordings, saveRecordingAsScript, saveRecordingAsSkill } from '$backend/assistant/recordings';
import { raiseInboxItem, resolveInboxItem } from '$backend/assistant/inbox';
import { toInboxItem, toScript } from '$backend/assistant/mappers';
import { skillService } from '$backend/skills';
import { resolveProject } from '$backend/assistant/missions';
import { defineAgentAction } from '../define';

// ── Scripts ────────────────────────────────────────────────────────────────

export const scriptList = defineAgentAction({
	id: 'script.list',
	group: 'script',
	title: 'List scripts',
	description: 'Saved scripts — global ones, and a project’s own when a project is given.',
	args: t.Object({ project: t.Optional(t.String()) }),
	risk: 'read',
	scope: 'any',
	async run(ctx, args) {
		const projectId = args.project ? resolveProject(args.project).id : ctx.target.projectId;
		const scripts = scriptQueries.list(projectId).map(toScript);
		return {
			text: scripts.length
				? scripts.map((script) => `- ${script.slug} (${script.runtime}${script.projectId ? ', project' : ', global'}): ${script.description || script.name}${script.params.length ? ` · args: ${script.params.map((param) => param.name).join(', ')}` : ''}`).join('\n')
				: 'No scripts yet.',
			data: { scripts: scripts.map(({ content: _content, ...rest }) => rest) }
		};
	}
});

export const scriptSave = defineAgentAction({
	id: 'script.save',
	group: 'script',
	title: 'Save a script',
	description:
		'Save steps you or an agent keep repeating as a script (bash, or bun for TypeScript that also works on Windows). Arguments arrive as $1, $2… and as CLOPEN_ARG_<NAME>. Saving under an existing name updates it. Test it with script.run before relying on it.',
	args: t.Object({
		name: t.String({ minLength: 1 }),
		description: t.String(),
		content: t.String({ minLength: 1 }),
		runtime: t.Optional(t.Union([t.Literal('bash'), t.Literal('bun')])),
		params: t.Optional(t.Array(t.Object({ name: t.String(), description: t.String() }))),
		project: t.Optional(t.String())
	}),
	risk: 'write',
	scope: 'assistant',
	async run(_ctx, args) {
		const script = saveScript({
			name: args.name,
			description: args.description,
			content: args.content,
			runtime: args.runtime,
			params: args.params,
			projectId: args.project ? resolveProject(args.project).id : null,
			source: 'assistant'
		});
		return { text: `Saved script ${script.slug}.`, data: { scriptId: script.id, slug: script.slug } };
	}
});

export const scriptRun = defineAgentAction({
	id: 'script.run',
	group: 'script',
	title: 'Run a script',
	description: 'Run a saved script by id or name, with arguments, in its project’s folder. Returns its exit code and output.',
	args: t.Object({ script: t.String({ minLength: 1 }), args: t.Optional(t.Array(t.String())), project: t.Optional(t.String()) }),
	risk: 'write',
	scope: 'any',
	async run(ctx, args) {
		const projectId = args.project ? resolveProject(args.project).id : ctx.target.projectId;
		const row = findScript(args.script, projectId);
		if (!row) throw new Error(`There is no script "${args.script}". script.list shows them.`);
		const result = await runScript(row, args.args ?? [], { projectId });
		return {
			text: `${row.slug} → exit ${result.exitCode}${result.timedOut ? ' (timed out)' : ''} in ${(result.durationMs / 1000).toFixed(1)}s\n${result.output || '(no output)'}`,
			data: result
		};
	}
});

export const scriptDelete = defineAgentAction({
	id: 'script.delete',
	group: 'script',
	title: 'Delete a script',
	description: 'Delete a saved script.',
	args: t.Object({ script: t.String({ minLength: 1 }) }),
	risk: 'irreversible',
	scope: 'assistant',
	async run(ctx, args) {
		const row = findScript(args.script, ctx.target.projectId);
		if (!row) throw new Error(`There is no script "${args.script}".`);
		scriptQueries.delete(row.id);
		return { text: `Deleted script ${row.slug}.`, data: { deleted: row.id } };
	}
});

// ── Skills ─────────────────────────────────────────────────────────────────

export const skillList = defineAgentAction({
	id: 'skill.list',
	group: 'skill',
	title: 'List skills',
	description: 'Every skill: slug, description, whether it is on.',
	args: t.Object({}),
	risk: 'read',
	scope: 'any',
	async run() {
		const skills = await skillService.list();
		return {
			text: skills.map((skill) => `- ${skill.slug}${skill.enabled ? '' : ' (off)'}: ${skill.description}`).join('\n') || 'No skills yet.',
			data: { skills: skills.map((skill) => ({ slug: skill.slug, name: skill.name, description: skill.description, enabled: skill.enabled })) }
		};
	}
});

export const skillGet = defineAgentAction({
	id: 'skill.get',
	group: 'skill',
	title: 'Read a skill',
	description: 'A skill’s instructions and its revision history.',
	args: t.Object({ slug: t.String({ minLength: 1 }) }),
	risk: 'read',
	scope: 'any',
	async run(_ctx, args) {
		const found = await readSkill(args.slug);
		if (!found) throw new Error(`There is no skill "${args.slug}".`);
		const versions = skillVersions(args.slug).map((version) => ({ version: version.version, note: version.note, by: version.createdBy, at: version.createdAt }));
		return { text: `# ${found.skill.name}\n${found.skill.description}\n\n${found.body}`, data: { skill: found.skill, versions } };
	}
});

export const skillSave = defineAgentAction({
	id: 'skill.save',
	group: 'skill',
	title: 'Save a skill',
	description:
		'Create a skill, or improve an existing one (pass its slug). Write the procedure so another agent can follow it cold: when to use it, the steps, how to verify, and the owner’s rules. Use $ARGUMENTS where the input varies. Every save is a revision the owner can revert.',
	args: t.Object({
		slug: t.Optional(t.String()),
		name: t.String({ minLength: 1 }),
		description: t.String({ minLength: 1 }),
		body: t.String({ minLength: 1 }),
		argumentHint: t.Optional(t.String()),
		note: t.Optional(t.String())
	}),
	risk: 'write',
	scope: 'assistant',
	async run(_ctx, args) {
		const existed = args.slug ? Boolean(skillQueries.getBySlug(args.slug)) : false;
		const skill = await saveSkillContent({
			slug: args.slug,
			name: args.name,
			description: args.description,
			body: args.body,
			argumentHint: args.argumentHint ?? null,
			createdBy: 'assistant',
			note: args.note ?? (existed ? 'Improved by Clopen' : 'Created by Clopen')
		});
		if (!existed) {
			raiseInboxItem({
				kind: 'learned',
				title: `New skill: ${skill.name}`,
				body: `${skill.description}\n\nRun it with /${skill.slug}.`,
				data: { skill: skill.slug }
			});
		}
		return { text: `${existed ? 'Improved' : 'Created'} skill ${skill.slug}.`, data: { slug: skill.slug } };
	}
});

export const skillRevert = defineAgentAction({
	id: 'skill.revert',
	group: 'skill',
	title: 'Revert a skill',
	description: 'Put a skill back to an earlier revision (skill.get lists them).',
	args: t.Object({ slug: t.String({ minLength: 1 }), version: t.Number({ minimum: 1 }) }),
	risk: 'write',
	scope: 'assistant',
	async run(_ctx, args) {
		const skill = await revertSkill(args.slug, args.version);
		return { text: `Skill ${skill.slug} is back at version ${args.version}.`, data: { slug: skill.slug } };
	}
});

// ── Recordings ─────────────────────────────────────────────────────────────

export const recordingList = defineAgentAction({
	id: 'recording.list',
	group: 'recording',
	title: 'List recordings',
	description: 'Tasks the owner recorded in a project’s Preview Browser ("teach a task").',
	args: t.Object({ project: t.String({ minLength: 1 }) }),
	risk: 'read',
	scope: 'assistant',
	async run(_ctx, args) {
		const recordings = listRecordings(resolveProject(args.project).id);
		return {
			text: recordings.map((recording) => `- ${recording.id} · ${recording.status} · ${recording.name || 'untitled'} · ${recording.steps.length} steps`).join('\n') || 'No recordings.',
			data: { recordings }
		};
	}
});

export const recordingSave = defineAgentAction({
	id: 'recording.save',
	group: 'recording',
	title: 'Turn a recording into a skill or script',
	description: 'Save a recorded task as a skill (replays the clicks and typing through browser automation) or a script (replays the page loads).',
	args: t.Object({
		recordingId: t.String({ minLength: 1 }),
		name: t.String({ minLength: 1 }),
		as: t.Union([t.Literal('skill'), t.Literal('script')]),
		purpose: t.Optional(t.String())
	}),
	risk: 'write',
	scope: 'assistant',
	async run(_ctx, args) {
		if (args.as === 'script') {
			const script = saveRecordingAsScript(args.recordingId, args.name);
			return { text: `Saved script ${script.slug}.`, data: { scriptId: script.id } };
		}
		const { slug } = await saveRecordingAsSkill(args.recordingId, args.name, args.purpose ?? '');
		return { text: `Saved skill ${slug}.`, data: { slug } };
	}
});

// ── Inbox ──────────────────────────────────────────────────────────────────

export const inboxList = defineAgentAction({
	id: 'inbox.list',
	group: 'inbox',
	title: 'Read the Inbox',
	description: 'Open items waiting for the owner (or all, with status "all").',
	args: t.Object({ status: t.Optional(t.Union([t.Literal('open'), t.Literal('all')])) }),
	risk: 'read',
	scope: 'assistant',
	async run(_ctx, args) {
		const items = inboxQueries.list({ status: args.status === 'all' ? 'all' : 'open', limit: 50 }).map(toInboxItem);
		return { text: items.map((item) => `- ${item.id} · ${item.kind} · ${item.status} · ${item.title}`).join('\n') || 'The Inbox is empty.', data: { items } };
	}
});

export const inboxResolve = defineAgentAction({
	id: 'inbox.resolve',
	group: 'inbox',
	title: 'Settle an Inbox item',
	description: 'Mark an Inbox item handled (you dealt with it) or dismissed (no longer relevant).',
	args: t.Object({ itemId: t.String({ minLength: 1 }), status: t.Union([t.Literal('resolved'), t.Literal('dismissed')]), note: t.Optional(t.String()) }),
	risk: 'write',
	scope: 'assistant',
	async run(_ctx, args) {
		const item = resolveInboxItem(args.itemId, args.status, args.note ? { note: args.note, by: 'assistant' } : { by: 'assistant' });
		if (!item) throw new Error('That Inbox item does not exist or is already settled.');
		return { text: `Inbox item ${item.id} ${item.status}.`, data: { item } };
	}
});

export const LIBRARY_ACTIONS = [
	scriptList,
	scriptSave,
	scriptRun,
	scriptDelete,
	skillList,
	skillGet,
	skillSave,
	skillRevert,
	recordingList,
	recordingSave,
	inboxList,
	inboxResolve
];
