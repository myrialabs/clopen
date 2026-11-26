/**
 * GitLab — gitlab.com and self-managed instances.
 *
 * The same three ways in as GitHub. `glab` is borrowed when it is signed in;
 * the OAuth device grant exists from GitLab 17.2 and needs only a client id;
 * and a personal access token with the `api` scope works on every version.
 *
 * Self-managed is the common case for GitLab, not the exception, so the server
 * URL is a first-class field rather than an "Enterprise" footnote. An OAuth
 * sign-in against a self-managed server needs an application registered on
 * THAT server — Clopen's own app only exists on gitlab.com.
 */

import { defineProvider } from '../define';

export default defineProvider({
	id: 'gitlab',
	name: 'GitLab',
	category: 'source-control',
	description:
		'Publish projects, push without a separate credential, and work with issues, merge requests and pipelines from the Git panel.',
	docsUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens?name=Clopen&scopes=api,read_user,write_repository',
	consoleUrl: 'https://gitlab.com',
	authMethod: 'api-key',
	authMethods: ['cli', 'oauth-device', 'api-key'],
	hosting: {
		defaultHost: 'gitlab.com',
		selfHosted: true,
		requiresServerUrl: false,
		cli: 'glab',
		deviceFlow: true,
		browserFlow: false,
		oauthAppUrl: 'https://gitlab.com/-/user_settings/applications',
		// `write_repository` is what git over HTTPS checks; `api` alone does not
		// authorise a push on every version.
		scopes: ['api', 'read_user', 'write_repository']
	},
	capabilities: ['work'],
	credentialFields: [
		{
			name: 'token',
			label: 'Personal access token',
			placeholder: 'glpat-…',
			help: 'Scopes: "api", "read_user" and "write_repository".',
			isSecret: true,
			isRequired: true
		},
		{
			name: 'baseUrl',
			label: 'Server URL',
			placeholder: 'https://gitlab.your-company.com',
			help: 'Leave empty for gitlab.com.',
			isSecret: false,
			isRequired: false
		}
	]
});
