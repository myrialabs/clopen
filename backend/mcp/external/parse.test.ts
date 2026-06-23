import { describe, expect, test } from 'bun:test';
import { parseMcpConfig } from './parse';

describe('parseMcpConfig', () => {
	test('Claude Desktop / Cursor mcpServers stdio shape', () => {
		const { servers, errors } = parseMcpConfig(JSON.stringify({
			mcpServers: {
				notion: {
					command: 'npx',
					args: ['-y', '@notionhq/notion-mcp-server'],
					env: { NOTION_TOKEN: 'secret_abc123' }
				}
			}
		}));
		expect(errors).toEqual([]);
		expect(servers).toHaveLength(1);
		const s = servers[0];
		expect(s.name).toBe('notion');
		expect(s.transport).toBe('stdio');
		expect(s.command).toBe('npx');
		expect(s.args).toEqual(['-y', '@notionhq/notion-mcp-server']);
		expect(s.fields).toEqual([
			{ name: 'NOTION_TOKEN', kind: 'env', value: 'secret_abc123', isPlaceholder: false }
		]);
	});

	test('Cursor remote mcpServers infers http from url', () => {
		const { servers } = parseMcpConfig(JSON.stringify({
			mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' } }
		}));
		expect(servers[0].transport).toBe('http');
		expect(servers[0].url).toBe('https://mcp.linear.app/mcp');
	});

	test('url ending in /sse is inferred as sse', () => {
		const { servers } = parseMcpConfig(JSON.stringify({
			mcpServers: { x: { url: 'https://example.com/sse' } }
		}));
		expect(servers[0].transport).toBe('sse');
	});

	test('VS Code servers block with explicit type and ${input:} placeholder', () => {
		const { servers } = parseMcpConfig(JSON.stringify({
			servers: {
				github: {
					type: 'http',
					url: 'https://api.githubcopilot.com/mcp/',
					headers: { Authorization: 'Bearer ${input:github_token}' }
				}
			},
			inputs: [{ id: 'github_token', type: 'promptString' }]
		}));
		expect(servers).toHaveLength(1);
		const s = servers[0];
		expect(s.transport).toBe('http');
		const field = s.fields.find(f => f.name === 'Authorization');
		expect(field?.kind).toBe('header');
		expect(field?.isPlaceholder).toBe(true);
		expect(field?.value).toBe('');
		expect(s.warnings.some(w => w.includes('${input:'))).toBe(true);
	});

	test('OpenCode mcp block: command array, environment key, type local', () => {
		const { servers } = parseMcpConfig(JSON.stringify({
			mcp: {
				'my-server': {
					type: 'local',
					command: ['npx', '-y', 'my-mcp', 'serve'],
					environment: { API_KEY: 'live-key' },
					enabled: true
				}
			}
		}));
		const s = servers[0];
		expect(s.transport).toBe('stdio');
		expect(s.command).toBe('npx');
		expect(s.args).toEqual(['-y', 'my-mcp', 'serve']);
		expect(s.fields).toEqual([
			{ name: 'API_KEY', kind: 'env', value: 'live-key', isPlaceholder: false }
		]);
	});

	test('OpenCode remote type maps to http (switchable)', () => {
		const { servers } = parseMcpConfig(JSON.stringify({
			mcp: { remote: { type: 'remote', url: 'https://example.com/mcp', headers: { 'X-Key': 'v' } } }
		}));
		expect(servers[0].transport).toBe('http');
		expect(servers[0].fields[0]).toEqual({ name: 'X-Key', kind: 'header', value: 'v', isPlaceholder: false });
	});

	test('single unwrapped server object', () => {
		const { servers } = parseMcpConfig(JSON.stringify({
			command: 'uvx',
			args: ['mcp-server-git']
		}));
		expect(servers).toHaveLength(1);
		expect(servers[0].command).toBe('uvx');
		expect(servers[0].transport).toBe('stdio');
	});

	test('bare name→config map with no wrapper', () => {
		const { servers } = parseMcpConfig(JSON.stringify({
			fs: { command: 'npx', args: ['-y', 'fs-mcp'] },
			git: { command: 'uvx', args: ['git-mcp'] }
		}));
		expect(servers.map(s => s.name).sort()).toEqual(['fs', 'git']);
	});

	test('multiple servers under mcpServers', () => {
		const { servers } = parseMcpConfig(JSON.stringify({
			mcpServers: {
				a: { command: 'npx', args: ['a'] },
				b: { url: 'https://b.example/mcp' }
			}
		}));
		expect(servers).toHaveLength(2);
	});

	test('placeholder detection for common stand-ins', () => {
		const { servers } = parseMcpConfig(JSON.stringify({
			mcpServers: {
				x: {
					command: 'npx',
					env: {
						A: '<your-token>',
						B: 'YOUR_API_KEY',
						C: 'TOKEN_HERE',
						D: '',
						E: 'real-value'
					}
				}
			}
		}));
		const byName = Object.fromEntries(servers[0].fields.map(f => [f.name, f]));
		expect(byName.A.isPlaceholder).toBe(true);
		expect(byName.B.isPlaceholder).toBe(true);
		expect(byName.C.isPlaceholder).toBe(true);
		expect(byName.D.isPlaceholder).toBe(true);
		expect(byName.E.isPlaceholder).toBe(false);
		expect(byName.E.value).toBe('real-value');
	});

	test('serverUrl alias is recognised as a remote url', () => {
		const { servers } = parseMcpConfig(JSON.stringify({
			mcpServers: { ws: { serverUrl: 'https://ws.example/mcp' } }
		}));
		expect(servers[0].url).toBe('https://ws.example/mcp');
		expect(servers[0].transport).toBe('http');
	});

	test('JSONC: comments and trailing commas are tolerated', () => {
		const jsonc = `{
			// my servers
			"mcpServers": {
				"git": {
					"command": "uvx",
					"args": ["mcp-server-git"], /* git tools */
				},
			}
		}`;
		const { servers, errors } = parseMcpConfig(jsonc);
		expect(errors).toEqual([]);
		expect(servers[0].command).toBe('uvx');
	});

	test('invalid JSON returns an error, no servers', () => {
		const { servers, errors } = parseMcpConfig('{ not json');
		expect(servers).toHaveLength(0);
		expect(errors[0]).toContain('Invalid JSON');
	});

	test('empty input returns a friendly error', () => {
		const { servers, errors } = parseMcpConfig('   ');
		expect(servers).toHaveLength(0);
		expect(errors).toHaveLength(1);
	});

	test('object with no server-shaped entries reports nothing found', () => {
		const { servers, errors } = parseMcpConfig(JSON.stringify({ foo: 'bar', count: 3 }));
		expect(servers).toHaveLength(0);
		expect(errors[0]).toContain('No MCP server found');
	});

	test('slug is derived and never starts with reserved internal prefix', () => {
		const { servers } = parseMcpConfig(JSON.stringify({
			mcpServers: { 'Clopen Tools': { command: 'npx' } }
		}));
		expect(servers[0].slug.startsWith('clopen')).toBe(false);
	});
});
