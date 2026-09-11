/**
 * "Start work" — from a work item to an agent that is already working.
 *
 * Four things happen, in an order chosen so a failure never leaves a mess:
 *
 *   1. Read the item (body + comments) while nothing has been created yet, so a
 *      provider outage costs nothing.
 *   2. Create the worktree — the expensive, visible step.
 *   3. Create the branch inside it. Best effort: a project that is not a git
 *      repository, or one whose branch name is already taken, still gets a
 *      worktree and a session. Losing the whole action over a branch name would
 *      be a poor trade.
 *   4. Create the session, record the link, and compose the first message.
 *
 * The state transition runs last and NEVER fails the action. Moving a ticket is
 * a courtesy; the worktree and the session are the thing the user asked for, and
 * throwing away both because a label change was rejected would be absurd.
 */

import { sessionQueries, workLinkQueries } from '$backend/database/queries';
import { gitService } from '$backend/git/git-service';
import { createWorktree } from '$backend/worktrees';
import type { EngineType } from '$shared/types/unified';
import type { StartWorkResult, WorkItemDetail, WorkItemKind } from '$shared/types/work';
import { workService } from './service';
import { buildStartWorkPrompt } from './prompts';
import { debug } from '$shared/utils/logger';

/** Worktree names are capped at 80 by the create route; leave room for the id. */
const MAX_WORKTREE_NAME = 60;

/**
 * A branch-safe slug.
 *
 * git refuses a lot of things in a ref name — spaces, `..`, `~`, `^`, `:`, a
 * trailing dot, a leading dash. Rather than encode that rule set, this reduces
 * to `[a-z0-9-]`, which is a strict subset of what git allows and also survives
 * being a directory name on Windows.
 */
function slugify(text: string, maxWords = 6): string {
	return text
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^\w\s-]/g, ' ')
		.trim()
		.split(/[\s_-]+/)
		.filter(Boolean)
		.slice(0, maxWords)
		.join('-')
		.slice(0, 50)
		.replace(/^-+|-+$/g, '');
}

/** Fill the binding's branch template. Unknown placeholders are left alone. */
export function renderBranchName(template: string, item: { kind: WorkItemKind; identifier: string; title: string }): string {
	const slug = slugify(item.title);
	const rendered = template
		.replace(/\{kind\}/g, item.kind === 'pull-request' ? 'pr' : 'issue')
		.replace(/\{identifier\}/g, slugify(item.identifier, 3) || item.identifier)
		.replace(/\{slug\}/g, slug)
		.replace(/\/{2,}/g, '/')
		.replace(/-{2,}/g, '-')
		.replace(/[-/]+$/g, '');

	// A template that rendered to nothing (an item with an unslugifiable title
	// and a template of only `{slug}`) would produce `git checkout -b ""`.
	return rendered || `work/${item.identifier}`;
}

function worktreeNameFor(item: { identifier: string; title: string }): string {
	const name = `#${item.identifier} ${item.title}`.trim();
	return name.length > MAX_WORKTREE_NAME ? `${name.slice(0, MAX_WORKTREE_NAME - 1)}…` : name;
}

