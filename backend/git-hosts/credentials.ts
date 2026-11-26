/**
 * An account's credential, as it should be USED right now.
 *
 * Stored credentials are a snapshot. Two kinds of account need more than the
 * snapshot to work:
 *
 *  - LINKED to a CLI (`authSource=cli`). The token is re-read from `gh`/`glab`/
 *    `tea` on use, so logging out or rotating there is followed here. The
 *    snapshot is still kept current, because surfaces that read credentials
 *    synchronously (the agent-tools MCP row, the work view's probe) need
 *    something to read.
 *  - OAUTH with an expiry (`authSource=oauth`). GitLab's tokens last two
 *    hours. A token close to expiry is refreshed with the stored refresh
 *    token before it is handed out, and the new pair replaces the old.
 *
 * Every hosting call and every work call goes through `credentialsForUse`, and
 * so does the git credential helper, so a push and a page load can never
 * disagree about which token is current.
 *
 * Credential keys this module owns, alongside the provider's own fields:
 *   authSource    'token' | 'oauth' | 'cli' | 'keychain'
 *   cliTool       'gh' | 'glab' | 'tea'      (linked accounts)
 *   cliHost       the host the CLI was asked about
 *   refreshToken  OAuth refresh token
 *   expiresAt     ISO time the access token stops working
 *   clientId      the OAuth client the token was issued to (needed to refresh)
 *   login         who the token belongs to, recorded at connect time
 */

import { integrationAccountQueries, type IntegrationAccountRow } from '$backend/database/queries';
import type { GitHostKind } from '$shared/types/git-hosting';
import { debug } from '$shared/utils/logger';
import { readCliToken, type CliTool } from './cli';
import { refreshEndpoint, requestToken } from './auth/endpoints';
import { HostApiError } from './http';
import { isGitHostKind } from './registry';

export type AuthSource = 'token' | 'oauth' | 'cli' | 'keychain';

interface UseOptions {
	/**
	 * False inside the git credential helper: it runs in a process git spawned
	 * for one push, and loading the projection layer there would start MCP
	 * machinery nobody is waiting for. The server re-projects on its own next
	 * use, which reads the token this persisted.
	 */
	reproject?: boolean;
}

/** Refresh this long before the stated expiry, so a slow request does not straddle it. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

/** How long a token read from a CLI is trusted before the CLI is asked again. */
const CLI_CACHE_MS = 60 * 1000;

const cliCache = new Map<string, { token: string; at: number }>();

/** One in-flight refresh per account — two pushes racing must not burn one refresh token twice. */
const refreshing = new Map<string, Promise<Record<string, string>>>();

export function authSourceOf(credentials: Record<string, string>): AuthSource {
	const source = credentials.authSource;
	return source === 'oauth' || source === 'cli' || source === 'keychain' ? source : 'token';
}

/**
 * Persist a changed credential and tell whatever projects it.
 *
 * Imported lazily: the git credential helper runs this module in a short-lived
 * process that must not pull in the projection layer and its MCP machinery.
 */
async function persist(account: IntegrationAccountRow, next: Record<string, string>, options: UseOptions): Promise<void> {
	integrationAccountQueries.setCredentials(account.id, next);
	if (options.reproject === false) return;
	try {
		const { reproject } = await import('$backend/integrations/projections');
		reproject(account.id);
	} catch (error) {
		debug.warn('git-hosts', 'Could not re-project a refreshed credential:', error);
	}
}

async function fromCli(account: IntegrationAccountRow, current: Record<string, string>, options: UseOptions): Promise<Record<string, string>> {
	const tool = current.cliTool as CliTool | undefined;
	const host = current.cliHost;
	if (!tool || !host) return current;

	const key = `${account.id}:${tool}:${host}`;
	const cached = cliCache.get(key);
	let token = cached && Date.now() - cached.at < CLI_CACHE_MS ? cached.token : null;
	if (!token) {
		token = await readCliToken(tool, host);
		if (!token) {
			cliCache.delete(key);
			throw new HostApiError(
				`${tool} is not signed in to ${host} any more. Run "${tool} auth login" there, or reconnect this account with a different method.`,
				401,
				'auth'
			);
		}
		cliCache.set(key, { token, at: Date.now() });
	}

	if (token === current.token) return current;
	const next = { ...current, token };
	await persist(account, next, options);
	debug.log('git-hosts', `Followed a rotated ${tool} token for "${account.label}"`);
	return next;
}

async function refreshOAuth(account: IntegrationAccountRow, current: Record<string, string>, options: UseOptions): Promise<Record<string, string>> {
	if (!current.refreshToken || !current.expiresAt) return current;
	if (new Date(current.expiresAt).getTime() - Date.now() > REFRESH_MARGIN_MS) return current;
	if (!isGitHostKind(account.provider)) return current;

	const endpoint = refreshEndpoint(account.provider as GitHostKind, current.baseUrl);
	if (!endpoint || !current.clientId) return current;

	const inFlight = refreshing.get(account.id);
	if (inFlight) return inFlight;

	const run = (async () => {
		try {
			const tokens = await requestToken(endpoint, {
				grant_type: 'refresh_token',
				refresh_token: current.refreshToken!,
				client_id: current.clientId!
			});
			const next: Record<string, string> = {
				...current,
				token: tokens.accessToken,
				refreshToken: tokens.refreshToken ?? current.refreshToken!,
				expiresAt: tokens.expiresAt ?? ''
			};
			await persist(account, next, options);
			debug.log('git-hosts', `Refreshed the OAuth token for "${account.label}"`);
			return next;
		} catch (error) {
			throw new HostApiError(
				`The ${account.label} sign-in expired and could not be renewed (${error instanceof Error ? error.message : String(error)}). Sign in again.`,
				401,
				'auth'
			);
		} finally {
			refreshing.delete(account.id);
		}
	})();
	refreshing.set(account.id, run);
	return run;
}

/** The credential to use for one call, refreshed or re-read as the account requires. */
export async function credentialsForUse(
	account: IntegrationAccountRow,
	options: UseOptions = {}
): Promise<Record<string, string>> {
	const current = integrationAccountQueries.credentialsOf(account);
	switch (authSourceOf(current)) {
		case 'cli':
			return fromCli(account, current, options);
		case 'oauth':
			return refreshOAuth(account, current, options);
		default:
			return current;
	}
}

/** Drop any cached CLI token for an account, so the next use asks the CLI again. */
export function forgetCachedCliToken(accountId: string): void {
	for (const key of cliCache.keys()) {
		if (key.startsWith(`${accountId}:`)) cliCache.delete(key);
	}
}
