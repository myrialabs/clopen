/**
 * Connecting from what is already on this machine, and recognising a server.
 */

import type { DetectedCredential, GitHostKind, ServerProbeResult } from '$shared/types/git-hosting';
import type { IntegrationCapability } from '$shared/types/integrations';
import { getProvider } from '$backend/integrations';
import { cliForProvider, detectCliLogins, readCliToken, readKeychain, teaServerUrl, type CliTool } from '../cli';
import { hostOfBase, normaliseBaseUrl } from '../urls';
import { connectHostAccount } from './connect';

interface LocalTarget {
	provider: GitHostKind;
	baseUrl?: string;
	label?: string;
	projectId?: string | null;
	capabilities?: IntegrationCapability[];
	accountId?: string | null;
}

/** The host a provider + optional server URL resolves to. */
function hostFor(provider: GitHostKind, baseUrl: string | undefined): string | null {
	const base = normaliseBaseUrl(baseUrl);
	if (base) return hostOfBase(base) || null;
	return getProvider(provider)?.hosting?.defaultHost ?? null;
}

/**
 * Logins found on this machine. With no server URL, every host the CLI knows
 * is listed — that is how "gh is signed in to ghe.acme.com" gets offered
 * before anyone types the address.
 */
export async function detectLocal(provider: GitHostKind, baseUrl?: string): Promise<DetectedCredential[]> {
	const explicit = normaliseBaseUrl(baseUrl);
	const host = explicit ? hostOfBase(explicit) : null;
	const found = await detectCliLogins(provider, host);
	if (host || found.length > 0) return found;
	// No URL and nothing listed: at least ask about the cloud host by name,
	// which catches a CLI that keeps its hosts file somewhere unusual.
	const fallbackHost = hostFor(provider, undefined);
	return fallbackHost ? detectCliLogins(provider, fallbackHost) : [];
}

export async function connectFromCli(
	input: LocalTarget & { host: string; mode: 'linked' | 'copy' }
): Promise<Awaited<ReturnType<typeof connectHostAccount>>> {
	const tool = cliForProvider(input.provider);
	if (!tool) throw new Error('This service has no CLI to borrow a login from');

	const token = await readCliToken(tool, input.host);
	if (!token) throw new Error(`${tool} has no token for ${input.host}. Run "${tool} auth login" first.`);

	// The server root: the cloud default needs none; any other host needs one,
	// and `tea` knows the exact URL including a sub-path.
	const cloudHost = getProvider(input.provider)?.hosting?.defaultHost;
	const baseUrl = input.host === cloudHost
		? ''
		: (tool === 'tea' ? teaServerUrl(input.host) : null) ?? `https://${input.host}`;

	const linked = input.mode === 'linked';
	return connectHostAccount({
		provider: input.provider,
		accountId: input.accountId,
		label: input.label,
		projectId: input.projectId,
		capabilities: input.capabilities,
		authMethod: 'cli',
		source: linked ? 'cli' : 'token',
		fields: { token, ...(baseUrl && { baseUrl }) },
		extra: linked ? { cliTool: tool satisfies CliTool, cliHost: input.host } : {}
	});
}

export async function connectFromKeychain(
	input: LocalTarget
): Promise<Awaited<ReturnType<typeof connectHostAccount>>> {
	const host = hostFor(input.provider, input.baseUrl);
	if (!host) throw new Error('Enter the server URL first');
	const found = await readKeychain(host);
	if (!found) throw new Error(`Nothing is stored for ${host} in git's credential helpers.`);

	const baseUrl = normaliseBaseUrl(input.baseUrl);
	return connectHostAccount({
		provider: input.provider,
		accountId: input.accountId,
		label: input.label,
		projectId: input.projectId,
		capabilities: input.capabilities,
		authMethod: 'cli',
		source: 'keychain',
		fields: {
			token: found.password,
			...(baseUrl && { baseUrl }),
			// Bitbucket authenticates the API as email:token. A keychain entry
			// holds the git username instead, which is only right if the user
			// stored their email there; the connect form asks when it is not.
			...(input.provider === 'bitbucket' && found.username.includes('@') && { email: found.username })
		}
	});
}

/**
 * What a server URL is. Tried in order of how cheaply each answers:
 * GitLab's version endpoint needs auth on most installs but still answers 401
 * with a recognisable shape, Gitea's and Forgejo's are public.
 */
export async function probeServer(rawUrl: string): Promise<ServerProbeResult> {
	const baseUrl = normaliseBaseUrl(rawUrl);
	const empty: ServerProbeResult = { provider: null, flavour: null, version: null, baseUrl };
	if (!baseUrl) return empty;

	const get = async (path: string) => {
		try {
			return await fetch(`${baseUrl}${path}`, {
				headers: { Accept: 'application/json', 'User-Agent': 'clopen' },
				signal: AbortSignal.timeout(8000),
				redirect: 'follow'
			});
		} catch {
			return null;
		}
	};

	// Forgejo answers its own endpoint; Gitea does not, so ask Forgejo first.
	const forgejo = await get('/api/forgejo/v1/version');
	if (forgejo?.ok) {
		const body = (await forgejo.json().catch(() => ({}))) as { version?: string };
		return { provider: 'gitea', flavour: 'forgejo', version: body.version ?? null, baseUrl };
	}

	const gitea = await get('/api/v1/version');
	if (gitea?.ok) {
		const body = (await gitea.json().catch(() => ({}))) as { version?: string };
		return { provider: 'gitea', flavour: 'gitea', version: body.version ?? null, baseUrl };
	}

	const gitlab = await get('/api/v4/version');
	if (gitlab && (gitlab.ok || gitlab.status === 401)) {
		const body = (await gitlab.json().catch(() => ({}))) as { version?: string; message?: string };
		if (gitlab.ok || body.message?.includes('Unauthorized')) {
			return { provider: 'gitlab', flavour: 'gitlab', version: body.version ?? null, baseUrl };
		}
	}

	const ghes = await get('/api/v3/meta');
	if (ghes && (ghes.ok || ghes.headers.get('x-github-request-id'))) {
		const body = (await ghes.json().catch(() => ({}))) as { installed_version?: string };
		return { provider: 'github', flavour: 'github-enterprise', version: body.installed_version ?? null, baseUrl };
	}

	return empty;
}
