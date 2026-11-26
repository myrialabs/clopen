/**
 * The hosting adapter contract.
 *
 * One per service. Where `backend/work/types.ts` is about the WORK on a
 * repository (issues, pull requests, CI runs), this is about the repository
 * itself and the account that owns it: who am I, where can I create a
 * repository, which repositories can I pick, make one, fork one, what does CI
 * say about these commits, and where on the web is all of it.
 *
 * `credentials` is the account's decoded credential object, already refreshed
 * (see `credentials.ts`). An adapter reads `token`, `baseUrl` and whatever its
 * service needs, and never returns any of it.
 */

import type {
	CommitCiStatus,
	GitHostKind,
	HostedRepo,
	HostLinks,
	HostOwner,
	HostRepoPage,
	HostTemplateOption,
	HostViewer
} from '$shared/types/git-hosting';

export type HostCredentials = Record<string, string>;

export interface CreateRepoInput {
	owner: HostOwner;
	name: string;
	description: string;
	isPrivate: boolean;
}

export interface RepoQuery {
	search?: string;
	/** Only repositories under this owner. */
	owner?: string;
	page: number;
}

export interface GitHostAdapter {
	kind: GitHostKind;
	/** The service's display name, for messages. */
	serviceName: string;

	/** `https://github.com`, or the self-hosted root. */
	webBase(credentials: HostCredentials): string;
	/** Hostname git remotes on this account point at. */
	host(credentials: HostCredentials): string;
	/** `owner/name` for a remote on this account's host, or null when it is not. */
	locatorFromRemote(url: string, credentials: HostCredentials): string | null;

	/**
	 * The username git should send alongside the token over HTTPS. Services
	 * disagree — GitHub ignores it, GitLab wants `oauth2`, Bitbucket a fixed
	 * marker — and a wrong one is a 401 that looks like a bad token.
	 */
	gitUsername(credentials: HostCredentials): string;

	viewer(credentials: HostCredentials): Promise<HostViewer>;
	/** The signed-in user first, then every organisation/group/workspace they can create in. */
	listOwners(credentials: HostCredentials): Promise<HostOwner[]>;
	listRepos(credentials: HostCredentials, query: RepoQuery): Promise<HostRepoPage>;
	getRepo(credentials: HostCredentials, locator: string): Promise<HostedRepo>;
	createRepo(credentials: HostCredentials, input: CreateRepoInput): Promise<HostedRepo>;
	/** Fork into the signed-in user's namespace. Resolves once the fork is usable. */
	fork(credentials: HostCredentials, locator: string): Promise<HostedRepo>;

	/** CI roll-up per commit, in the order asked. Commits the service never saw report `none`. */
	commitStatuses(credentials: HostCredentials, locator: string, shas: string[]): Promise<CommitCiStatus[]>;

	links(credentials: HostCredentials, locator: string): HostLinks;

	/** Optional: services that can generate a .gitignore and a license text. */
	templates?: {
		gitignoreList(credentials: HostCredentials): Promise<HostTemplateOption[]>;
		gitignore(credentials: HostCredentials, key: string): Promise<string>;
		licenseList(credentials: HostCredentials): Promise<HostTemplateOption[]>;
		license(credentials: HostCredentials, key: string, holder: { year: string; fullname: string }): Promise<string>;
	};
}
