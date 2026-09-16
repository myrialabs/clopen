/**
 * Supabase — the first provider behind the `database` capability.
 *
 * ONE CREDENTIAL FIELD, for the reason Vercel has one. A personal access token
 * reaches every project in every organisation its user belongs to, so "which
 * project" is not a property of the credential — it is a choice, made as many
 * times as the user has databases worth opening. Those choices live in
 * `integration_db_links`, and each one projects a `db_client_connections` row.
 *
 * SCOPED TOKENS are the thing to know about this provider. Supabase is rolling
 * out personal access tokens that carry only the permissions you pick, and they
 * are prefixed `sbp_fc` where a classic full-access token is plain `sbp_`. A
 * scoped token that is missing a permission fails with an undecorated
 * "Forbidden" at the moment the feature is reached, so the client reads that
 * prefix and says which scope is likely absent — the same trick `Task 2` used on
 * GitHub's fine-grained token prefix, and for the same reason.
 *
 * The DATABASE PASSWORD is deliberately not a credential field here. It is not
 * a property of the account either: every project has its own, and no API can
 * read any of them back. It belongs to the link, which is where it is stored.
 *
 * NO `agent-tools`, even though Supabase ships an MCP server that takes exactly
 * this token. That server is scoped with `--project-ref` to ONE project, and an
 * account here can hold several — so there is no honest single row to project.
 * A user who wants those tools installs the server from the MCP registry, which
 * the hub still offers; the day this becomes a per-link capability rather than a
 * per-account one it can be revisited.
 *
 * NO `inbound-events`. Supabase's webhooks are database triggers rather than a
 * signed platform delivery, and `Task 7` is the first entry with a subscriber
 * worth registering one for.
 */

import { defineProvider } from '../define';

export default defineProvider({
	id: 'supabase',
	name: 'Supabase',
	category: 'database',
	description:
		'Postgres projects as connections in DB Client, with the Supabase surface on top: migrations and what is still pending, RLS policies and the security advisor, edge functions, storage buckets, auth users, and generated TypeScript types written into the project.',
	docsUrl: 'https://supabase.com/dashboard/account/tokens',
	consoleUrl: 'https://supabase.com/dashboard',
	authMethod: 'api-key',
	capabilities: ['database'],
	credentialFields: [
		{
			name: 'accessToken',
			label: 'Personal access token',
			placeholder: 'sbp_…',
			// Names the PERMISSIONS rather than describing the screen. Supabase is
			// rolling out scoped tokens, and a scoped token missing one permission
			// fails at the moment the feature is used, with a bare "Forbidden" that
			// says nothing about which scope is absent — so the fix has to be
			// stated before the token is created, not diagnosed afterwards.
			help:
				'Account Settings → Access Tokens. A classic token works as is. A SCOPED token (they start with sbp_fc) needs: Projects (account-wide) Read to list, Project Settings Read, and Database Read-write. Add Organizations Read and Organization Projects Read-write to create projects from here.',
			isSecret: true,
			isRequired: true
		}
	]
});
