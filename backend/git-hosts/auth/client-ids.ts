/**
 * OAuth client ids Clopen ships for the cloud hosts.
 *
 * A device-flow client id is PUBLIC — it is not a secret and needs none — so
 * shipping one inside an open-source app is exactly how GitHub and GitLab
 * intend it to be used. What a shipped id cannot do is reach a self-hosted
 * server, where no app of ours exists; there the user's own app's id is used.
 *
 * Each id can be overridden by an environment variable, which is how a fork or
 * a company build points Clopen at its own OAuth app without patching code.
 * Until an id is set, the device flow is not offered for that host and the
 * connect dialog says so instead of starting a sign-in that cannot work.
 */

const BUNDLED: Record<string, string> = {
	github: '',
	gitlab: ''
};

const ENV_KEYS: Record<string, string> = {
	github: 'CLOPEN_GITHUB_OAUTH_CLIENT_ID',
	gitlab: 'CLOPEN_GITLAB_OAUTH_CLIENT_ID'
};

/** The client id for the CLOUD host of a provider, or null when none is configured. */
export function bundledClientId(provider: string): string | null {
	const fromEnv = ENV_KEYS[provider] ? process.env[ENV_KEYS[provider]]?.trim() : '';
	const value = fromEnv || BUNDLED[provider] || '';
	return value || null;
}

export function hasBundledClientId(provider: string): boolean {
	return bundledClientId(provider) !== null;
}
