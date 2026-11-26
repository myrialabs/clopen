/**
 * Bitbucket Cloud.
 *
 * Token only. Bitbucket's OAuth needs a client SECRET, and a secret shipped
 * inside a self-hosted app is not a secret. Atlassian API tokens are the
 * supported replacement for app passwords, and they authenticate the REST API
 * as `email:token` and git over HTTPS as `x-bitbucket-api-token-auth:token` —
 * which is why the email is a field.
 *
 * Hosting only, like Gitea: no Issues & PRs adapter yet.
 */

import { defineProvider } from '../define';

export default defineProvider({
	id: 'bitbucket',
	name: 'Bitbucket',
	category: 'source-control',
	description: 'Publish repositories to Bitbucket Cloud and push without a separate credential.',
	docsUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
	consoleUrl: 'https://bitbucket.org',
	authMethod: 'api-key',
	authMethods: ['api-key'],
	hosting: {
		defaultHost: 'bitbucket.org',
		selfHosted: false,
		requiresServerUrl: false,
		cli: null,
		deviceFlow: false,
		browserFlow: false,
		oauthAppUrl: null,
		scopes: ['read:user:bitbucket', 'read:workspace:bitbucket', 'read:repository:bitbucket', 'write:repository:bitbucket', 'admin:repository:bitbucket']
	},
	capabilities: [],
	credentialFields: [
		{
			name: 'email',
			label: 'Atlassian account email',
			placeholder: 'you@example.com',
			isSecret: false,
			isRequired: true
		},
		{
			name: 'token',
			label: 'API token',
			help: 'Create one "with scopes" for Bitbucket: account and workspace read, repository read, write and admin.',
			isSecret: true,
			isRequired: true
		}
	]
});
