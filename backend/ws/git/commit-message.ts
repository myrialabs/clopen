/**
 * Git Commit Message Generator Handler
 *
 * Uses AI engines to generate structured commit messages from staged diffs.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { execGit } from '../../git/git-executor';
import { projectQueries } from '../../database/queries/project-queries';
import { initializeEngine } from '../../engine';
import type { EngineType } from '$shared/types/unified';
import type { GeneratedCommitMessage } from '$shared/types/git';
import { debug } from '$shared/utils/logger';

const COMMIT_MESSAGE_SCHEMA = {
	type: 'object',
	properties: {
		type: {
			type: 'string',
			enum: ['feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'style', 'perf', 'ci', 'build'],
			description: 'The conventional commit type'
		},
		scope: {
			type: 'string',
			description: 'Optional scope of the change (e.g., component name, module)'
		},
		subject: {
			type: 'string',
			description: 'Short imperative description, lowercase, no period, max 72 chars'
		},
		body: {
			type: 'string',
			description: 'Optional longer description explaining the why behind the change'
		}
	},
	required: ['type', 'subject']
};

export const commitMessageHandler = createRouter()
	.http('git:generate-commit-message', {
		data: t.Object({
			projectId: t.String(),
			engine: t.String(),
			providerSlug: t.String(),
			modelId: t.String(),
			format: t.Union([t.Literal('single-line'), t.Literal('multi-line')])
		}),
		response: t.Object({
			message: t.String()
		})
	}, async ({ data }) => {
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');

		// Get raw staged diff text
		const diffResult = await execGit(['diff', '--cached'], project.path);
		const rawDiff = diffResult.stdout;

		if (!rawDiff.trim()) {
			throw new Error('No staged changes to generate a commit message for');
		}

		const engineType = data.engine as EngineType;
		const engine = await initializeEngine(engineType);

		if (!engine.generateStructured) {
			throw new Error(`Engine "${engineType}" does not support structured generation`);
		}

		const formatInstruction = data.format === 'multi-line'
			? 'Generate a multi-line conventional commit message with type, scope, subject, AND body fields. The body should explain WHY the change was made.'
			: 'Generate a single-line conventional commit message with type, optional scope, and subject. Leave body empty.';

		const prompt = `Analyze the following git diff and generate a conventional commit message.

Rules:
- type: one of feat, fix, refactor, docs, test, chore, style, perf, ci, build
- scope: optional, the area of the codebase affected (e.g., git, settings, engine)
- subject: imperative mood, lowercase, no period at end, max 72 characters
- ${formatInstruction}

Git diff:
${rawDiff}`;

		debug.log('git', `Generating commit message via ${engineType}/${data.modelId}`);

		const result = await engine.generateStructured<GeneratedCommitMessage>({
			prompt,
			providerSlug: data.providerSlug,
			modelId: data.modelId,
			schema: COMMIT_MESSAGE_SCHEMA,
			projectPath: project.path
		});

		// Format structured output into conventional commit string
		const scopePart = result.scope ? `(${result.scope})` : '';
		const subject = `${result.type}${scopePart}: ${result.subject}`;

		let message = subject;
		if (data.format === 'multi-line' && result.body) {
			message = `${subject}\n\n${result.body}`;
		}

		return { message };
	});
