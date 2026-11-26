/**
 * What the Git panel asks the hosting layer, provider-agnostic.
 *
 * Every function resolves the account first, hands the adapter a credential
 * that is current (`credentialsForUse`), and returns shapes with no secret in
 * them. Writes to the local repository (templates, the first commit, remotes,
 * the push) happen here too, so publishing and forking are each ONE call the
 * route can run under the repository lock.
 */

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { integrationAccountQueries } from '$backend/database/queries';
import { getProvider } from '$backend/integrations';
import { gitService } from '$backend/git/git-service';
import { execGit } from '$backend/git/git-executor';
import { resolveGitEnv } from '$backend/git/identity';
import { getWorkAdapter } from '$backend/work/registry';
import type {
	CommitCiStatus,
	ForkResult,
	HostAccount,
	HostedRepo,
	HostingContext,
	HostOwner,
	HostRemote,
	HostRepoPage,
	HostTemplates,
	HostViewer,
	PublishRepoInput,
	PublishRepoResult
} from '$shared/types/git-hosting';
import { debug } from '$shared/utils/logger';
import { accountForRemote, hostAccountById, hostAccounts, rememberOwners, type HostAccountRef } from './accounts';
import { credentialsForUse } from './credentials';
import { cloudHostKind, getHostAdapter } from './registry';
import { parseRemoteUrl } from './urls';

function requireAccount(accountId: string, projectId: string | null): HostAccountRef {
	const ref = hostAccountById(accountId);
	if (!ref) throw new Error('That account is not connected or is switched off');
	if (projectId && ref.account.project_id && ref.account.project_id !== projectId) {
		throw new Error('That account belongs to another project');
	}
	return ref;
}

function toHostAccount(ref: HostAccountRef): HostAccount {
	const capabilities = integrationAccountQueries.capabilitiesOf(ref.account);
	return {
		accountId: ref.account.id,
		provider: ref.provider,
		providerName: getProvider(ref.provider)?.name ?? ref.adapter.serviceName,
		label: ref.account.label,
		host: ref.host,
		login: ref.credentials.login || null,
		offersWork: capabilities.includes('work') && getWorkAdapter(ref.provider) !== null,
		status: ref.account.status,
		statusDetail: ref.account.status_detail
	};
}

/** `owner/name` off a URL for a service no account serves — enough for web links. */
function bareLocator(path: string): string | null {
	const parts = path.split('/').filter(Boolean);
	return parts.length >= 2 ? parts.join('/') : null;
}

const REMOTE_RANK = (name: string) => (name === 'origin' ? 0 : name === 'upstream' ? 1 : 2);

/** Remote names git accepts and that will not be read as an option. */
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** What every service accepts as a repository name. */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

async function hasCommits(root: string): Promise<boolean> {
	const result = await execGit(['rev-parse', '--verify', '--quiet', 'HEAD'], root);
	return result.exitCode === 0;
}

/** The branch HEAD points at, including an unborn one in a repository with no commits. */
async function currentBranch(root: string): Promise<string | null> {
	const result = await execGit(['symbolic-ref', '--short', '-q', 'HEAD'], root);
	const name = result.stdout.trim();
	return result.exitCode === 0 && name ? name : null;
}

async function pushBranch(
	projectId: string,
	root: string,
	remoteName: string,
	url: string
): Promise<{ pushed: boolean; message: string | null }> {
	if (!(await hasCommits(root))) {
		return { pushed: false, message: 'Nothing to push yet — commit something, then push.' };
	}
	const branch = await currentBranch(root);
	if (!branch) return { pushed: false, message: 'HEAD is detached, so there is no branch to push.' };

	const result = await gitService.push(root, remoteName, branch, false, { useUpstream: false }, resolveGitEnv(projectId, url));
	return result.success ? { pushed: true, message: null } : { pushed: false, message: result.message };
}

// ---------------------------------------------------------------------------
// CI status cache. A finished commit's CI never changes, so it is kept; a
// running one is re-asked after a short while.
// ---------------------------------------------------------------------------

const ciCache = new Map<string, { status: CommitCiStatus; at: number }>();
const CI_PENDING_TTL_MS = 30_000;
const CI_NONE_TTL_MS = 120_000;
const CI_CACHE_MAX = 4000;

function cachedCi(key: string): CommitCiStatus | null {
	const entry = ciCache.get(key);
	if (!entry) return null;
	const age = Date.now() - entry.at;
	if (entry.status.state === 'pending' && age > CI_PENDING_TTL_MS) return null;
	if (entry.status.state === 'none' && age > CI_NONE_TTL_MS) return null;
	return entry.status;
}

