/**
 * Deployments surface — shared vocabulary.
 *
 * The panel talks about DEPLOYMENTS, not about Vercel. Every provider that can
 * offer the `deployments` capability is normalised into these shapes by an
 * adapter, and the panel never learns which one answered. That is the whole
 * test for this surface: if Netlify or Railway needs a second panel, these
 * types are wrong and fixing them is the work — not adding a panel.
 *
 * Nothing here carries a credential. The adapter resolves the account's secret
 * on the server and it never crosses this line.
 */

/**
 * The one state fact the UI is allowed to reason about.
 *
 * Providers name their states whatever they like — Vercel says `INITIALIZING`,
 * `BUILDING`, `READY`; Netlify says `enqueued`, `building`, `ready`. The native
 * name is shown verbatim in the detail pane, but colour, grouping and whether
 * polling continues are decided from this normalised set alone. Anything in the
 * frontend that reads a provider's own state string is a bug in the interface.
 */
export type DeploymentState = 'queued' | 'building' | 'ready' | 'error' | 'canceled';

/**
 * Which environment a deployment belongs to.
 *
 * `custom` exists because Vercel has custom environments and Netlify has branch
 * deploys, and collapsing either into `preview` would make the filter lie.
 */
export type DeploymentEnvironment = 'production' | 'preview' | 'custom';

/** What the list can be narrowed to. `all` is the absence of a filter. */
export type DeploymentEnvironmentFilter = DeploymentEnvironment | 'all';

export interface Deployment {
	/** Opaque provider id. Used for API calls, never shown. */
	id: string;
	/** The project/app name the provider reports, for multi-project accounts. */
	name: string;
	/**
	 * Where this build can be reached, without a scheme.
	 *
	 * Null while a deployment is still uploading — Vercel documents `url` as
	 * null for an incomplete deployment, and rendering `https://null` is worse
	 * than rendering nothing.
	 */
	url: string | null;
	/** The provider's own dashboard page for this build. */
	inspectorUrl: string | null;
	state: DeploymentState;
	/** The provider's own state name, shown as-is in the detail pane. */
	stateDetail: string;
	environment: DeploymentEnvironment;
	/**
	 * True when this deployment is the one currently serving production traffic.
	 *
	 * Distinct from `state === 'ready' && environment === 'production'`: a
	 * production build that was superseded, or rolled back away from, is ready
	 * and production and yet serves nobody.
	 */
	isCurrent: boolean;
	/**
	 * The provider says this build can be rolled back to.
	 *
	 * NULLABLE on purpose. `false` and "the provider did not say" are different
	 * answers, and collapsing them into `false` HID the rollback action on every
	 * deployment whose listing omitted the field — the action existed and was
	 * simply unreachable. Null means fall back to what is knowable: a ready
	 * production build that is not the live one.
	 */
	isRollbackCandidate: boolean | null;
	branch: string | null;
	commitSha: string | null;
	commitMessage: string | null;
	creator: string | null;
	createdAt: string;
	buildingAt: string | null;
	readyAt: string | null;
	/** Machine-readable failure cause, when the provider gives one. */
	errorCode: string | null;
	errorMessage: string | null;
	/** How the build was triggered — `git`, `cli`, `redeploy`. */
	source: string | null;
}

export interface DeploymentDetail extends Deployment {
	/** Every hostname pointing at this build, production aliases included. */
	aliases: string[];
	/** Framework the provider detected, when it reports one. */
	framework: string | null;
	/** Build duration in milliseconds, when both ends are known. */
	durationMs: number | null;
}

export interface DeploymentPage {
	items: Deployment[];
	hasMore: boolean;
	/**
	 * Opaque cursor for the next page.
	 *
	 * A cursor rather than a page number because Vercel paginates by timestamp
	 * and a page number would silently skip or repeat rows whenever a build
	 * lands mid-scroll. Providers that page by number encode it in here.
	 */
	nextCursor: string | null;
	rateLimit: DeployRateLimit | null;
}

/** Budget left on the provider's API, shown in the footer. */
export interface DeployRateLimit {
	remaining: number;
	limit: number;
	resetAt: string | null;
}

/**
 * What a provider can actually do.
 *
 * Every optional action is a flag rather than a try-and-see, because the
 * alternative is a button that exists on every provider and 404s on most of
 * them. Coolify has no promote, Fly has no preview deployment, and both must
 * render a panel with those controls absent rather than disabled.
 */
