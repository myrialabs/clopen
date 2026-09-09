/**
 * Firecrawl — crawl a live site and hand the agent clean markdown.
 *
 * The second of the two proof presets, covering the STDIO path: the stored API
 * key is projected into the child process's ENVIRONMENT, which is the shape
 * every locally-spawned MCP server uses.
 */

import { defineProvider } from '../define';

export default defineProvider({
	id: 'firecrawl',
	name: 'Firecrawl',
	category: 'research',
	description:
		'Crawls and converts live sites into clean markdown. Pairs with the browser automation tools rather than replacing them — this is for reading a site at scale, not driving one.',
	docsUrl: 'https://firecrawl.dev',
	authMethod: 'api-key',
	capabilities: ['agent-tools'],
	credentialFields: [
		{
			name: 'apiKey',
			label: 'API key',
			placeholder: 'fc-…',
			help: 'From your Firecrawl dashboard.',
			isSecret: true,
			isRequired: true
		}
	],
	mcp: {
		slug: 'firecrawl',
		name: 'Firecrawl',
		description: 'Web crawling and markdown extraction',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', 'firecrawl-mcp'],
		env: {
			apiKey: 'FIRECRAWL_API_KEY'
		}
	}
});
