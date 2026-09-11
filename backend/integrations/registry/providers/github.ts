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
 * The OAuth device flow the spec sketched is still not used: it needs an
 * embedded client id that makes every self-hosted install depend on one app we
 * own, and it can be added later without changing what is stored, since it is
 * only another way to fill the same `token` field.
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
		'Issues, pull requests and Actions for the repository this project pushes to. Start work on an issue in its own worktree, open and merge pull requests, and send a failing CI run into the chat.',
	docsUrl: 'https://github.com/settings/tokens/new?scopes=repo,read:org&description=Clopen',
	authMethod: 'api-key',
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
			help: 'Scope: "repo" (plus "read:org" for SAML organisations). Fine-grained tokens work too, but only for repositories their owner granted.',
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
