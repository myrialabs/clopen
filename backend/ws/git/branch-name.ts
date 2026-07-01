/**
 * Git Branch Name Generator Handler
 *
 * Uses AI engines to generate a branch name from staged diffs before commit.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { execGit } from '../../git/git-executor';
import { initializeEngine } from '../../engine';
import type { EngineType } from '$shared/types/unified';
import type { GeneratedBranchName } from '$shared/types/git';
import {
	DEFAULT_BRANCH_NAME_PREFIX,
	DEFAULT_BRANCH_SEPARATOR,
	MAX_BRANCH_SEPARATOR_LENGTH,
	RELEASE_BRANCH_NAME_PREFIX,
	TEST_BRANCH_NAME_PREFIX
} from '$shared/constants/git';
import { debug } from '$shared/utils/logger';
import { requireProjectAccess } from '../access';

const INVALID_BRANCH_SEPARATOR_CHARS = /[\s\0~^:?*[\]\\]+/g;
const GENERATED_BRANCH_PREFIXES = [
	DEFAULT_BRANCH_NAME_PREFIX,
	RELEASE_BRANCH_NAME_PREFIX,
	TEST_BRANCH_NAME_PREFIX
];
const GENERIC_BRANCH_DESCRIPTION_WORDS = new Set([
	'add',
	'added',
	'change',
	'create',
	'fix',
	'implement',
	'improve',
	'make',
	'remove',
	'update'
]);
const MAX_BRANCH_DESCRIPTION_WORDS = 3;

function sanitizeBranchDescription(input: string, maxWords = MAX_BRANCH_DESCRIPTION_WORDS): string {
	const withoutPrefix = GENERATED_BRANCH_PREFIXES.reduce((value, prefix) => {
		return value.replace(new RegExp(`^${prefix}[/#._-]+`, 'i'), '');
	}, input.trim());

	const sanitized = withoutPrefix
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/[._]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^[.-]+|[.-]+$/g, '')
		.slice(0, 72)
		.replace(/[.-]$/g, '');
	const words = sanitized
		.split('-')
		.filter(word => word && !GENERIC_BRANCH_DESCRIPTION_WORDS.has(word))
		.slice(0, maxWords);

	return words.join('-');
}

function normalizeBranchSeparator(input: string | undefined): string {
	const cleaned = (input ?? DEFAULT_BRANCH_SEPARATOR)
		.trim()
		.replace(INVALID_BRANCH_SEPARATOR_CHARS, '')
		.slice(0, MAX_BRANCH_SEPARATOR_LENGTH);

	if (!cleaned || cleaned.includes('..') || cleaned.includes('//') || cleaned.includes('@{')) {
		return DEFAULT_BRANCH_SEPARATOR;
	}
	return cleaned;
}

function getBranchPrefix(currentBranch: string): string {
	if (currentBranch === 'main' || currentBranch === 'master') return RELEASE_BRANCH_NAME_PREFIX;
	if (currentBranch === 'test' || currentBranch === 'testing') return TEST_BRANCH_NAME_PREFIX;
	return DEFAULT_BRANCH_NAME_PREFIX;
}

const BRANCH_NAME_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		description: {
			type: 'string',
			description: 'Very short lowercase kebab-case branch topic, 1-3 words, no prefix'
		}
	},
	required: ['description']
};

function formatCurrentBranchForPrompt(currentBranch: string): string {
	return currentBranch || 'detached or unknown';
}

function createBranchNameInstructions(currentBranch: string, prefix: string, separator: string): string {
	return `Analyze the following staged git diff and generate a git branch name description.

Current branch: ${formatCurrentBranchForPrompt(currentBranch)}
Resolved prefix: ${prefix}

Rules:
- Use this repository format: ${prefix}${separator}<description>
- Prefix is fixed by the current branch: main/master -> release, test/testing -> test, anything else -> dev
- Return only the description field; do not include "${prefix}", "${separator}", or any branch prefix in the description
- description: lowercase kebab-case, 1-3 words maximum, no trailing punctuation
- Prefer the shortest changed area/topic over action phrases: login page changes -> login, auth form changes -> auth-form
- Avoid generic action words like add, fix, update, change, implement, improve, create, remove
- Do not include ticket IDs unless they appear in the diff`;
}

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

export const branchNameHandler = createRouter()
	.http('git:generate-branch-name', {
		data: t.Object({
			projectId: t.String(),
			engine: t.String(),
			providerSlug: t.String(),
			modelId: t.String(),
			branchSeparator: t.Optional(t.String()),
			maxWords: t.Optional(t.Number()),
			customPrompt: t.Optional(t.String()),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({
			branchName: t.String()
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const cwd = resolveRepoCwd(project.path, data.repoPath);

		const diffResult = await execGit(['diff', '--cached'], cwd);
		const rawDiff = diffResult.stdout;

		if (!rawDiff.trim() && !data.customPrompt) {
			throw new Error('No staged changes to generate a branch name for');
		}

		const engineType = data.engine as EngineType;
		const engine = await initializeEngine(engineType);

		if (!engine.generateStructured) {
			throw new Error(`Engine "${engineType}" does not support structured generation`);
		}

		const branchResult = await execGit(['branch', '--show-current'], cwd);
		const currentBranch = branchResult.stdout.trim();
		const prefix = getBranchPrefix(currentBranch);
		const separator = normalizeBranchSeparator(data.branchSeparator);
		const instructions = createBranchNameInstructions(currentBranch, prefix, separator);
		const extra = data.customPrompt?.trim();
		const prompt = `${instructions}${extra ? `\n\nAdditional constraints:\n${extra}` : ''}\n\nGit diff:\n${rawDiff}`;

		debug.log('git', `Generating branch name via ${engineType}/${data.modelId}`);

		const result = await engine.generateStructured<GeneratedBranchName>({
			prompt,
			providerSlug: data.providerSlug,
			modelId: data.modelId,
			schema: BRANCH_NAME_SCHEMA,
			projectPath: cwd
		});

		const description = sanitizeBranchDescription(result.description, data.maxWords ?? MAX_BRANCH_DESCRIPTION_WORDS);
		if (!description) {
			throw new Error('Generated branch description was empty');
		}

		return { branchName: `${prefix}${separator}${description}` };
	});