function storeCi(key: string, status: CommitCiStatus): void {
	if (ciCache.size >= CI_CACHE_MAX) {
		const oldest = ciCache.keys().next();
		if (!oldest.done) ciCache.delete(oldest.value);
	}
	ciCache.set(key, { status, at: Date.now() });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * The .gitignore template a project's own files point at.
 *
 * Read from marker files, not from anything the user said: a `package.json`
 * means Node whatever else is in the folder. Names are the ones the services'
 * template lists use; the caller matches them case-insensitively.
 */
const STACK_MARKERS: { files: string[]; template: string }[] = [
	{ files: ['package.json', 'bun.lock', 'bun.lockb'], template: 'Node' },
	{ files: ['Cargo.toml'], template: 'Rust' },
	{ files: ['go.mod'], template: 'Go' },
	{ files: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'], template: 'Python' },
	{ files: ['Gemfile'], template: 'Ruby' },
	{ files: ['composer.json'], template: 'Composer' },
	{ files: ['pom.xml'], template: 'Maven' },
	{ files: ['build.gradle', 'build.gradle.kts'], template: 'Gradle' },
	{ files: ['pubspec.yaml'], template: 'Dart' },
	{ files: ['Package.swift'], template: 'Swift' },
	{ files: ['mix.exs'], template: 'Elixir' },
	{ files: ['CMakeLists.txt'], template: 'CMake' },
	{ files: ['deno.json', 'deno.jsonc'], template: 'Node' }
];

export function suggestGitignore(root: string, available: string[]): string | null {
	const byName = new Map(available.map((name) => [name.toLowerCase(), name]));
	for (const marker of STACK_MARKERS) {
		if (marker.files.some((file) => existsSync(join(root, file)))) {
			const match = byName.get(marker.template.toLowerCase());
			if (match) return match;
		}
	}
	return null;
}

const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING'];
const README_FILES = ['README.md', 'README', 'README.txt', 'readme.md'];

export const hostingService = {
	accounts(projectId: string | null): HostAccount[] {
		return hostAccounts(projectId).map(toHostAccount);
	},

	/**
	 * Remotes matched against accounts, in one pass. Cheap — no network — so the
	 * panel can ask on every remote change.
	 */
	async context(projectId: string, root: string): Promise<HostingContext> {
		let remotes: { name: string; fetchUrl: string; pushUrl: string }[] = [];
		try {
			remotes = await gitService.getRemotes(root);
		} catch {
			remotes = [];
		}

		const sorted = [...remotes].sort((a, b) => REMOTE_RANK(a.name) - REMOTE_RANK(b.name));
		const defaults = await Promise.all(sorted.map((remote) =>
			gitService.getDefaultBranch(root, remote.name).catch(() => null)));

		const matched: HostRemote[] = sorted
			.map((remote, index) => {
				const defaultBranch = defaults[index] ?? null;
				const url = remote.pushUrl || remote.fetchUrl;
				const parsed = parseRemoteUrl(url);
				const match = accountForRemote(url, projectId, { strict: false });
				if (match) {
					return {
						name: remote.name,
						url,
						host: parsed?.host ?? null,
						provider: match.ref.provider,
						locator: match.locator,
						accountId: match.ref.account.id,
						links: match.ref.adapter.links(match.ref.credentials, match.locator),
						defaultBranch
					};
				}
				const provider = parsed ? cloudHostKind(parsed.host) : null;
				const locator = parsed && provider ? bareLocator(parsed.path) : null;
				const adapter = provider ? getHostAdapter(provider) : null;
				return {
					name: remote.name,
					url,
					host: parsed?.host ?? null,
					provider,
					locator,
					accountId: null,
					// The cloud services' links need no account — a link to a
					// public page works signed in or not.
					links: adapter && locator && provider !== 'gitea' ? adapter.links({}, locator) : null,
					defaultBranch
				};
			});

		const primary = matched.find((remote) => remote.accountId) ?? matched.find((remote) => remote.provider) ?? matched[0];
		const unserved = matched.find((remote) => remote.provider && !remote.accountId);

		return {
			remotes: matched,
			accounts: this.accounts(projectId),
			primaryRemote: primary?.name ?? null,
			unservedProvider: unserved?.provider && unserved.host ? { provider: unserved.provider, host: unserved.host } : null
		};
	},

	async viewer(accountId: string): Promise<HostViewer> {
		const ref = requireAccount(accountId, null);
		return ref.adapter.viewer(await credentialsForUse(ref.account));
	},

	async owners(accountId: string, projectId: string | null): Promise<HostOwner[]> {
		const ref = requireAccount(accountId, projectId);
		const owners = await ref.adapter.listOwners(await credentialsForUse(ref.account));
		rememberOwners(accountId, owners.map((owner) => owner.login));
		return owners;
	},

	async repos(
		accountId: string,
		projectId: string | null,
		query: { search?: string; owner?: string; page: number }
	): Promise<HostRepoPage> {
		const ref = requireAccount(accountId, projectId);
		return ref.adapter.listRepos(await credentialsForUse(ref.account), query);
	},

	async templates(accountId: string, projectId: string, root: string): Promise<HostTemplates> {
		const ref = requireAccount(accountId, projectId);
		const credentials = await credentialsForUse(ref.account);
		const [gitignore, licenses] = ref.adapter.templates
			? await Promise.all([
				ref.adapter.templates.gitignoreList(credentials).catch(() => []),
				ref.adapter.templates.licenseList(credentials).catch(() => [])
			])
			: [[], []];

		let pendingFiles = 0;
		try {
			const status = await gitService.getStatus(root);
			pendingFiles = new Set([
				...status.staged.map((file) => file.path),
				...status.unstaged.map((file) => file.path),
				...status.untracked.map((file) => file.path)
			]).size;
		} catch {
			pendingFiles = 0;
		}

		return {
			gitignore,
			licenses,
			suggestedGitignore: suggestGitignore(root, gitignore.map((entry) => entry.key)),
			existing: {
				gitignore: existsSync(join(root, '.gitignore')),
				license: LICENSE_FILES.some((file) => existsSync(join(root, file))),
				readme: README_FILES.some((file) => existsSync(join(root, file)))
			},
			needsFirstCommit: !(await hasCommits(root)),
			pendingFiles
		};
	},

	/**
	 * Create the repository on the service, connect it as a remote, push.
	 *
	 * Local files first, remote last: a template that cannot be fetched fails
	 * the publish before anything exists on the service, so a retry does not
	 * meet "name already taken" from a half-finished first attempt.
	 */
	async publish(projectId: string, root: string, input: PublishRepoInput): Promise<PublishRepoResult> {
		const ref = requireAccount(input.accountId, projectId);
		const credentials = await credentialsForUse(ref.account);

		const name = input.name.trim();
		if (!REPO_NAME.test(name)) throw new Error('Use letters, numbers, dots, dashes and underscores for the name');
		const remoteName = input.remoteName.trim() || 'origin';
		if (!REMOTE_NAME.test(remoteName)) throw new Error('That is not a valid remote name');

		const existingRemotes = await gitService.getRemotes(root).catch(() => []);
		if (existingRemotes.some((remote) => remote.name === remoteName)) {
			throw new Error(`A remote called "${remoteName}" already exists`);
		}

		const owners = await ref.adapter.listOwners(credentials);
		const owner = owners.find((candidate) => candidate.login === input.owner);
		if (!owner) throw new Error(`${input.owner} is not an owner this account can create repositories under`);

		// --- local files ---
		const holder = { year: String(new Date().getFullYear()), fullname: owner.name || owner.login };
		if (input.gitignore && ref.adapter.templates && !existsSync(join(root, '.gitignore'))) {
			await writeFile(join(root, '.gitignore'), await ref.adapter.templates.gitignore(credentials, input.gitignore));
		}
		if (input.license && ref.adapter.templates && !LICENSE_FILES.some((file) => existsSync(join(root, file)))) {
			await writeFile(join(root, 'LICENSE'), await ref.adapter.templates.license(credentials, input.license, holder));
		}
		if (input.readme && !README_FILES.some((file) => existsSync(join(root, file)))) {
			const description = input.description.trim();
			await writeFile(join(root, 'README.md'), `# ${name}\n${description ? `\n${description}\n` : ''}`);
		}

		if (input.createFirstCommit && !(await hasCommits(root))) {
			await gitService.stageAll(root);
			await gitService.commit(root, 'Initial commit', resolveGitEnv(projectId));
		}

		// --- the service ---
		const repo = await ref.adapter.createRepo(credentials, {
			owner,
			name,
			description: input.description.trim(),
			isPrivate: input.isPrivate
		});
		debug.log('git-hosts', `Created ${repo.fullName} on ${ref.adapter.serviceName}`);

		const url = input.protocol === 'ssh' && repo.cloneUrlSsh ? repo.cloneUrlSsh : repo.cloneUrlHttps;
		await gitService.addRemote(root, remoteName, url);

		const push = await pushBranch(projectId, root, remoteName, url);
		return { repo, remoteName, pushed: push.pushed, pushMessage: push.message };
	},

	/**
	 * Fork the repository a remote points at, and push the current branch there.
	 *
	 * When the forked remote is `origin` and there is no `upstream` yet, the
	 * remotes are rearranged the way `gh repo fork` does it — the original
	 * becomes `upstream`, the fork becomes `origin` — because that is the layout
	 * every contributor guide assumes. Otherwise the fork is added alongside,
	 * named after the account, and nothing existing is renamed.
	 */
	async fork(projectId: string, root: string, input: { accountId: string; remote: string }): Promise<ForkResult> {
		const ref = requireAccount(input.accountId, projectId);
		const credentials = await credentialsForUse(ref.account);

		const remotes = await gitService.getRemotes(root);
		const source = remotes.find((remote) => remote.name === input.remote);
		if (!source) throw new Error(`There is no remote called "${input.remote}"`);
		const sourceUrl = source.pushUrl || source.fetchUrl;
		const locator = ref.adapter.locatorFromRemote(sourceUrl, credentials);
		if (!locator) throw new Error(`${input.remote} does not point at ${ref.adapter.serviceName}`);

		const fork = await ref.adapter.fork(credentials, locator);
		const usesSsh = !/^https?:\/\//i.test(sourceUrl);
		const forkUrl = usesSsh && fork.cloneUrlSsh ? fork.cloneUrlSsh : fork.cloneUrlHttps;

		const names = new Set(remotes.map((remote) => remote.name));
		let forkRemote: string;
		let upstreamRemote: string | null = null;
		if (input.remote === 'origin' && !names.has('upstream')) {
			await gitService.renameRemote(root, 'origin', 'upstream');
			forkRemote = 'origin';
			upstreamRemote = 'upstream';
		} else {
			const login = (credentials.login || 'fork').replace(/[^A-Za-z0-9._-]/g, '-');
			forkRemote = !names.has(login) ? login : !names.has('fork') ? 'fork' : `fork-${Date.now().toString(36)}`;
		}
		await gitService.addRemote(root, forkRemote, forkUrl);

		const push = await pushBranch(projectId, root, forkRemote, forkUrl);
		return { fork, forkRemote, upstreamRemote, pushed: push.pushed, pushMessage: push.message };
	},

	/**
	 * Whether pushing to a remote is refused for permission — the question the
	 * fork offer hangs on. Null when the account cannot say.
	 */
	async canPush(projectId: string, root: string, remote: string): Promise<{ canPush: boolean | null; accountId: string | null; repo: HostedRepo | null }> {
		const remotes = await gitService.getRemotes(root).catch(() => []);
		const target = remotes.find((entry) => entry.name === remote);
		if (!target) return { canPush: null, accountId: null, repo: null };
		const match = accountForRemote(target.pushUrl || target.fetchUrl, projectId, { strict: false });
		if (!match) return { canPush: null, accountId: null, repo: null };
		try {
			const repo = await match.ref.adapter.getRepo(await credentialsForUse(match.ref.account), match.locator);
			return { canPush: repo.canPush, accountId: match.ref.account.id, repo };
		} catch {
			return { canPush: null, accountId: match.ref.account.id, repo: null };
		}
	},

	async commitStatuses(projectId: string, root: string, remote: string | null, shas: string[]): Promise<CommitCiStatus[]> {
		const remotes = await gitService.getRemotes(root).catch(() => []);
		const ordered = [...remotes].sort((a, b) => REMOTE_RANK(a.name) - REMOTE_RANK(b.name));
		const target = remote ? ordered.find((entry) => entry.name === remote) : ordered[0];
		if (!target) return [];
		const match = accountForRemote(target.pushUrl || target.fetchUrl, projectId, { strict: false });
		if (!match) return [];

		const prefix = `${match.ref.account.id}:${match.locator}:`;
		const missing = shas.filter((sha) => !cachedCi(prefix + sha));
		if (missing.length > 0) {
			const credentials = await credentialsForUse(match.ref.account);
			const fresh = await match.ref.adapter.commitStatuses(credentials, match.locator, missing);
			for (const status of fresh) storeCi(prefix + status.sha, status);
		}
		return shas.map((sha) => cachedCi(prefix + sha) ?? { sha, state: 'none', url: null, summary: 'No checks' });
	}
};
