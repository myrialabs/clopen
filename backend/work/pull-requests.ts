/**
 * The pull-request loop: from the branch in front of you to an open PR.
 *
 * This is where local git and the remote provider meet, and the rule from the
 * spec applies literally — local state comes from `git-service`, remote state
 * comes from the adapter, and neither is used to guess the other. In particular
 * "has this branch been pushed" is answered by git's own upstream tracking, not
 * by asking GitHub whether a branch with that name exists: those two questions
 * have different answers on any repository where someone else pushed a branch
 * with the same name.
 */

import { execGit } from '$backend/git/git-executor';
import { gitService } from '$backend/git/git-service';
import { workLinkQueries } from '$backend/database/queries';
import { initializeEngine } from '$backend/engine';
import { resolveGenerationTarget } from '$backend/engine/resolve-model';
import { buildBudgetedDiff, PR_DESCRIPTION_BUDGET, rangeScope } from '$backend/ws/git/diff-budget';
import type { EngineType } from '$shared/types/unified';
import type { GitBranchInfo } from '$shared/types/git';
import type { PullRequestContext, WorkItemLink } from '$shared/types/work';
import { workService } from './service';
import { buildPrDescriptionPrompt } from './prompts';
import { debug } from '$shared/utils/logger';

/** Enough to describe a branch; a 400-commit branch is not going to be summarised. */
const MAX_COMMITS = 30;

const PR_DESCRIPTION_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		title: {
			type: 'string',
			description: 'One line, imperative mood, no trailing period'
		},
		body: {
			type: 'string',
			description: 'Markdown body describing what changed and why'
		}
	},
	required: ['title', 'body']
};

interface GeneratedDescription {
	title: string;
	body: string;
}

function toLinkInfo(row: ReturnType<typeof workLinkQueries.getByBranch>): WorkItemLink | null {
	if (!row) return null;
	return {
		itemKind: row.item_kind,
		itemIdentifier: row.item_identifier,
		worktreeId: row.worktree_id,
		worktreeName: null,
		sessionId: row.session_id,
		branch: row.branch,
		createdAt: row.created_at
	};
}

/** Commits on `head` that are not on `base`, newest first. */
async function commitsBetween(cwd: string, base: string, head: string): Promise<{ hash: string; subject: string }[]> {
	// `--no-merges` because a merge commit's subject ("Merge branch 'main' into
	// x") describes housekeeping, not the change being proposed.
	const result = await execGit(
		['log', '--no-merges', `--max-count=${MAX_COMMITS}`, '--format=%h%x1f%s', `${base}..${head}`],
		cwd
	);
	if (result.exitCode !== 0) return [];

	return result.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [hash, subject] = line.split('\x1f');
			return { hash: hash ?? '', subject: subject ?? '' };
		})
		.filter((entry) => entry.hash);
}