export interface DeployProviderCapabilities {
	/** Build logs can be read at all. */
	logs: boolean;
	/**
	 * A build can be STARTED from here, not merely repeated.
	 *
	 * Separate from `redeploy`, which needs an existing deployment to copy. A
	 * project that has never been deployed has nothing to redeploy, and without
	 * this the panel is a dead end for exactly the project someone most wants to
	 * get onto a host.
	 */
	createDeployment: boolean;
	/** A new remote project can be created from here. */
	createProject: boolean;
	/** A git repository can be attached to an existing remote project. */
	connectRepository: boolean;
	/** A deployment can be deleted outright. */
	deleteDeployment: boolean;
	/** Logs arrive as a live stream rather than one fetched bundle. */
	streamLogs: boolean;
	redeploy: boolean;
	cancel: boolean;
	rollback: boolean;
	promote: boolean;
	/** The provider distinguishes production from preview builds. */
	environments: boolean;
	/** The list can be narrowed to one git branch. */
	branchFilter: boolean;
}

/** A remote project this account could be pointed at, for the binding picker. */
export interface DeployTarget {
	/** Opaque provider id — `prj_…` on Vercel. Stored as the binding's locator. */
	id: string;
	name: string;
	/** Team or organisation scope, when the provider has one. */
	teamId: string | null;
	teamName: string | null;
	framework: string | null;
	/** `owner/repo` of the connected git repository, used to detect a binding. */
	gitRepo: string | null;
}

/**
 * What starting a build needs to know, resolved when the deploy dialog opens.
 *
 * Fetched on demand rather than carried on every source: it costs a request,
 * and the overwhelming majority of panel opens never start a build.
 */
export interface DeployInfo {
	/** `owner/repo` the remote project builds from, or null when it has none. */
	gitRepo: string | null;
	/** The branch that produces a production build. */
	productionBranch: string | null;
	/**
	 * Whether a build can be started at all, and why not when it cannot.
	 *
	 * A remote project with no git connection can only be deployed by uploading
	 * files, which is a CLI job — saying so is better than a button that fails.
	 */
	canDeploy: boolean;
	reason: string | null;
	/**
	 * `owner/repo` read off the LOCAL project's git remote.
	 *
	 * Carried so the dialog can offer to connect it when the remote project has
	 * no repository — the answer is already sitting in the working tree, and
	 * making someone type it is the setup step that sends them to the dashboard.
	 */
	suggestedRepo: string | null;
	/**
	 * Whether attaching `suggestedRepo` would actually work.
	 *
	 * Three states, not a boolean, because a boolean forces the uncertain case
	 * to pretend. The first version answered `true` when the check itself could
	 * not be read — which put the button back on screen and let the failure
	 * arrive as a toast, defeating the point of checking at all.
	 *
	 *   ready       — verified; the button can be pressed
	 *   blocked     — verified as impossible; the button must NOT be offered
	 *   unknown     — the check could not be read; we cannot prove either way
	 *   unavailable — nothing to connect, or the provider cannot connect
	 */
	connectState: 'ready' | 'blocked' | 'unknown' | 'unavailable';
	/** What to do about it, when it is not ready. */
	connectHint: string | null;
	/** Where to go to fix it — the provider's own settings page. */
	connectUrl: string | null;
	/**
	 * The branch checked out in the local project right now.
	 *
	 * Offered alongside the production branch, because the branch someone is
	 * working on is at least as likely to be the one they want to deploy — and
	 * retyping it from memory is how a preview gets built from the wrong ref.
	 */
	currentBranch: string | null;
}

/** What a new build is made from. */
export interface DeploymentDraft {
	/** Branch or tag to build. */
	ref: string;
	/** Production rather than preview. Always the more dangerous choice. */
	production: boolean;
}

/** Defaults offered when creating a remote project, read from the local one. */
export interface NewProjectDefaults {
	suggestedName: string;
	/** `owner/repo` from this project's git remote, when it has one. */
	gitRepo: string | null;
	/** Provider the remote belongs to, as the target host names it. */
	gitProvider: string | null;
}

export interface NewProjectDraft {
	name: string;
	gitRepo: string | null;
	gitProvider: string | null;
	framework: string | null;
}

