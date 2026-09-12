/**
 * Deploy-provider adapter contract.
 *
 * This is the interface `Task 3` exists to build. Vercel is the first provider
 * behind it; Netlify, Railway, Fly.io, Render, Coolify/Dokploy and Cloudflare
 * Pages are meant to land as another directory in `providers/` and one line in
 * the registry. If any of them needs a change to the PANEL, this interface is
 * what was wrong.
 *
 * Note what this is NOT: a projector. A projection derives a row on a surface
 * that already has its own table — `mcp_servers` for agent tools,
 * `db_client_connections` for a database. Deployments are never copied locally
 * (see migration 075), so there is no derived row to keep in step. A deploy
 * provider registers CODE here, and the account row itself is what makes it
 * appear in the panel. That is the same conclusion the Issues surface reached.
 *
 * Every optional method is paired with a flag in `capabilities`. A caller must
 * read the flag rather than probe for the method, because the panel renders its
 * controls before any call is made.
 */

import type {
	BuildLogBundle,
	Deployment,
	DeploymentDetail,
	DeploymentDraft,
	DeploymentPage,
	DeployBindingConfig,
	DeployInfo,
	DeployProjectStatus,
	DeployProviderCapabilities,
	DeployTarget,
	NewProjectDraft
} from '$shared/types/deployments';
import type { IntegrationAccountRow } from '$backend/database/queries';

/**
 * What an adapter can say about deployability.
 *
 * The client-facing `DeployInfo` also carries facts read from the LOCAL working
 * tree — the suggested repository, the checked-out branch — which an adapter
 * has no business knowing about, and the readiness verdict, which the route
 * composes. This is deliberately the shared shape minus those rather than a
 * second declaration that could drift.
 */
export type AdapterDeployInfo = Omit<
	DeployInfo,
	'suggestedRepo' | 'connectState' | 'connectHint' | 'connectUrl' | 'currentBranch'
>;

/**
 * Whether a specific repository could be attached, and what to do if not.
 *
 * `unknown` is a first-class answer rather than an optimistic `true`: a check
 * we could not read must not present itself as a green light, because the cost
 * of being wrong is the exact failure the check exists to prevent.
 */
export interface RepositoryAccess {
	state: 'ready' | 'blocked' | 'unknown';
	reason: string | null;
	/** Provider settings page that fixes it, when there is one. */
	actionUrl: string | null;
}

/** The remote project one account is pointed at, for one Clopen project. */
export interface ResolvedDeployBinding {
	locator: string;
	displayName: string;
	detected: boolean;
	teamId: string | null;
	config: DeployBindingConfig;
}

/**
 * Everything an adapter call needs.
 *
 * `credentials` is already decoded. It is assembled by the service from the
 * account row and never leaves the backend — no route serialises it, and the
 * adapter must not put it anywhere a `Deployment` can carry it back out.
 */
export interface DeployContext {
	projectId: string;
	account: IntegrationAccountRow;
	credentials: Record<string, string>;
	binding: ResolvedDeployBinding;
}

/** Same, before a binding exists — the only calls that can run unbound. */
export interface UnboundDeployContext {
	projectId: string;
	account: IntegrationAccountRow;
	credentials: Record<string, string>;
}

/** How the list is narrowed. Everything optional is "not set", never a default. */
export interface DeploymentQuery {
	environment: 'production' | 'preview' | 'custom' | 'all';
	branch?: string;
	/** Opaque cursor from the previous page. */
	cursor?: string;
	limit?: number;
}

/** A live log follow, as the stream manager drives it. */
export interface LogStreamHandle {
	/** Stop the follow and release whatever socket is behind it. */
	stop: () => void;
}

export interface LogStreamCallbacks {
	onChunk: (text: string) => void;
	/**
	 * The build moved to a new stage.
	 *
	 * Separate from the log text because it answers a different question. A log
	 * says what a command printed; this says what the provider is DOING — and
	 * during the long quiet stretches of a build (uploading, provisioning,
	 * assigning domains) the log prints nothing at all, which is exactly when a
	 * watcher most needs to know it has not stalled.
	 */
	onPhase?: (phase: string) => void;
	/** Called exactly once, with a message when the follow ended badly. */
	onEnd: (error: string | null) => void;
}

export interface DeployProviderAdapter {
	/** Must match the `IntegrationProvider.id` this adapter serves. */
	provider: string;
	capabilities: DeployProviderCapabilities;

	/**
	 * Read the provider's own CLI config out of the project, if it left one.
	 *
	 * This is what makes binding automatic for a project someone has already
	 * linked: `.vercel/project.json` names the project and the team, and asking
	 * the user to pick it from a dropdown would be asking them to retype a file
	 * that is sitting in their repository.
	 *
	 * Returns null when there is no such file, which is the ordinary case and
	 * not an error.
	 */
	detectFromProject?(projectRoot: string): Promise<{ locator: string; teamId: string | null } | null>;

	/**
	 * Remote projects this credential can reach.
	 *
	 * Used for the binding picker, and for the second detection pass: each
	 * target carries the git repository it is connected to, so a project whose
	 * `origin` matches one of them can be bound without the user choosing.
	 */
	listTargets(context: UnboundDeployContext): Promise<DeployTarget[]>;

