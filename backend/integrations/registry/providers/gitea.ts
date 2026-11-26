/**
 * Gitea and Forgejo — always self-hosted, so the server URL is required.
 *
 * Forgejo is a Gitea fork whose API is still Gitea's, so one provider serves
 * both; the connect dialog probes the server and names which it found.
 *
 * Neither implements the OAuth device grant, so the browser sign-in is the
 * authorization-code flow with PKCE against an application the user registers
 * on their own server (a public client — no secret is stored). `tea` is
 * borrowed when it is signed in to the same server.
 *
 * Hosting only: Clopen has no Issues & PRs adapter for Gitea yet, and saying
 * so is better than declaring a capability that would show nothing.
 */

import { defineProvider } from '../define';

export default defineProvider({
	id: 'gitea',
	name: 'Gitea / Forgejo',
	category: 'source-control',
	description:
		'Publish repositories to your own Gitea or Forgejo server and push without a separate credential.',
	authMethod: 'api-key',
	authMethods: ['cli', 'oauth-code', 'api-key'],
	hosting: {
		defaultHost: null,
		selfHosted: true,
		requiresServerUrl: true,
		cli: 'tea',
		deviceFlow: false,
		browserFlow: true,
		oauthAppUrl: null,
		scopes: ['write:repository', 'read:user', 'read:organization']
	},
	capabilities: [],
	credentialFields: [
		{
			name: 'baseUrl',
			label: 'Server URL',
			placeholder: 'https://git.your-company.com',
			isSecret: false,
			isRequired: true
		},
		{
			name: 'token',
			label: 'Access token',
			help: 'Settings → Applications → Generate token, with repository read/write and user read.',
			isSecret: true,
			isRequired: true
		}
	]
});
