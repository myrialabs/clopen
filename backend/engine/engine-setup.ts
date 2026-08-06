/**
 * Pre-stream engine readiness check.
 *
 * Before an engine streams, verify it is actually usable and, when it is not,
 * return an actionable message that routes the user to the right place:
 *   - SDK missing or version-mismatched → Settings → Stack (install / update)
 *   - required account not set up        → Settings → Engines (sign in)
 *
 * SDK readiness is checked first, so a not-installed engine is fixed before an
 * account is asked for. The message text embeds the literal "Settings → Stack" /
 * "Settings → Engines" phrases; the chat error renderer
 * (`frontend/components/chat/formatters/ErrorMessage.svelte`) turns those into
 * clickable buttons that open the matching settings section.
 */

import type { EngineType } from '$shared/types/unified';
import { readEngineSdkVersion, getRequiredSdkVersion } from './sdk-loader';

/** Primary SDK package clopen imports for each engine. */
const ENGINE_SDK: Record<EngineType, string> = {
	'claude-code': '@anthropic-ai/claude-agent-sdk',
	opencode: '@opencode-ai/sdk',
	copilot: '@github/copilot-sdk',
	codex: '@openai/codex-sdk',
	qwen: '@qwen-code/sdk',
	pi: '@earendil-works/pi-coding-agent',
	cline: '@cline/sdk',
	cursor: '@cursor/sdk',
};

/**
 * Engines that require a signed-in account/credential before use. OpenCode
 * ships built-in providers and works without one, so it is exempt.
 */
const ENGINES_WITHOUT_ACCOUNT = new Set<EngineType>(['opencode']);

export interface EngineSetupIssue {
	reason: 'not-installed' | 'needs-update' | 'needs-account';
	message: string;
}

/**
 * Returns null when the engine is ready to stream, or an actionable issue.
 * @param accountId the resolved account id for this request (0 = none selected).
 */
export function checkEngineSetup(engine: EngineType, accountId: number): EngineSetupIssue | null {
	const sdkPkg = ENGINE_SDK[engine];
	const installed = readEngineSdkVersion(sdkPkg);
	const required = getRequiredSdkVersion(sdkPkg);

	if (installed === null) {
		return {
			reason: 'not-installed',
			message: `Engine "${engine}" is not installed. Open Settings → Stack to install it before using this engine.`
		};
	}
	if (required !== null && installed !== required) {
		return {
			reason: 'needs-update',
			message:
				`Engine "${engine}" needs an update (installed ${installed}, required ${required}). ` +
				`Open Settings → Stack to update it before using this engine.`
		};
	}
	if (!ENGINES_WITHOUT_ACCOUNT.has(engine) && accountId === 0) {
		return {
			reason: 'needs-account',
			message: `Engine "${engine}" has no account set up. Open Settings → Engines to sign in before using this engine.`
		};
	}
	return null;
}
