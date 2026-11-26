/**
 * GitHub — the first provider behind the Issues & PRs surface.
 *
 * AUTH IS A PERSONAL ACCESS TOKEN, and the guidance is CLASSIC, not
 * fine-grained. That is a correction: the first version recommended
 * fine-grained tokens for least privilege, and least privilege is the wrong
 * trade when it silently removes access the user already has.
 *
 * A fine-grained token is scoped to ONE resource owner. It cannot reach a
 * repository owned by another person at all — being a collaborator does not
 * help, because that owner never granted the token — and an organisation's
 * repositories stay invisible until an owner approves it. Both failures arrive
 * as an ordinary 404, which reads as "your repository does not exist". For a
 * tool whose whole premise is working on the repositories you already
 * collaborate on, that is the common case broken by default.
 *
 * A classic token with `repo` reaches exactly what its user reaches, which is
 * the behaviour people expect. Fine-grained tokens still work where they apply
 * and are not rejected — the diagnosis in the adapter names the difference when
 * one of them cannot see a repository.
 *
 * Three ways in, cheapest first. A `gh` CLI that is already signed in is
 * borrowed — LINKED, so the token is re-read from `gh` on every use and
 * rotating or logging out there is followed here. The OAuth device flow needs
 * only a client id, never a secret, which is why it suits a self-hosted app:
 * the id ships with Clopen (or is overridden by the user's own app for
 * Enterprise Server). And the token form stays, because it is the one method
 * that works on every server and under every policy.
 *
 * `agent-tools` is DECLARED but OFF by default. GitHub's official remote MCP
 * server accepts the same token, so offering it costs nothing — but adding a
 * tool namespace to every engine in every session is a thing a user should turn
 * on, not something that happens because they wanted to see their issues.
 */

import { defineProvider } from '../define';

export default defineProvider({
	id: 'github',
	name: 'GitHub',
	category: 'source-control',
	description:
		'Publish repositories, push without a separate credential, and work with issues, pull requests and Actions from the Git panel.',
	docsUrl: 'https://github.com/settings/tokens/new?scopes=repo,read:org,workflow&description=Clopen',
	consoleUrl: 'https://github.com',
	authMethod: 'api-key',
	authMethods: ['cli', 'oauth-device', 'api-key'],
	hosting: {
		defaultHost: 'github.com',
		selfHosted: true,
		requiresServerUrl: false,
		cli: 'gh',
		deviceFlow: true,
		browserFlow: false,
		oauthAppUrl: 'https://github.com/settings/applications/new',
		// `workflow` because pushing a change under .github/workflows over
		// HTTPS is refused without it — a failure that otherwise reads as a
		// broken token on the one commit that touched CI.
		scopes: ['repo', 'read:org', 'workflow']
	},
	capabilities: ['work', 'agent-tools'],
	// Connecting GitHub means "show me my work", not "give every agent GitHub
	// tools". The second is one switch away in the hub.
	defaultCapabilities: ['work'],
	credentialFields: [
		{
			name: 'token',
			label: 'Personal access token (classic)',
			placeholder: 'ghp_…',
			// Deliberately short. The full explanation of why classic beats
			// fine-grained belongs in the error a failing token produces, where
			// it is actionable — not in a paragraph nobody reads while pasting.
			help: 'Scopes: "repo" and "workflow" (plus "read:org" for SAML organisations). Fine-grained tokens work too, but only for repositories their owner granted.',
			isSecret: true,
			isRequired: true
		},
		{
			name: 'baseUrl',
			label: 'Enterprise Server URL',
			placeholder: 'https://github.your-company.com',
			help: 'Leave empty for github.com. Set this only for GitHub Enterprise Server.',
			isSecret: false,
			isRequired: false
		}
	],
	mcp: {
		slug: 'github',
		name: 'GitHub',
		description: 'Official GitHub MCP server — repositories, issues, pull requests and Actions',
		transport: 'http',
		url: 'https://api.githubcopilot.com/mcp/',
		headers: {
			token: { name: 'Authorization', format: 'Bearer {value}' }
		}
	}
});
