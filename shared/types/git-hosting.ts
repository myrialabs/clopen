/**
 * Git hosting — the vocabulary the Git panel uses to talk about the service a
 * repository lives on: GitHub, GitLab, Gitea/Forgejo or Bitbucket.
 *
 * Distinct from `work.ts`. Issues and pull requests are WORK, and a provider
 * may host repositories without Clopen being able to show its issues (Gitea
 * and Bitbucket today). Publishing a repository, choosing one to add as a
 * remote, forking, commit statuses and web links are HOSTING, and every
 * connected source-control account offers them.
 *
 * Nothing here carries a credential.
 */

/** The hosting services Clopen has an adapter for. Also their integration provider ids. */
export const GIT_HOST_KINDS = ['github', 'gitlab', 'gitea', 'bitbucket'] as const;

export type GitHostKind = typeof GIT_HOST_KINDS[number];

/** A user or organisation a repository can be created under. */
export interface HostOwner {
	login: string;
	kind: 'user' | 'org';
	/** Display name, when the service has one distinct from the login. */
	name: string | null;
	avatarUrl: string | null;
}

/** One repository on the service, as the pickers show it. */
export interface HostedRepo {
	/** `owner/name` — or `group/subgroup/name` on GitLab. The adapter's locator. */
	fullName: string;
	owner: string;
	name: string;
	description: string | null;
	isPrivate: boolean;
	isFork: boolean;
	/** `owner/name` of the repository this was forked from, when the service says. */
	parentFullName: string | null;
	defaultBranch: string | null;
	cloneUrlHttps: string;
	cloneUrlSsh: string | null;
	webUrl: string;
	updatedAt: string | null;
	/** Whether the signed-in account may push. Null when the service did not say. */
	canPush: boolean | null;
}

export interface HostRepoPage {
	repos: HostedRepo[];
	hasMore: boolean;
}

/** Who a connected account is, and what its token was granted. */
export interface HostViewer {
	login: string;
	name: string | null;
	avatarUrl: string | null;
	/** Scopes the token carries, when the service reports them. Null = not reported. */
	scopes: string[] | null;
	/** Scopes Clopen needs that this token lacks. Empty when nothing is missing. */
	missingScopes: string[];
}

/** URL patterns for one repository. `{placeholders}` are filled in by the client. */
export interface HostLinks {
	repo: string;
	/** `{sha}` */
	commit: string;
	/** `{branch}` */
	branch: string;
	/** `{ref}` `{path}` and optionally `{line}` — see `fileLine`. */
	file: string;
	/** Appended to `file` when a line is known. `{line}` */
	fileLine: string;
	/** `{base}` `{head}` */
	compare: string;
	/** Start a pull/merge request from `{head}` into `{base}` on the web. */
	newPullRequest: string;
}

/** The roll-up of every CI signal on one commit. */
export type CommitCiState = 'success' | 'failure' | 'pending' | 'none';

export interface CommitCiStatus {
	sha: string;
	state: CommitCiState;
	/** Where the service shows the runs for this commit, when it has one page for them. */
	url: string | null;
	/** "3 of 4 checks passed" — the tooltip. */
	summary: string;
}

/** A connected account that can serve a host, as the Git panel needs it. */
export interface HostAccount {
	accountId: string;
	provider: GitHostKind;
	providerName: string;
	label: string;
	host: string;
	/** Login of the account, when known. */
	login: string | null;
	/** True when the account's Issues & PRs capability is on and an adapter exists. */
	offersWork: boolean;
	status: 'ok' | 'needs_auth' | 'needs_config' | 'error' | 'unknown';
	statusDetail: string | null;
}

/** One git remote, matched against the connected accounts. */
export interface HostRemote {
	name: string;
	url: string;
	host: string | null;
	/** The service this host belongs to, when one is recognised. */
	provider: GitHostKind | null;
	/** The repository locator on that service — `owner/name`. */
	locator: string | null;
	/** The account that answers for this remote, when one is connected. */
	accountId: string | null;
	links: HostLinks | null;
	/** The remote's default branch as git knows it locally — what a compare starts from. */
	defaultBranch: string | null;
}

/**
 * Everything the Git panel needs to know about hosting for one project,
 * resolved in a single call.
 */
export interface HostingContext {
	remotes: HostRemote[];
	accounts: HostAccount[];
	/**
	 * The remote the panel treats as "the repository" — the one issues, pull
	 * requests and CI are read from. Origin first, then upstream, then whatever
	 * matched an account.
	 */
	primaryRemote: string | null;
	/**
	 * Provider a remote points at that no connected account serves. The panel
	 * offers to connect exactly this one rather than a generic list.
	 */
	unservedProvider: { provider: GitHostKind; host: string } | null;
}

/** A .gitignore template or license the service can generate. */
export interface HostTemplateOption {
	key: string;
	name: string;
}

export interface HostTemplates {
	gitignore: HostTemplateOption[];
	licenses: HostTemplateOption[];
	/** The .gitignore template that matches this project's files, when one does. */
	suggestedGitignore: string | null;
	/** Which of the three files already exist, so the form does not offer to clobber them. */
	existing: { gitignore: boolean; license: boolean; readme: boolean };
	/** True when the repository has no commit yet — publishing must create one. */
	needsFirstCommit: boolean;
	/** How many files the first commit would contain. */
	pendingFiles: number;
}

export interface PublishRepoInput {
	accountId: string;
	owner: string;
	name: string;
	description: string;
	isPrivate: boolean;
	remoteName: string;
	gitignore: string | null;
	license: string | null;
	readme: boolean;
	/** Stage everything and commit it, when the repository has no commit yet. */
	createFirstCommit: boolean;
	protocol: 'https' | 'ssh';
}

export interface PublishRepoResult {
	repo: HostedRepo;
	remoteName: string;
	pushed: boolean;
	/** Why the push did not happen, when it did not. */
	pushMessage: string | null;
}

export interface ForkResult {
	fork: HostedRepo;
	/** Remote name the fork was added under. */
	forkRemote: string;
	/** Where the original now lives, when the remotes were renamed. */
	upstreamRemote: string | null;
	pushed: boolean;
	pushMessage: string | null;
}

/** Which sign-in method found an existing credential on this machine. */
export type DetectedCredentialSource = 'gh' | 'glab' | 'tea' | 'keychain';

export interface DetectedCredential {
	source: DetectedCredentialSource;
	host: string;
	/** The login the CLI is signed in as, when it says. */
	login: string | null;
	/** True when a token could actually be read — a CLI can list a host it is logged out of. */
	hasToken: boolean;
	/** True when the CLI can be re-asked on every use, so rotation follows it. */
	canLink: boolean;
}

/** What a self-hosted server URL turned out to be. */
export interface ServerProbeResult {
	provider: GitHostKind | null;
	/** `forgejo` is reported distinctly so the copy can name it, but it uses the Gitea adapter. */
	flavour: 'github-enterprise' | 'gitlab' | 'gitea' | 'forgejo' | null;
	version: string | null;
	baseUrl: string;
}

export interface DeviceFlowStart {
	flowId: string;
	userCode: string;
	verificationUri: string;
	/** A URI that carries the code itself, so the user does not have to type it. */
	verificationUriComplete: string | null;
	expiresAt: string;
	intervalSeconds: number;
}

export type AuthFlowStatus = 'pending' | 'success' | 'expired' | 'denied' | 'error';

export interface AuthFlowPoll {
	status: AuthFlowStatus;
	accountId: string | null;
	error: string | null;
}

export interface BrowserFlowStart {
	flowId: string;
	authorizeUrl: string;
	redirectUri: string;
}
