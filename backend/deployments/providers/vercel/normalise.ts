/**
 * Turning Vercel's vocabulary into the surface's.
 *
 * Kept out of the adapter so it can be tested without a token, and so the one
 * rule that matters is visible on its own: the panel must never see a Vercel
 * word. `BLOCKED`, `readySubstate` and `target: null` are all facts about
 * Vercel, and every one of them has to be spent here.
 */

import type { Deployment, DeploymentEnvironment, DeploymentState } from '$shared/types/deployments';
import type { VercelDeployment } from './types';

/**
 * Vercel's eight states onto the surface's five.
 *
 * `BLOCKED` is a build waiting on a blocking check, which from a reader's point
 * of view is queued — it has not started and may still start. `DELETED` has no
 * state of its own here because a deleted deployment is filtered out of the
 * list entirely rather than rendered as a row nobody can act on.
 */
export function toState(raw: string | undefined): DeploymentState {
	switch ((raw ?? '').toUpperCase()) {
		case 'READY':
			return 'ready';
		case 'BUILDING':
			return 'building';
		case 'QUEUED':
		case 'INITIALIZING':
		case 'BLOCKED':
			return 'queued';
		case 'CANCELED':
			return 'canceled';
		case 'ERROR':
		case 'DELETED':
		default:
			return 'error';
	}
}

/** True while the provider may still change this deployment's state on its own. */
export function isLive(state: DeploymentState): boolean {
	return state === 'queued' || state === 'building';
}

/**
 * Which environment a build belongs to.
 *
 * `target` is `production` for a production build and NULL for a preview one —
 * there is no `target: 'preview'` to match on, which is why the list endpoint
 * cannot filter previews server-side and this function has to decide.
 */
export function toEnvironment(deployment: VercelDeployment): DeploymentEnvironment {
	if (deployment.customEnvironment) return 'custom';
	return deployment.target === 'production' ? 'production' : 'preview';
}

/** Git metadata is keyed by provider, so the value is found by suffix. */
function gitMeta(meta: Record<string, string> | undefined, suffix: string): string | null {
	if (!meta) return null;
	const key = Object.keys(meta).find((name) => name.toLowerCase().endsWith(suffix.toLowerCase()));
	return key ? meta[key] || null : null;
}

function toIso(value: number | undefined | null): string | null {
	return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

/**
 * One list row.
 *
 * `currentProductionId` comes from the project rather than the deployment,
 * because "is this what is live" is not a property of a build: a production
 * build that was superseded, or rolled back away from, is still `READY` and
 * still `production` and yet serves nobody. `readySubstate: PROMOTED` says it
 * saw traffic once, not that it has it now.
 */
export function toDeployment(raw: VercelDeployment, currentProductionId: string | null): Deployment {
	const id = raw.uid ?? raw.id ?? '';
	const nativeState = raw.readyState ?? raw.state;
	const state = toState(nativeState);

	return {
		id,
		name: raw.name,
		url: raw.url || null,
		inspectorUrl: raw.inspectorUrl ?? null,
		state,
		stateDetail: nativeState ?? 'UNKNOWN',
		environment: toEnvironment(raw),
		isCurrent: currentProductionId !== null && id === currentProductionId,
		// Three-way, not two. `undefined` means the listing did not say, and
		// treating that as `false` hid the rollback action on every deployment
		// whose response omitted the field.
		isRollbackCandidate: raw.isRollbackCandidate ?? null,
		branch: gitMeta(raw.meta, 'CommitRef'),
		commitSha: gitMeta(raw.meta, 'CommitSha'),
		commitMessage: gitMeta(raw.meta, 'CommitMessage'),
		creator: raw.creator?.username ?? raw.creator?.githubLogin ?? raw.creator?.email ?? null,
		createdAt: toIso(raw.createdAt ?? raw.created) ?? new Date(0).toISOString(),
		buildingAt: toIso(raw.buildingAt),
		readyAt: toIso(raw.ready),
		errorCode: raw.errorCode ?? null,
		errorMessage: raw.errorMessage ?? null,
		source: raw.source ?? null
	};
}

/** Build duration, or null when the build never finished. */
export function durationOf(raw: VercelDeployment): number | null {
	if (typeof raw.buildingAt !== 'number' || typeof raw.ready !== 'number') return null;
	const elapsed = raw.ready - raw.buildingAt;
	return elapsed >= 0 ? elapsed : null;
}
