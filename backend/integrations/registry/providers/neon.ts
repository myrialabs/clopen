/**
 * Neon — the first provider behind the `worktree-branching` capability, and the
 * second behind `database`.
 *
 * ONE CREDENTIAL, TWO CAPABILITIES, which is the shape this provider was picked
 * to prove. The same API key both lists projects for DB Client and cuts a
 * branch for a worktree, so making it two accounts would mean pasting one key
 * twice and rotating it in two places — the mistake `Task 3` refused for Vercel
 * teams and `Task 4` refused for Supabase projects.
 *
 * Worth knowing about Neon's keys: they come in two scopes. A PERSONAL key
 * reaches the projects its user owns; an ORGANISATION key reaches that
 * organisation's and nothing else. Neither is wrong and the difference is
 * invisible until a project the user can plainly see in the console is missing
 * from the list, so the credential help names it rather than leaving it to be
 * discovered.
 *
 * NO `agent-tools`, even though Neon ships an MCP server. That server uses its
 * own OAuth — a different audience from this REST key — so declaring it would
 * mean projecting a row this credential cannot fill, which is the same reason
 * `Task 3` left Vercel's MCP alone.
 *
 * NO `inbound-events`. Neon's webhooks are an organisation-level billing and
 * usage feed, not something any surface here subscribes to yet.
 */

import { defineProvider } from '../define';

export default defineProvider({
	id: 'neon',
	name: 'Neon',
	category: 'database',
	description:
		'Serverless Postgres in DB Client, plus a database branch per worktree: creating a worktree cuts a copy-on-write branch and points its connection string at it, and deleting the worktree deletes the branch.',
	docsUrl: 'https://console.neon.tech/app/settings/api-keys',
	consoleUrl: 'https://console.neon.tech',
	authMethod: 'api-key',
	capabilities: ['database', 'worktree-branching'],
	// Both ON by default. Unlike GitHub's `agent-tools` — which hands an agent
	// write access to every repository and therefore has to be asked for —
	// neither of these does anything until the user points a project at a
	// database, so defaulting them off would only add a step before the feature
	// they connected the account for.
	credentialFields: [
		{
			name: 'apiKey',
			label: 'API key',
			placeholder: 'napi_…',
			help:
				'Neon console → Account settings → API keys. A PERSONAL key reaches the projects you own; an ORGANISATION key reaches only that organisation\'s. Pick the one that owns the database you want to branch.',
			isSecret: true,
			isRequired: true
		}
	]
});
