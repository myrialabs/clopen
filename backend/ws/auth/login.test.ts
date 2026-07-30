import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Behavior-based tests for audit logging in session-creation paths.
 * 
 * These tests verify that auditLogQueries.logEvent is called with the correct
 * parameters for each session-creation handler, rather than checking source code strings.
 */

// Mock data
const mockUser = {
	id: 'user-123',
	name: 'Test User',
	role: 'admin' as const,
	color: '#FF5733',
	avatar: 'avatar-url',
	createdAt: new Date().toISOString()
};

const mockSessionToken = 'session-token-abc123';
const mockPersonalAccessToken = 'pat-xyz789';
const mockExpiresAt = new Date(Date.now() + 86400000).toISOString();
const mockTokenHash = 'hash-abc123';
const mockIpAddress = '192.168.1.100';

// Track logEvent calls
let logEventCalls: any[] = [];
const mockLogEvent = mock((entry: any) => {
	logEventCalls.push(entry);
	return true;
});

// Mock auth-service functions
const mockCreateAdmin = mock((name: string) => ({
	user: mockUser,
	sessionToken: mockSessionToken,
	personalAccessToken: mockPersonalAccessToken,
	expiresAt: mockExpiresAt
}));

const mockCreateOrGetNoAuthAdmin = mock(() => ({
	user: mockUser,
	sessionToken: mockSessionToken,
	expiresAt: mockExpiresAt
}));

const mockCreateUserFromInvite = mock((inviteToken: string, name: string) => ({
	user: mockUser,
	sessionToken: mockSessionToken,
	personalAccessToken: mockPersonalAccessToken,
	expiresAt: mockExpiresAt
}));

const mockNeedsSetup = mock(() => true);
const mockGetAuthMode = mock(() => 'none');

// Mock settings
let mockSettings: any = { value: JSON.stringify({ authMode: 'required' }) };
const mockSettingsGet = mock((key: string) => mockSettings);
const mockSettingsSet = mock((key: string, value: string) => {
	mockSettings = { key, value, updated_at: new Date().toISOString() };
});

// Mock ws utilities
const mockRawSocket = { remoteAddress: mockIpAddress };
const mockConnection = { raw: mockRawSocket };
const mockSetAuth = mock(() => {});
const mockClearAuth = mock(() => {});
const mockGetRemoteAddress = mock((conn: any) => mockIpAddress);
const mockEmitGlobal = mock(() => {});

// Mock token utilities
const mockHashToken = mock((token: string) => mockTokenHash);

// Setup mocks
mock.module('$backend/database/queries', () => ({
	auditLogQueries: {
		logEvent: mockLogEvent
	},
	settingsQueries: {
		get: mockSettingsGet,
		set: mockSettingsSet
	}
}));

mock.module('$backend/auth/auth-service', () => ({
	createAdmin: mockCreateAdmin,
	createOrGetNoAuthAdmin: mockCreateOrGetNoAuthAdmin,
	createUserFromInvite: mockCreateUserFromInvite,
	needsSetup: mockNeedsSetup,
	getAuthMode: mockGetAuthMode,
	loginWithToken: mock(() => ({})),
	logout: mock(() => {}),
	logoutAllSessions: mock(() => 0),
	validateInviteToken: mock(() => ({ valid: true })),
	regeneratePAT: mock(() => 'new-pat'),
	updateUserName: mock(() => mockUser)
}));

mock.module('$backend/utils/ws', () => ({
	ws: {
		setAuth: mockSetAuth,
		clearAuth: mockClearAuth,
		getRemoteAddress: mockGetRemoteAddress,
		emit: {
			global: mockEmitGlobal
		}
	}
}));

mock.module('$backend/auth/tokens', () => ({
	hashToken: mockHashToken,
	getTokenType: mock(() => 'session')
}));

mock.module('$backend/auth/rate-limiter', () => ({
	authRateLimiter: {
		check: mock(() => null),
		recordSuccess: mock(() => {}),
		recordFailure: mock(() => {})
	}
}));

// Import the handler after mocks are set up
const { loginHandler } = await import('./login');

