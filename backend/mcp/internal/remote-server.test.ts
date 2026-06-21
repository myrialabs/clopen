/**
 * Integration tests for MCP Remote Server authentication.
 *
 * These exercise the real `handleMcpRequest` against the real auth queries and
 * a real test database — the same pattern as files-upload.test.ts. We avoid
 * `mock.module` for shared modules (`$backend/database/queries`,
 * `$backend/auth/tokens`) because Bun applies module mocks process-globally,
 * and a partial `authQueries` stub would leak into other integration tests.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { handleMcpRequest } from './remote-server';
import { getMcpServiceToken } from './service-token';
import { authQueries, settingsQueries } from '../../database/queries';
import { generatePAT, generateSessionToken, hashToken } from '../../auth/tokens';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database';

let testUserId: string;
let sessionToken: string;
let patToken: string;

function setAuthMode(mode: 'none' | 'required'): void {
	settingsQueries.set('system:settings', JSON.stringify({ authMode: mode }));
}

function sessionCount(userId: string): number {
	const row = getDatabase()
		.prepare('SELECT COUNT(*) as count FROM auth_sessions WHERE user_id = ?')
		.get(userId) as { count: number };
	return row.count;
}

function mcpRequest(token?: string): Request {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (token) headers['Authorization'] = `Bearer ${token}`;
	return new Request('http://localhost/mcp', {
		method: 'POST',
		headers,
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'initialize',
			params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
			id: 1
		})
	});
}

beforeAll(async () => {
	await initializeDatabase();

	// Test user authenticates with both a session token and a PAT.
	patToken = generatePAT();
	testUserId = `user-${randomUUID()}`;
	authQueries.createUser({
		id: testUserId,
		name: 'MCP Test User',
		color: '#000000',
		avatar: 'mcp',
		role: 'admin',
		personal_access_token_hash: hashToken(patToken),
		created_at: new Date().toISOString()
	});

	sessionToken = generateSessionToken();
	authQueries.createSession({
		id: randomUUID(),
		user_id: testUserId,
		token_hash: hashToken(sessionToken),
		expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
		created_at: new Date().toISOString(),
		last_active_at: new Date().toISOString()
	});
});

afterAll(() => {
	authQueries.deleteSessionsByUserId(testUserId);
	authQueries.deleteUser(testUserId);
	settingsQueries.set('system:settings', JSON.stringify({ authMode: 'required' }));
	closeDatabase();
});

describe('MCP Remote Server Authentication', () => {
	beforeEach(() => {
		setAuthMode('required');
	});

	test('rejects requests without an Authorization header', async () => {
		const response = await handleMcpRequest(mcpRequest());
		expect(response.status).toBe(401);

		const body = await response.json();
		expect(body.error).toBeDefined();
		expect(body.error.code).toBe(-32001);
		expect(body.error.message).toContain('Unauthorized');
	});

	test('rejects requests with an invalid Bearer token', async () => {
		const response = await handleMcpRequest(mcpRequest('invalid-token-12345'));
		expect(response.status).toBe(401);

		const body = await response.json();
		expect(body.error.code).toBe(-32001);
	});

	test('rejects requests with a malformed Authorization header', async () => {
		const request = new Request('http://localhost/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': 'InvalidFormat token123' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: {}, id: 1 })
		});
		const response = await handleMcpRequest(request);
		expect(response.status).toBe(401);
	});

	test('includes a WWW-Authenticate header in 401 responses', async () => {
		const response = await handleMcpRequest(mcpRequest());
		expect(response.status).toBe(401);
		expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="MCP Server"');
	});

	test('accepts a valid session token', async () => {
		const response = await handleMcpRequest(mcpRequest(sessionToken));
		// Past auth — the MCP transport handles the body from here.
		expect(response.status).not.toBe(401);
	});

	test('accepts a valid PAT token', async () => {
		const response = await handleMcpRequest(mcpRequest(patToken));
		expect(response.status).not.toBe(401);
	});

	test('accepts the internal service token even when auth is required', async () => {
		// The non-Claude engines authenticate to the bridge with this loopback
		// token, not a user session. Without it the whole clopen-mcp bridge 401s.
		const response = await handleMcpRequest(mcpRequest(getMcpServiceToken()));
		expect(response.status).not.toBe(401);
	});

	test('does not mint a session for the service token', async () => {
		const before = sessionCount(testUserId);
		await handleMcpRequest(mcpRequest(getMcpServiceToken()));
		expect(sessionCount(testUserId)).toBe(before);
	});

	test('skips authentication in no-auth mode', async () => {
		setAuthMode('none');
		const response = await handleMcpRequest(mcpRequest());
		expect(response.status).not.toBe(401);
	});

	test('validates via pure lookup without minting a session', async () => {
		// Pins blocker #1: the validator must not behave like loginWithToken,
		// which inserts a fresh session row on every call.
		const before = sessionCount(testUserId);

		await handleMcpRequest(mcpRequest(sessionToken));
		await handleMcpRequest(mcpRequest(patToken));
		await handleMcpRequest(mcpRequest(sessionToken));

		expect(sessionCount(testUserId)).toBe(before);
	});
});
