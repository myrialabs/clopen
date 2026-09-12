/**
 * The subset of Vercel's API shapes this adapter reads.
 *
 * Hand-written rather than generated: the published schema for one deployment
 * carries roughly sixty fields, of which this surface uses twelve, and a
 * generated type would make every one of the other forty-eight look like
 * something a reader should account for.
 *
 * Everything optional is optional because Vercel genuinely omits it — `url` is
 * null while a deployment uploads, `target` is null for a preview build, and
 * `meta` is absent entirely for a CLI deployment with no git behind it.
 */

export interface VercelDeployment {
	uid?: string;
	id?: string;
	name: string;
	url: string | null;
	created?: number;
	createdAt?: number;
	buildingAt?: number;
	ready?: number;
	state?: string;
	readyState?: string;
	readySubstate?: string;
	/** `production` for a production build; null for a preview one. */
	target?: string | null;
	source?: string;
	inspectorUrl?: string | null;
	errorCode?: string;
	errorMessage?: string | null;
	isRollbackCandidate?: boolean | null;
	customEnvironment?: { id: string; slug?: string } | null;
	creator?: { uid: string; username?: string; email?: string; githubLogin?: string };
	/** Git metadata, keyed by provider — `githubCommitSha`, `gitlabCommitSha`, … */
	meta?: Record<string, string>;
	alias?: string[];
	aliasAssigned?: number | boolean | null;
	projectSettings?: { framework?: string | null };
}

export interface VercelDeploymentList {
	deployments: VercelDeployment[];
	pagination: { count: number; next: number | null; prev: number | null };
}

export interface VercelProject {
	id: string;
	name: string;
	/** True when the project ignores pushes entirely. */
	paused?: boolean;
	framework?: string | null;
	link?: { type?: string; org?: string; repo?: string; repoId?: number | string; productionBranch?: string | null } | null;
	/** Current deployment per target. `targets.production.id` is what is live. */
	targets?: Record<string, { id?: string } | null> | null;
	lastAliasRequest?: {
		toDeploymentId?: string;
		jobStatus?: 'failed' | 'in-progress' | 'pending' | 'skipped' | 'succeeded';
		type?: 'promote' | 'rollback';
	} | null;
}

export interface VercelProjectList {
	projects: VercelProject[];
}

export interface VercelTeam {
	id: string;
	slug?: string;
	name?: string | null;
}

export interface VercelTeamList {
	teams: VercelTeam[];
}

export interface VercelUser {
	user: { id: string; username?: string; email?: string; name?: string | null };
}

/** One line of the build-log stream. */
export interface VercelEvent {
	type?: string;
	created?: number;
	text?: string;
	level?: string;
	payload?: { text?: string; date?: number; id?: string };
}

/**
 * A git account or organisation the Vercel account can reach.
 *
 * An empty list means the Vercel ACCOUNT has no git login connection at all,
 * which is the prerequisite behind "You need to add a Login Connection to your
 * GitHub account first".
 */
export interface VercelGitNamespace {
	id: string | number;
	slug: string;
	name?: string;
	provider: string;
	ownerType: string;
	isAccessRestricted?: boolean;
}
