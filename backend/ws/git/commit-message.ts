/**
 * Git Commit Message Generator Handler
 *
 * Uses AI engines to generate structured commit messages from staged diffs.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { buildBudgetedStagedDiff, COMMIT_MESSAGE_BUDGET } from './diff-budget';
import { initializeEngine } from '../../engine';
import { resolveGenerationTarget } from '../../engine/resolve-model';
import type { EngineType } from '$shared/types/unified';
import type { GeneratedCommitMessage } from '$shared/types/git';
import { debug } from '$shared/utils/logger';
import { requireProjectWorkspace } from '../access';

// Schema is shaped to satisfy OpenAI's strict structured-output mode (used by
// Codex via `outputSchema`): every object must declare `additionalProperties:
// false`, every property must appear in `required`, and optional fields are
// expressed as nullable type unions rather than being absent from `required`.
// Claude/OpenCode/Copilot/Qwen accept this same shape — strict is the lowest
// common denominator.
const COMMIT_MESSAGE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		type: {
			type: 'string',
			enum: ['feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'style', 'perf', 'ci', 'build'],
			description: 'The conventional commit type'
		},
		scope: {
			type: ['string', 'null'],
			description: 'Scope of the change (e.g., component name, module). Null when no scope applies.'
		},
		subject: {
			type: 'string',
			description: 'Short imperative description, lowercase, no period, max 72 chars'
		},
		body: {
			type: ['string', 'null'],
			description: 'Longer description explaining the why behind the change. Null for single-line commits.'
		}
	},
	required: ['type', 'scope', 'subject', 'body']
};
import path from 'node:path';

function resolveRepoCwd(projectPath: string, repoPath: string | undefined): string {
	if (!repoPath) return projectPath;
	const resolved = path.resolve(repoPath);
	const projectRoot = path.resolve(projectPath);
	const sep = path.sep;
	if (resolved !== projectRoot && !resolved.startsWith(projectRoot + sep)) {
		debug.warn('git', `Rejected nested repoPath outside project: ${resolved}`);
		return projectPath;
	}
	return resolved;
}

export const commitMessageHandler = createRouter()
	.http('git:generate-commit-message', {
		data: t.Object({
			projectId: t.String(),
			engine: t.String(),
			/** Hint only — the provider is re-derived from the engine catalog. */
			providerSlug: t.Optional(t.String()),
			modelId: t.String(),
			format: t.Union([t.Literal('single-line'), t.Literal('multi-line')]),
			customPrompt: t.Optional(t.String()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const { root } = requireProjectWorkspace(conn, data.projectId);
		const cwd = resolveRepoCwd(root, data.repoPath);

		// A budgeted view of the staged change, not the raw diff — see diff-budget.ts.
		const diff = await buildBudgetedStagedDiff(cwd, COMMIT_MESSAGE_BUDGET);
		if (diff.isEmpty) {
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

		// When the diff was sampled, say so: without this the model describes only
		// the files it happened to see and writes a subject that misses the change.
		const coverageNote = diff.truncated
			? '\n- The diff below is a sample. Describe the change as a whole using the file list, not just the visible hunks.'
			: '';

		const defaultPrompt = `Analyze the following staged git change and generate a conventional commit message.

Rules:
- type: one of feat, fix, refactor, docs, test, chore, style, perf, ci, build
- scope: optional, the area of the codebase affected (e.g., git, settings, engine)
- subject: imperative mood, lowercase, no period at end, max 72 characters
- ${formatInstruction}${coverageNote}

${diff.text}`;

		const extra = data.customPrompt?.trim();
		const prompt = extra
			? `${defaultPrompt}\n\nAdditional constraints:\n${extra}`
			: defaultPrompt;

		// The caller's providerSlug/account can be stale (see resolve-model.ts).
		const target = await resolveGenerationTarget(engine, data.modelId, data.providerSlug);

		debug.log('git', `Generating commit message via ${engineType}/${target.providerSlug}/${target.modelId}`);

		const result = await engine.generateStructured<GeneratedCommitMessage>({
			prompt,
			providerSlug: target.providerSlug,
			modelId: target.modelId,
			schema: COMMIT_MESSAGE_SCHEMA,
			projectPath: cwd,
			...(target.accountId != null && { accountId: target.accountId })
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
