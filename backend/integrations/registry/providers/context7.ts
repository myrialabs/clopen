/**
 * Context7 — up-to-date library documentation for a coding agent.
 *
 * This is one of the two presets that prove the credential-projection paths.
 * Context7 covers the REMOTE path: the stored API key is projected into a
 * request HEADER on an HTTP MCP server, which is the shape every hosted MCP
 * server with a static key uses.
 */

import { defineProvider } from '../define';

export default defineProvider({
	id: 'context7',
	name: 'Context7',
	category: 'research',
	description:
		'Pulls current, version-accurate documentation for a library straight into the session, so the agent stops writing against the API it remembers.',
	docsUrl: 'https://context7.com',
	authMethod: 'api-key',
	capabilities: ['agent-tools'],
	credentialFields: [
		{
			name: 'apiKey',
			label: 'API key',
			placeholder: 'ctx7sk-…',
			help: 'Created in your Context7 dashboard. The free tier is enough for everyday use.',
			isSecret: true,
			isRequired: true
		}
	],
	mcp: {
		slug: 'context7',
		name: 'Context7',
		description: 'Library documentation lookup',
		transport: 'http',
		url: 'https://mcp.context7.com/mcp',
		// The remote endpoint authenticates with the key in its own header
		// rather than `Authorization`, which is why the preset declares the
		// header name instead of assuming a bearer token.
		headers: {
			apiKey: { name: 'CONTEXT7_API_KEY' }
		}
	}
});
