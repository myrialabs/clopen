/**
 * The prompts this surface sends into a chat session.
 *
 * They live on the SERVER, next to the data that fills them, for the same
 * reason the git panel's conflict prompt does not: this text is assembled from
 * a provider response the client never receives in full, and duplicating the
 * assembly on both sides would mean two versions of the instructions to keep in
 * step.
 *
 * A budget applies to everything variable. An issue with 200 comments is not
 * rare, and pasting all of them turns "start work" into a request that costs
 * more than the work.
 */

import type { CheckLogBundle, WorkItemDetail } from '$shared/types/work';

/** Body text kept from the item itself. Enough for a detailed bug report. */
const MAX_BODY_CHARS = 8_000;
/** Comments are where a thread goes off-topic, so they get a tighter budget. */
const MAX_COMMENTS = 12;
const MAX_COMMENT_CHARS = 1_200;

function clip(text: string, limit: number): string {
	const trimmed = (text ?? '').trim();
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit)}\n… truncated, ${trimmed.length - limit} more characters — read the item online for the rest`;
}

/**
 * Comments, newest last, oldest dropped first.
 *
 * Dropping from the FRONT is the right direction here and the wrong one for CI
 * logs: a long issue thread converges on the current understanding, so the last
 * comments are the ones that matter.
 */
function renderComments(item: WorkItemDetail): string {
	if (item.comments.length === 0) return '';

	const kept = item.comments.slice(-MAX_COMMENTS);
	const dropped = item.comments.length - kept.length;
	const rendered = kept
		.map((comment) => `**${comment.author}** (${comment.createdAt}):\n${clip(comment.body, MAX_COMMENT_CHARS)}`)
		.join('\n\n---\n\n');

	const header = dropped > 0
		? `Comments (${kept.length} most recent of ${item.comments.length}):`
		: `Comments (${item.comments.length}):`;

	return `${header}\n\n${rendered}`;
}

/** The first message of a session started from a work item. */
export function buildStartWorkPrompt(
	item: WorkItemDetail,
	context: { branch: string; branchMode: 'create' | 'checkout'; locator: string }
): string {
	const sections: string[] = [
		`Work on ${item.kind === 'pull-request' ? 'pull request' : 'issue'} #${item.identifier} from ${context.locator}.`,
		`**${item.title}**\n${item.url}`
	];

	const facts: string[] = [`State: ${item.state}`];
	if (item.labels.length > 0) facts.push(`Labels: ${item.labels.join(', ')}`);
	if (item.assignees.length > 0) facts.push(`Assigned to: ${item.assignees.join(', ')}`);
	if (item.author) facts.push(`Opened by: ${item.author}`);
	sections.push(facts.join(' · '));

	sections.push(item.body.trim()
		? `Description:\n\n${clip(item.body, MAX_BODY_CHARS)}`
		: 'The item has no description.');

	const comments = renderComments(item);
	if (comments) sections.push(comments);

	// The environment matters, and it differs by kind: an agent told it is on a
	// new branch will not go looking for existing work, and an agent NOT told it
	// is on a review branch will offer to create one.
	sections.push(
		context.branchMode === 'create'
			? [
				'You are in a fresh worktree of this project, already on a new branch:',
				`\`${context.branch}\``,
				'',
				'Start by reading the relevant code to confirm the description matches what is actually there, then say what you plan to change before changing it. Do not commit or push anything unless asked.'
			].join('\n')
			: [
				'You are in a fresh worktree of this project, with the pull request branch checked out:',
				`\`${context.branch}\``,
				'',
				'The change is already here — read it before anything else. Summarise what it does, then say what you think is wrong with it or what it is missing. Do not commit or push anything unless asked.'
			].join('\n')
	);

	return sections.join('\n\n');
}

/** The message sent when a failing CI run is pushed into the chat. */
export function buildCheckLogPrompt(
	bundle: CheckLogBundle,
	context: { locator: string; branch: string; runUrl: string }
): string {
	return [
		`A CI run failed on \`${context.branch}\` in ${context.locator}.`,
		`**${bundle.runName}**\n${context.runUrl}`,
		bundle.truncated
			? 'Logs from the failed jobs (tails only — earlier output was dropped to fit):'
			: 'Logs from the failed jobs:',
		bundle.text,
		'Work out what failed and why from these logs, check the claim against the code in this worktree, and propose the smallest fix that addresses the cause. If the logs are not enough to tell, say what else you need rather than guessing.'
	].join('\n\n');
}

/** The instruction that drafts a pull-request description. */
export function buildPrDescriptionPrompt(input: {
	branch: string;
	base: string;
	commits: { hash: string; subject: string }[];
	linkedItem: { identifier: string; title: string | null } | null;
	diff: string;
	diffTruncated: boolean;
}): string {
	const sections: string[] = [
		`Write a pull request description for merging \`${input.branch}\` into \`${input.base}\`.`
	];

	if (input.linkedItem) {
		sections.push(
			`This branch was started from issue #${input.linkedItem.identifier}${input.linkedItem.title ? ` ("${input.linkedItem.title}")` : ''}. Reference it in the description.`
		);
	}

	if (input.commits.length > 0) {
		sections.push(`Commits on this branch:\n${input.commits.map((c) => `- ${c.subject}`).join('\n')}`);
	}

	sections.push(
		[
			'Rules:',
			'- title: one line, imperative, no trailing period. If the commits follow a convention, follow it.',
			'- body: markdown. Lead with what changed and why, in prose. Add a short bullet list only when the change touches several unrelated areas.',
			'- Describe only what is in the diff. Do not invent testing that was not done, and do not promise follow-up work.',
			input.diffTruncated
				? '- The diff below is a sample. Describe the change as a whole using the file list, not only the visible hunks.'
				: ''
		].filter(Boolean).join('\n')
	);

	sections.push(input.diff);
	return sections.join('\n\n');
}
