/**
 * The prompt this surface sends into a chat session.
 *
 * It lives on the SERVER, next to the data that fills it, for the same reason
 * the Issues surface's prompts do: the text is assembled from a provider
 * response the client never receives in full, and duplicating the assembly on
 * both sides would mean two versions of the instructions to keep in step.
 */

import type { BuildLogBundle, DeploymentDetail } from '$shared/types/deployments';

/** Commit subject kept from the build. Enough to identify what was deployed. */
const MAX_COMMIT_CHARS = 500;

function clip(text: string, limit: number): string {
	const trimmed = (text ?? '').trim();
	return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

/**
 * The message sent when a failed build is pushed into the chat.
 *
 * The facts come before the log on purpose. `errorCode` is often the whole
 * answer — `BUILD_FAILED` versus a function size limit versus an out-of-memory
 * report are three different investigations — and an agent that reads it first
 * does not have to infer it from the tail of a log.
 */
export function buildDeployFailurePrompt(
	deployment: DeploymentDetail,
	bundle: BuildLogBundle,
	context: { projectName: string; providerName: string }
): string {
	const sections: string[] = [
		`A ${deployment.environment} deployment failed on ${context.providerName} for ${context.projectName}.`
	];

	const facts: string[] = [`State: ${deployment.stateDetail}`];
	if (deployment.errorCode) facts.push(`Error code: ${deployment.errorCode}`);
	if (deployment.branch) facts.push(`Branch: ${deployment.branch}`);
	if (deployment.commitSha) facts.push(`Commit: ${deployment.commitSha.slice(0, 8)}`);
	if (deployment.framework) facts.push(`Framework: ${deployment.framework}`);
	sections.push(facts.join(' · '));

	if (deployment.commitMessage) {
		sections.push(`Commit message:\n${clip(deployment.commitMessage, MAX_COMMIT_CHARS)}`);
	}
	if (deployment.errorMessage) {
		sections.push(`Provider message:\n${deployment.errorMessage}`);
	}
	if (deployment.inspectorUrl) {
		sections.push(`Build page: ${deployment.inspectorUrl}`);
	}

	sections.push(
		bundle.truncated
			? 'Build log (tail only — earlier output was dropped to fit):'
			: 'Build log:'
	);
	sections.push(`\`\`\`\n${bundle.text}\n\`\`\``);

	sections.push(
		[
			'Work out what failed and why from this log, then check the claim against the code in this worktree before proposing anything.',
			'A deployment build runs in a clean environment, so treat "works locally" as evidence that the cause is configuration, a missing dependency, an environment variable, or a build-only code path — not as evidence the log is wrong.',
			'Propose the smallest change that addresses the cause. If the log is not enough to tell, say what else you need rather than guessing.'
		].join(' ')
	);

	return sections.join('\n\n');
}