describe('Session creation audit logging', () => {
	beforeEach(() => {
		// Clear all mock call history
		logEventCalls = [];
		mockLogEvent.mockClear();
		mockCreateAdmin.mockClear();
		mockCreateOrGetNoAuthAdmin.mockClear();
		mockCreateUserFromInvite.mockClear();
		mockSetAuth.mockClear();
		mockGetRemoteAddress.mockClear();
		mockEmitGlobal.mockClear();
		mockHashToken.mockClear();
		
		// Reset settings
		mockSettings = { value: JSON.stringify({ authMode: 'required' }) };
	});

	test('logs auth:setup event with IP address', async () => {
		// Call the handler
		const handler = (loginHandler as any).httpRoutes.get('auth:setup');
		await handler.handler({
			data: { name: 'Admin User' },
			conn: mockConnection
		});

		// Verify createAdmin was called
		expect(mockCreateAdmin).toHaveBeenCalledWith('Admin User', expect.anything());

		// Verify logEvent was called with correct parameters
		expect(mockLogEvent).toHaveBeenCalledTimes(1);
		expect(logEventCalls[0]).toMatchObject({
			userId: mockUser.id,
			actorUserId: mockUser.id,
			eventType: 'auth:setup',
			ipAddress: mockIpAddress
		});
		expect(logEventCalls[0].eventDetails).toContain('Test User');

		// Verify setAuth was called
		expect(mockSetAuth).toHaveBeenCalled();
	});

	test('logs auth:setup-no-auth event with IP address', async () => {
		// Call the handler
		const handler = (loginHandler as any).httpRoutes.get('auth:setup-no-auth');
		await handler.handler({
			data: {},
			conn: mockConnection
		});

		// Verify createOrGetNoAuthAdmin was called
		expect(mockCreateOrGetNoAuthAdmin).toHaveBeenCalled();

		// Verify logEvent was called with correct parameters
		expect(mockLogEvent).toHaveBeenCalledTimes(1);
		expect(logEventCalls[0]).toMatchObject({
			userId: mockUser.id,
			actorUserId: mockUser.id,
			eventType: 'auth:setup-no-auth',
			ipAddress: mockIpAddress
		});

		// Verify setAuth was called
		expect(mockSetAuth).toHaveBeenCalled();
	});

	test('logs auth:auto-login-no-auth event with IP address', async () => {
		// Call the handler
		const handler = (loginHandler as any).httpRoutes.get('auth:auto-login-no-auth');
		await handler.handler({
			data: {},
			conn: mockConnection
		});

		// Verify createOrGetNoAuthAdmin was called
		expect(mockCreateOrGetNoAuthAdmin).toHaveBeenCalled();

		// Verify logEvent was called with correct parameters
		expect(mockLogEvent).toHaveBeenCalledTimes(1);
		expect(logEventCalls[0]).toMatchObject({
			userId: mockUser.id,
			actorUserId: mockUser.id,
			eventType: 'auth:auto-login-no-auth',
			ipAddress: mockIpAddress
		});

		// Verify setAuth was called
		expect(mockSetAuth).toHaveBeenCalled();
	});

	test('logs auth:accept-invite event with IP address', async () => {
		// Call the handler
		const handler = (loginHandler as any).httpRoutes.get('auth:accept-invite');
		await handler.handler({
			data: {
				inviteToken: 'invite-token-123',
				name: 'New User'
			},
			conn: mockConnection
		});

		// Verify createUserFromInvite was called
		expect(mockCreateUserFromInvite).toHaveBeenCalledWith('invite-token-123', 'New User', expect.anything());

		// Verify logEvent was called with correct parameters
		expect(mockLogEvent).toHaveBeenCalledTimes(1);
		expect(logEventCalls[0]).toMatchObject({
			userId: mockUser.id,
			actorUserId: mockUser.id,
			eventType: 'auth:accept-invite',
			ipAddress: mockIpAddress
		});

		// Verify emit.global was called for users-changed event
		expect(mockEmitGlobal).toHaveBeenCalledWith('auth:users-changed', {
			type: 'added',
			userId: mockUser.id
		});

		// Verify setAuth was called
		expect(mockSetAuth).toHaveBeenCalled();
	});

	test('auth flow ignores audit log failure result', async () => {
		// logEvent signals a failed write with a falsy return (it never throws —
		// the insert is wrapped internally). The handler must ignore that result.
		mockLogEvent.mockImplementation(() => false);

		// Call the auth:setup handler
		const handler = (loginHandler as any).httpRoutes.get('auth:setup');
		const result = await handler.handler({
			data: { name: 'Admin User' },
			conn: mockConnection
		});

		// Verify the handler completed successfully despite audit log failure
		expect(result).toBeDefined();
		expect(result.user).toEqual(mockUser);
		expect(result.sessionToken).toBe(mockSessionToken);
		expect(result.personalAccessToken).toBe(mockPersonalAccessToken);

		// Verify setAuth was still called (auth flow continued)
		expect(mockSetAuth).toHaveBeenCalled();
	});
});
