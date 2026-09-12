/**
 * Vercel — the first provider behind the Deployments surface.
 *
 * ONE CREDENTIAL FIELD, deliberately. A Vercel token reaches the personal
 * account and every team its user belongs to, so "which team" is not a property
 * of the credential — it is a property of the project you picked. Putting a
 * `teamId` field here would force a user with two teams to connect the same
 * token twice, and would make the first project they bind decide the second.
 * The team is stored on the binding instead, where it belongs.
 *
 * NO `agent-tools`. Vercel does run an MCP server, but it authenticates with
 * its own OAuth rather than this REST token — a different audience, which the
 * account layer treats as a second credential rather than a reuse of this one.
 * Declaring the capability would mean projecting an MCP row we cannot fill from
 * what is stored here. It stays addable later as its own provider entry.
 *
 * NO `inbound-events`. Vercel can sign webhooks, but a Clopen that is usually
 * reached on localhost has no public URL to register, and `Task 7` is the first
 * entry that builds a subscriber worth registering one for.
 */

import { defineProvider } from '../define';

export default defineProvider({
	id: 'vercel',
	name: 'Vercel',
	category: 'deployment',
	description:
		'Deployments for the project this repository builds to. Watch a build as it runs, send a failed build log into the chat, open a preview build in the browser panel, and redeploy, cancel, roll back or promote from here.',
	docsUrl: 'https://vercel.com/account/tokens',
	authMethod: 'api-key',
	capabilities: ['deployments'],
	credentialFields: [
		{
			name: 'token',
			label: 'Access token',
			placeholder: 'Vercel access token',
			// Scope guidance rather than a tutorial: the failure this prevents is
			// a token scoped to one team that then cannot see another team's
			// project, which arrives as an empty list rather than an error.
			help: 'Account Settings → Tokens. A token scoped to a team only reaches that team\'s projects — pick "Full Account" if this Clopen deploys for more than one.',
			isSecret: true,
			isRequired: true
		}
	]
});