export async function startWork(input: {
	projectId: string;
	accountId: string;
	kind: WorkItemKind;
	itemId: string;
	engine: EngineType;
	userId: string;
}): Promise<StartWorkResult> {
	const { adapter, context } = workService.require(input.projectId, input.accountId);

	const item: WorkItemDetail = await adapter.get(context, input.kind, input.itemId);

	// Starting work on a PULL REQUEST means reviewing code that already exists,
	// so the branch is checked out rather than invented. Starting work on an
	// ISSUE means writing code that does not, so a branch is created from the
	// template. Getting this backwards would drop someone into an empty branch
	// and ask them to review it.
	const plan: BranchPlan = item.kind === 'pull-request' && item.headBranch
		? { mode: 'checkout', name: item.headBranch }
		: { mode: 'create', name: renderBranchName(context.binding.config.branchTemplate, item) };

	const worktree = await createWorktree({
		projectId: input.projectId,
		name: worktreeNameFor(item),
		createdBy: input.userId
	});

	const branch = await applyBranchPlan(worktree.worktree.path, plan);

	const session = sessionQueries.create({
		project_id: input.projectId,
		title: worktreeNameFor(item),
		engine: input.engine,
		started_at: new Date().toISOString(),
		worktree_id: worktree.worktree.id
	});

	workLinkQueries.upsert({
		projectId: input.projectId,
		accountId: input.accountId,
		itemKind: input.kind,
		itemIdentifier: item.identifier,
		itemTitle: item.title,
		itemUrl: item.url,
		worktreeId: worktree.worktree.id,
		sessionId: session.id,
		branch
	});

	const transition = await applyTransition(
		context.binding.config.transitionOnStartWork,
		input,
		item.kind,
		item.id
	);

	return {
		worktreeId: worktree.worktree.id,
		worktreeName: worktree.worktree.name,
		sessionId: session.id,
		branch,
		prompt: buildStartWorkPrompt(item, {
			branch,
			branchMode: plan.mode,
			locator: adapter.describeLocator(context.binding.locator)
		}),
		transitionedTo: transition.applied,
		transitionError: transition.error,
		needsSetup: !worktree.carriedIgnoredFiles
	};
}

interface BranchPlan {
	/** `create` invents a branch; `checkout` moves onto one that already exists. */
	mode: 'create' | 'checkout';
	name: string;
}

/**
 * Put the new worktree on the right branch, best effort.
 *
 * Every failure here degrades to "the worktree is on whatever branch it cloned
 * with", which is still a usable session. Losing the worktree, the session and
 * the prompt because a branch name was taken would be a much worse trade — and
 * a project that is not a git repository at all still deserves the session.
 */
async function applyBranchPlan(cwd: string, plan: BranchPlan): Promise<string> {
	try {
		if (plan.mode === 'create') {
			await gitService.createBranch(cwd, plan.name);
			return plan.name;
		}

		// The pull request's branch may exist locally, may only exist on the
		// remote, or may not have been fetched into this clone yet — so fetch
		// first, try the local checkout, and fall back to branching off the
		// remote-tracking ref.
		await gitService.fetch(cwd, 'origin').catch(() => '');
		try {
			await gitService.switchBranch(cwd, plan.name);
		} catch {
			await gitService.createBranch(cwd, plan.name, `origin/${plan.name}`);
		}
		return plan.name;
	} catch (error) {
		debug.warn('work', `Could not put the worktree on "${plan.name}":`, error);
		// Report the branch the work is actually on, not the one we wanted: a PR
		// composer prefilled with a branch that does not exist is worse than one
		// that has to ask.
		return currentBranch(cwd);
	}
}

/** The branch the worktree ended up on, or a readable placeholder. */
async function currentBranch(cwd: string): Promise<string> {
	try {
		const info = await gitService.getBranches(cwd);
		return info.current || 'HEAD';
	} catch {
		return 'HEAD';
	}
}

/**
 * Apply a configured transition, reporting rather than throwing.
 *
 * Both outcomes are returned so the UI can be honest: "moved to In Progress" and
 * "could not move it — you are not a collaborator" are different messages, and
 * silence would be worse than either.
 */
async function applyTransition(
	state: string | null,
	input: { projectId: string; accountId: string },
	kind: WorkItemKind,
	itemId: string
): Promise<{ applied: string | null; error: string | null }> {
	if (!state) return { applied: null, error: null };

	try {
		await workService.transition(input.projectId, input.accountId, kind, itemId, state);
		return { applied: state, error: null };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		debug.warn('work', `Configured transition to "${state}" failed:`, error);
		return { applied: null, error: detail };
	}
}

/** Exported for the PR flow, which applies its own configured transition. */
export async function applyConfiguredTransition(
	projectId: string,
	accountId: string,
	kind: WorkItemKind,
	itemId: string,
	state: string | null
): Promise<{ applied: string | null; error: string | null }> {
	return applyTransition(state, { projectId, accountId }, kind, itemId);
}