/** Per-binding behaviour. Not a secret, stored as plain JSON. */
export interface DeployBindingConfig {
	/** Which environment the list opens on. */
	environment: DeploymentEnvironmentFilter;
	/**
	 * Keep polling the list while a build is running.
	 *
	 * On by default and switchable off, because this is a metered remote API and
	 * a user on a rate-limited plan watching a long build may prefer to refresh
	 * by hand.
	 */
	autoRefresh: boolean;
}

export const DEFAULT_DEPLOY_BINDING_CONFIG: DeployBindingConfig = {
	environment: 'all',
	autoRefresh: true
};

/** The remote project one account is pointed at, as the panel sees it. */
export interface DeployBinding {
	locator: string;
	/**
	 * Human name of the remote project.
	 *
	 * Cached on the binding rather than derived from the locator, because unlike
	 * an `owner/repo` a Vercel locator is `prj_8Qc…` and means nothing to anyone.
	 * A binding bar rendering the raw id would be unreadable.
	 */
	displayName: string;
	detected: boolean;
	teamId: string | null;
	config: DeployBindingConfig;
}

/** One connected account able to serve deployments here. */
export interface DeploySource {
	accountId: string;
	provider: string;
	providerName: string;
	label: string;
	/**
	 * Who the stored credential belongs to.
	 *
	 * Resolved once per source rather than per view. Shown in the footer beside
	 * the provider mark, the way the Issues surface shows it — a panel acting on
	 * someone's account should say whose.
	 */
	viewer: string | null;
	capabilities: DeployProviderCapabilities;
	binding: DeployBinding | null;
	/** Remote projects detected for this project, offered before the full list. */
	suggestedTargets: DeployTarget[];
	status: 'ok' | 'needs_auth' | 'needs_config' | 'error' | 'unknown';
	statusDetail: string | null;
}

/** Build log text, already budgeted to something a prompt can carry. */
export interface BuildLogBundle {
	deploymentId: string;
	text: string;
	truncated: boolean;
}

/**
 * An action that triggers a build or changes what is live.
 *
 * Named as a closed set so the confirm dialog, the capability flags and the
 * route schema all agree on what exists. Every one of these is outward-facing
 * and must be confirmed explicitly before it runs.
 */
export type DeployAction = 'redeploy' | 'cancel' | 'rollback' | 'promote' | 'delete';

/**
 * The outcome of an outward-facing action.
 *
 * `pending` is not a courtesy — rollback and promote are asynchronous on
 * Vercel: the call returns once the request is accepted, while production
 * traffic moves some seconds later. Reporting those as done would tell the user
 * their incident is over before it is.
 */
export interface DeployActionResult {
	action: DeployAction;
	status: 'done' | 'pending';
	/** A new deployment id, when the action created one. */
	deploymentId: string | null;
	message: string;
}

/**
 * Project-level state, which belongs to the target rather than to any build.
 *
 * Read separately from the deployment list because it answers a different
 * question: not "how did this build go" but "will pushing even produce one".
 */
export interface DeployProjectStatus {
	/**
	 * The target is paused at the provider.
	 *
	 * READ-ONLY here on purpose. Clopen does not offer to pause: on Vercel it
	 * "blocks the active Production Deployment" — it takes the site down, not
	 * merely stops future builds — and that is a high-consequence, rarely-wanted
	 * action to reach from an editor. But if someone paused it in the provider's
	 * dashboard, this is the only thing that explains a list which has stopped
	 * growing and a site that has stopped answering.
	 */
	paused: boolean;
	/**
	 * A rollback or promotion the provider accepted and is still carrying out.
	 *
	 * This is what turns the `pending` an action returns into an outcome. Until
	 * it settles, production traffic has not moved yet.
	 */
	aliasRequest: {
		type: 'rollback' | 'promote';
		status: 'pending' | 'in-progress' | 'succeeded' | 'failed' | 'skipped';
		toDeploymentId: string | null;
	} | null;
}

/** One chunk of a live build log, pushed to whoever asked to follow it. */
export interface BuildLogChunk {
	streamId: string;
	deploymentId: string;
	data: string;
	/**
	 * Stage the provider reports — `Building`, `Uploading`, `Deploying`.
	 *
	 * Carried separately from the text because a build spends long stretches
	 * printing nothing at all, and during those a reader cannot tell work from
	 * a stall. Pushed the moment it changes rather than on the flush interval.
	 */
	phase?: string;
	done?: boolean;
	error?: string | null;
}
