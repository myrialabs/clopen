/**
 * What a worktree's branch is called at the provider.
 *
 * This is not cosmetic. The name is the ONLY thing that can tie a leaked branch
 * back to Clopen, because no provider here lets a client set arbitrary metadata
 * on a branch — Neon's `creation_source` is read-only, and there is no tag or
 * label field. So when a crash lands between "the provider created it" and "the
 * row was written", the name is the whole of the evidence.
 *
 * Hence: deterministic, prefixed, and slugged down to a character class every
 * provider accepts. Slashes are kept because Neon uses them itself (its GitHub
 * integration creates `preview/pr-123-…`), and they make the prefix read as a
 * namespace rather than as a word someone might have chosen.
 */

import { BRANCH_NAME_PREFIX } from '$shared/types/worktree-branching';

/**
 * A provider-safe slug.
 *
 * Reduced to `[a-z0-9-]`, which is a strict subset of what Neon and Turso
 * accept, rather than encoding either one's rules. The same trade `start-work`
 * makes for git ref names, for the same reason: a subset that always works
 * beats a rule set that has to be kept in step with two vendors.
 */
export function slugifyForBranch(text: string, maxLength = 40): string {
	return text
		.toLowerCase()
		.normalize('NFKD')
		// Drop the combining marks NFKD just separated out, BEFORE the character
		// class runs. Without this `ü` decomposes to `u` + a diaeresis, the class
		// turns that mark into a space, and "münchen" slugs to `mu-nchen` — a name
		// that splits a word in half and, worse, is not the name anyone would
		// search the provider's console for.
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^\w\s-]/g, ' ')
		.trim()
		.split(/[\s_-]+/)
		.filter(Boolean)
		.join('-')
		.slice(0, maxLength)
		.replace(/^-+|-+$/g, '');
}

/**
 * The branch name for one worktree.
 *
 * The worktree SLUG is used rather than its name, and that is deliberate: a
 * slug is already unique within its project (`uniqueWorktreeSlug` guarantees
 * it), so two worktrees called "fix login" cannot collide here either. Using
 * the display name would reintroduce the collision the slug exists to solve.
 */
export function branchNameFor(input: { projectName: string; worktreeSlug: string }): string {
	const project = slugifyForBranch(input.projectName, 30) || 'project';
	const worktree = slugifyForBranch(input.worktreeSlug, 40) || 'worktree';
	return `${BRANCH_NAME_PREFIX}/${project}/${worktree}`;
}

/**
 * The DATABASE name for a worktree's copy.
 *
 * A different function from `branchNameFor` because it answers to a different
 * rule set. A Neon branch name may contain slashes and is only ever read by
 * humans; a database name is an SQL identifier, capped at 63 bytes by Postgres,
 * and is about to be interpolated into DDL. So: underscores rather than
 * slashes, `[a-z0-9_]` only, and length enforced here rather than discovered as
 * a truncation by the server.
 *
 * The prefix survives the cap. It is what `isClopenDatabaseName` matches, and
 * therefore the only thing that lets the orphan sweep recognise a database a
 * crash left behind.
 */
export function branchDatabaseNameFor(input: {
	projectName: string;
	worktreeSlug: string;
}): string {
	const project = slugifyForBranch(input.projectName, 20).replace(/-/g, '_') || 'project';
	const worktree = slugifyForBranch(input.worktreeSlug, 24).replace(/-/g, '_') || 'worktree';
	return `${BRANCH_NAME_PREFIX}_${project}_${worktree}`.slice(0, 63).replace(/_+$/, '');
}

/** Whether a database on the server looks like one Clopen made. */
export function isClopenDatabaseName(name: string): boolean {
	return name.startsWith(`${BRANCH_NAME_PREFIX}_`);
}

/**
 * Whether a branch at the provider looks like one of ours.
 *
 * Used only to decide what the orphan sweep is allowed to OFFER for deletion —
 * never to delete anything automatically. A user who happens to name a branch
 * `clopen/...` by hand would otherwise see it proposed for deletion, which is
 * why the sweep reports and the user decides.
 */
export function isClopenBranchName(name: string): boolean {
	return name.startsWith(`${BRANCH_NAME_PREFIX}/`);
}
