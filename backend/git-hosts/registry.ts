/**
 * Hosting adapters, keyed by integration provider id.
 *
 * The provider id IS the host kind — `github`, `gitlab`, `gitea`, `bitbucket`
 * — so an account row says which adapter serves it without a lookup table.
 */

import type { GitHostKind } from '$shared/types/git-hosting';
import { GIT_HOST_KINDS } from '$shared/types/git-hosting';
import type { GitHostAdapter } from './types';
import { githubHost } from './providers/github';
import { gitlabHost } from './providers/gitlab';
import { giteaHost } from './providers/gitea';
import { bitbucketHost } from './providers/bitbucket';

const adapters: Record<GitHostKind, GitHostAdapter> = {
	github: githubHost,
	gitlab: gitlabHost,
	gitea: giteaHost,
	bitbucket: bitbucketHost
};

export function isGitHostKind(value: string): value is GitHostKind {
	return (GIT_HOST_KINDS as readonly string[]).includes(value);
}

export function getHostAdapter(provider: string): GitHostAdapter | null {
	return isGitHostKind(provider) ? adapters[provider] : null;
}

/**
 * Which service a bare hostname belongs to, for a remote no account serves.
 *
 * Only the cloud hosts can be named from a hostname. A self-hosted server is
 * recognised by the account that points at it, never by guessing from its name.
 */
export function cloudHostKind(host: string): GitHostKind | null {
	switch (host) {
		case 'github.com':
			return 'github';
		case 'gitlab.com':
			return 'gitlab';
		case 'bitbucket.org':
			return 'bitbucket';
		case 'codeberg.org':
			return 'gitea';
		default:
			return null;
	}
}