/** Local branches that could plausibly be a merge target. */
function baseCandidates(branches: GitBranchInfo, head: string, preferred: string): string[] {
	const candidates = new Set<string>([preferred]);
	for (const branch of branches.local) {
		if (branch.name !== head) candidates.add(branch.name);
	}
	// A remote-only base is legitimate: the default branch often has no local
	// copy in a fresh worktree that was created straight onto a feature branch.
	for (const branch of branches.remote) {
		const short = branch.name.replace(/^[^/]+\//, '');
		if (short !== head) candidates.add(short);
	}
	return [...candidates];
}

/**
 * Local branches this pull request could come FROM.
 *
 * Only local ones: the composer reads commits, upstream state and the linked
 * item out of this worktree, and none of those questions have an answer for a
 * branch that exists only on the remote.
 */
function headCandidates(branches: GitBranchInfo, current: string): string[] {
	const candidates = new Set<string>();
	if (current) candidates.add(current);
	for (const branch of branches.local) candidates.add(branch.name);
	return [...candidates];
}

/**
 * Everything the composer needs, in one round trip.
 *
 * Assembled server-side because half of it is git and half is the provider, and
 * a client doing this would need five calls and a way to keep them consistent.
 */
export async function buildPullRequestContext(
	projectId: string,
	accountId: string,
	cwd: string,
	/**
	 * Branch to open FROM, when the user picked one other than the checked-out
	 * branch. Everything else is then answered about that branch — its commits,
	 * its upstream, the item it was started from — because a composer that lets
	 * you choose a head and keeps describing a different one is worse than one
	 * that does not let you choose at all.
	 */
	requestedHead?: string
): Promise<PullRequestContext> {
	const branches = await gitService.getBranches(cwd);
	const heads = headCandidates(branches, branches.detached ? '' : branches.current);

	const head = requestedHead && heads.includes(requestedHead) ? requestedHead : branches.current;
	if (!head || (branches.detached && !requestedHead)) {
		throw new Error('This worktree is not on a branch, so there is nothing to open a pull request from');
	}

	// Always the repository's default branch, even when that is also the head.
	// Guessing a different base to avoid the clash would propose a merge nobody
	// asked for; the composer states the clash and lets the user resolve it,
	// which it can now do because both sides are a dropdown.
	const base = await workService.defaultBranch(projectId, accountId);

	const pushTarget = await gitService.getPushTarget(cwd, head);
	const existing = await workService.findPullRequestForBranch(projectId, accountId, head).catch((error) => {
		// A lookup failure must not block the composer — the worst case is
		// offering to create a PR that already exists, which the provider then
		// rejects with a clear message of its own.
		debug.warn('work', 'Could not check for an existing pull request:', error);
		return null;
	});

	return {
		head,
		base,
		baseCandidates: baseCandidates(branches, head, base),
		headCandidates: heads,
		isPushed: pushTarget.hasUpstream,
		pushRemote: pushTarget.remote,
		commits: await commitsBetween(cwd, base, head),
		existing,
		linkedItem: toLinkInfo(workLinkQueries.getByBranch(projectId, head))
	};
}

/**
 * Push the branch a pull request would come from, then re-read the context.
 *
 * The composer used to state the problem and send the user to the Git panel,
 * which is a correct instruction and a poor one: the branch is named right
 * there, the destination is the one git already records, and coming back means
 * re-opening the composer and re-typing whatever was in the form. Pushing is
 * the only missing step and it is not a destructive one — `-u` on a branch that
 * tracks nothing creates an upstream, it cannot overwrite one.
 */
export async function pushPullRequestHead(
	projectId: string,
	accountId: string,
	cwd: string,
	head: string
): Promise<PullRequestContext> {
	const result = await gitService.push(cwd, 'origin', head, false);
	if (!result.success) throw new Error(result.message || `Could not push ${head}`);

	debug.log('work', `Pushed ${head} for a pull request`);
	return buildPullRequestContext(projectId, accountId, cwd, head);
}

/**
 * Draft a title and body from the branch's diff.
 *
 * Reuses the git generator's model override (Settings → Models → Git) rather
 * than adding a fourth "which model writes this" setting: writing a PR
 * description is the same kind of work as writing a commit message, and a user
 * who tuned one has already answered for the other.
 */
export async function draftPullRequestDescription(input: {
	projectId: string;
	cwd: string;
	base: string;
	head: string;
	engine: EngineType;
	providerSlug?: string;
	modelId: string;
}): Promise<GeneratedDescription> {
	const scope = rangeScope(input.base, input.head);
	const diff = await buildBudgetedDiff(input.cwd, PR_DESCRIPTION_BUDGET, scope);
	if (diff.isEmpty) {
		throw new Error(`There are no ${scope.emptyLabel} to describe`);
	}

	const engine = await initializeEngine(input.engine);
	if (!engine.generateStructured) {
		throw new Error(`Engine "${input.engine}" does not support structured generation`);
	}

	const link = workLinkQueries.getByBranch(input.projectId, input.head);
	const prompt = buildPrDescriptionPrompt({
		branch: input.head,
		base: input.base,
		commits: await commitsBetween(input.cwd, input.base, input.head),
		linkedItem: link ? { identifier: link.item_identifier, title: link.item_title } : null,
		diff: diff.text,
		diffTruncated: diff.truncated
	});

	const target = await resolveGenerationTarget(engine, input.modelId, input.providerSlug);
	debug.log('work', `Drafting a PR description via ${input.engine}/${target.providerSlug}/${target.modelId}`);

	const result = await engine.generateStructured<GeneratedDescription>({
		prompt,
		providerSlug: target.providerSlug,
		modelId: target.modelId,
		schema: PR_DESCRIPTION_SCHEMA,
		projectPath: input.cwd,
		...(target.accountId != null && { accountId: target.accountId })
	});

	return { title: (result.title ?? '').trim(), body: (result.body ?? '').trim() };
}