	/** Resolve one target, so a stored locator can be given a display name. */
	describeTarget(context: UnboundDeployContext, locator: string, teamId: string | null): Promise<DeployTarget | null>;

	/**
	 * Is this credential good, and does it reach the bound project?
	 *
	 * Runs at connect time and from the hub's health button. A token that is
	 * valid but cannot see the bound project must fail HERE, naming which of the
	 * two it is — not later as an empty list that looks like "no deployments".
	 */
	probe(context: UnboundDeployContext, binding: ResolvedDeployBinding | null): Promise<{
		status: 'ok' | 'needs_auth' | 'needs_config' | 'error';
		detail: string | null;
	}>;

	list(context: DeployContext, query: DeploymentQuery): Promise<DeploymentPage>;
	get(context: DeployContext, id: string): Promise<DeploymentDetail>;

	/** Build logs as one budgeted bundle — what the chat prompt is built from. */
	fetchLogs?(context: DeployContext, id: string): Promise<BuildLogBundle>;

	/**
	 * Follow a running build's logs.
	 *
	 * Only called when `capabilities.streamLogs` is set. The handle must stop
	 * the underlying request: the stream manager closes it when the last viewer
	 * leaves, and a follow nobody aborts is an open socket for the life of the
	 * process.
	 */
	streamLogs?(context: DeployContext, id: string, callbacks: LogStreamCallbacks): Promise<LogStreamHandle>;

	/**
	 * Outward-facing actions. Each is gated by its capability flag, and the
	 * caller has already confirmed with the user before any of these run.
	 *
	 * `rollback` and `promote` return `pending` rather than `done` when the
	 * provider moves traffic asynchronously, which Vercel does — reporting them
	 * as complete would tell someone their incident was over before it was.
	 */
	redeploy?(context: DeployContext, id: string): Promise<{ deploymentId: string | null; message: string }>;
	cancel?(context: DeployContext, id: string): Promise<{ message: string }>;
	rollback?(context: DeployContext, id: string): Promise<{ status: 'done' | 'pending'; message: string }>;
	promote?(context: DeployContext, id: string): Promise<{ status: 'done' | 'pending'; message: string }>;

	/**
	 * What starting a build from here would need, and whether it is possible.
	 *
	 * Answered before the deploy dialog opens so the dialog can prefill the
	 * branch and refuse honestly, rather than offering a button whose failure is
	 * only discovered after someone presses it.
	 */
	deployInfo?(context: DeployContext): Promise<AdapterDeployInfo>;

	/**
	 * Start a NEW build from a branch.
	 *
	 * Distinct from `redeploy`, which copies an existing deployment: this is the
	 * only path available to a project that has never been deployed. Outward
	 * facing — the caller has confirmed first.
	 */
	createDeployment?(
		context: DeployContext,
		draft: DeploymentDraft
	): Promise<{ deploymentId: string | null; message: string }>;

	/**
	 * Create a remote project.
	 *
	 * Unbound on purpose: this is what a Clopen project with nothing to point at
	 * does, so there is no binding yet. The caller binds to the result.
	 */
	createProject?(context: UnboundDeployContext, draft: NewProjectDraft): Promise<DeployTarget>;

	/**
	 * Can this repository be attached, and if not, what would fix it.
	 *
	 * Asked before `connectRepository` is offered, and also before the new-project
	 * form offers to connect a repository to something that does not exist yet —
	 * which is why it takes an UNBOUND context. It reads a property of the
	 * account, not of any particular project.
	 *
	 * Attaching a repository needs the ACCOUNT to have git access of its own,
	 * established on the provider's site and impossible with an API token — the
	 * one prerequisite Clopen can detect but not satisfy. Naming it beats a
	 * button that fails.
	 */
	repositoryAccess?(context: UnboundDeployContext, gitRepo: string): Promise<RepositoryAccess>;

	/**
	 * Attach a git repository to the bound remote project.
	 *
	 * The escape hatch from "this project is not connected to a git repository,
	 * so it cannot be deployed from here" — which is otherwise a dead end that
	 * sends the user to the provider's dashboard.
	 */
	connectRepository?(
		context: DeployContext,
		repo: { gitRepo: string; gitProvider: string }
	): Promise<void>;

	/**
	 * Delete a deployment outright.
	 *
	 * Outward-facing and irreversible — the build, its logs and its URLs all go.
	 * The caller confirms, and must not offer it for whatever is currently
	 * serving production.
	 */
	deleteDeployment?(context: DeployContext, id: string): Promise<{ message: string }>;

	/**
	 * State that belongs to the target, not to any one build.
	 *
	 * Also carries the outcome of a rollback or promotion still in flight, which
	 * is the only way to turn the `pending` those actions return into an answer.
	 */
	projectStatus?(context: DeployContext): Promise<DeployProjectStatus>;

	/** Who the stored credential belongs to. Shown beside the account label. */
	viewer?(context: UnboundDeployContext): Promise<string | null>;

	/**
	 * The deployment currently serving production traffic, if the provider can
	 * answer it directly rather than by inference from the list.
	 */
	currentProduction?(context: DeployContext): Promise<Deployment | null>;
}
