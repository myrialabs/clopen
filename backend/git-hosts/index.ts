/**
 * Git hosting — GitHub, GitLab, Gitea/Forgejo and Bitbucket, as the services a
 * repository lives on.
 *
 *   types.ts        the adapter contract
 *   registry.ts     provider id → adapter
 *   providers/      one adapter per service
 *   accounts.ts     which connected account answers for a host or a remote
 *   credentials.ts  a credential as it should be used now (linked CLI, OAuth refresh)
 *   cli.ts          logins already on this machine — gh, glab, tea, git's keychain
 *   auth/           device flow, browser flow, and turning any credential into an account
 *   service.ts      what the Git panel asks: context, publish, fork, CI, templates
 *   git-credential  the hosting half of the git credential helper
 *
 * Importing this module wires the one side effect it has: a terminal's git
 * config file names the hosts that accounts answer for, so it is rewritten
 * whenever an account is connected, changed or removed.
 */

import { onAccountsChanged } from '$backend/integrations';
import { refreshScopeConfigs } from '$backend/git/identity';

onAccountsChanged(() => {
	void refreshScopeConfigs();
});

export { hostingService, suggestGitignore } from './service';
export { getHostAdapter, isGitHostKind, cloudHostKind } from './registry';
export { accountForRemote, hostAccounts, hostAccountById } from './accounts';
export { credentialsForUse, authSourceOf } from './credentials';
export { connectHostAccount } from './auth/connect';
export { startDeviceFlow, startBrowserFlow, completeBrowserFlow, failBrowserFlow, pollFlow, cancelFlow, oauthCallbackUri } from './auth/flows';
export { detectLocal, connectFromCli, connectFromKeychain, probeServer } from './auth/local';
export type { GitHostAdapter, HostCredentials } from './types';
