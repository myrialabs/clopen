/**
 * Claude Account Management Handlers
 *
 * CRUD operations use .http() (instant DB queries).
 * Setup-token flow uses .on() + .emit() (long-running PTY session).
 *
 * The PTY session is managed as a single unit with phase-based state:
 *   Phase 'waiting-url'   → onData extracts auth URL → emits setup-url
 *   Phase 'waiting-token'  → onData extracts OAuth token → saves & emits setup-complete
 *   Phase 'done'           → ignores further output
 *
 * Only ONE onData and ONE onExit listener per PTY. The submit handler
 * transitions the phase and writes to PTY without registering new listeners.
 */

import { t } from 'elysia';
import { spawn } from 'bun-pty';
import { createRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/lib/utils/ws';
import { engineQueries } from '../../../lib/database/queries';
import { resetEnvironment, getClaudeUserConfigDir } from '../../../lib/engine/adapters/claude/environment';
import { debug } from '$shared/utils/logger';

// ── Helpers ──

function stripAnsi(str: string): string {
	// Replace cursor positioning sequences (CSI row;colH/f) with newline
	// so line structure is preserved after stripping
	return str
		.replace(/\x1B\[\d+;\d+[Hf]/g, '\n')
		.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function extractAuthUrl(clean: string): string | null {
	const urlPrefix = 'https://claude.ai/oauth/authorize?';
	const urlStart = clean.indexOf(urlPrefix);
	if (urlStart === -1) return null;

	const pasteIdx = clean.indexOf('Paste', urlStart);
	if (pasteIdx === -1) return null;

	return clean.substring(urlStart, pasteIdx).replace(/\s/g, '');
}

function extractOAuthToken(clean: string): string | null {
	const tokenPrefix = 'sk-ant-oat01-';
	const tokenStart = clean.indexOf(tokenPrefix);
	if (tokenStart === -1) return null;

	const storeIdx = clean.indexOf('Store', tokenStart);
	if (storeIdx === -1) return null;

	return clean.substring(tokenStart, storeIdx).replace(/\s/g, '');
}

function extractPtyError(clean: string): string | null {
	// Known pattern: "OAuth error: <message>" — take just that line
	const oauthIdx = clean.indexOf('OAuth error:');
	if (oauthIdx !== -1) {
		const msgStart = oauthIdx + 'OAuth error:'.length;
		const lineEnd = clean.indexOf('\n', msgStart);
		const msg = (lineEnd === -1 ? clean.substring(msgStart) : clean.substring(msgStart, lineEnd)).trim();
		return msg || 'OAuth error';
	}

	// Generic: first line containing "error" (case-insensitive)
	const lines = clean.split('\n');
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith('https://') || trimmed.startsWith('sk-ant-')) continue;
		if (/\berror\b/i.test(trimmed)) {
			return trimmed;
		}
	}

	return null;
}

// ── Process Management ──

type SetupPhase = 'waiting-url' | 'waiting-token' | 'done';

interface SetupProcess {
	pty: ReturnType<typeof spawn>;
	buffer: string;
	timer: ReturnType<typeof setTimeout>;
	userId: string;
	disposed: boolean;
	phase: SetupPhase;
	accountName: string;
	urlEmitted: boolean;
}

const setupProcesses = new Map<string, SetupProcess>();
const userSetups = new Map<string, string>();

const SETUP_TIMEOUT_MS = 5 * 60 * 1000;

function cleanupSetup(setupId: string): void {
	const entry = setupProcesses.get(setupId);
	if (!entry || entry.disposed) return;

	entry.disposed = true;
	entry.phase = 'done';
	clearTimeout(entry.timer);
	try { entry.pty.kill(); } catch { /* already dead */ }
	userSetups.delete(entry.userId);
	setupProcesses.delete(setupId);
}

// ── Handlers ──

export const accountsHandler = createRouter()

	// ═══════════════════════════════════════
	// CRUD — instant DB operations (.http)
	// ═══════════════════════════════════════

	.http('engine:claude-accounts-list', {
		data: t.Object({}),
		response: t.Object({
			accounts: t.Array(t.Object({
				id: t.Number(),
				name: t.String(),
				isActive: t.Boolean(),
				createdAt: t.String()
			}))
		})
	}, async () => {
		const accounts = engineQueries.getClaudeAccounts();
		return {
			accounts: accounts.map(a => ({
				id: a.id,
				name: a.name,
				isActive: a.is_active === 1,
				createdAt: a.created_at
			}))
		};
	})

	.http('engine:claude-accounts-switch', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.switchClaudeAccount(data.id);
		resetEnvironment();
		return { success: true };
	})

	.http('engine:claude-accounts-delete', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		const active = engineQueries.getActiveClaudeAccount();
		engineQueries.deleteClaudeAccount(data.id);
		if (active?.id === data.id) resetEnvironment();
		return { success: true };
	})

	.http('engine:claude-accounts-rename', {
		data: t.Object({ id: t.Number(), name: t.String({ minLength: 1 }) }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.renameClaudeAccount(data.id, data.name);
		return { success: true };
	})

	// ═══════════════════════════════════════
	// Setup-token flow — event-driven (.on + .emit)
	// Single PTY session with phase-based state machine.
	// ═══════════════════════════════════════

	// Client → Server: start setup (spawns PTY, registers ONE onData + ONE onExit)
	.on('engine:claude-account-setup-start', {
		data: t.Object({})
	}, async ({ conn }) => {
		const userId = ws.getUserId(conn);
		const setupId = crypto.randomUUID();

		debug.log('engine', `[${setupId}] Starting claude setup-token PTY`);

		// Cancel any existing setup for this user
		const existingSetupId = userSetups.get(userId);
		if (existingSetupId) cleanupSetup(existingSetupId);

		// Build env
		const ptyEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined) ptyEnv[key] = value;
		}
		ptyEnv['CLAUDE_CONFIG_DIR'] = getClaudeUserConfigDir();
		ptyEnv['BROWSER'] = 'false';

		let pty: ReturnType<typeof spawn>;
		try {
			pty = spawn('claude', ['setup-token'], {
				name: 'xterm-256color',
				cols: 1000,
				rows: 30,
				cwd: process.cwd(),
				env: ptyEnv
			});
		} catch (err: any) {
			ws.emit.user(userId, 'engine:claude-account-setup-error', {
				setupId,
				message: 'Failed to start Claude CLI: ' + (err.message || 'Unknown error')
			});
			return;
		}

		// 5-minute timeout
		const timer = setTimeout(() => {
			debug.warn('engine', `[${setupId}] Setup-token timeout`);
			ws.emit.user(userId, 'engine:claude-account-setup-error', {
				setupId,
				message: 'Setup timed out after 5 minutes'
			});
			cleanupSetup(setupId);
		}, SETUP_TIMEOUT_MS);

		const entry: SetupProcess = {
			pty, buffer: '', timer, userId,
			disposed: false,
			phase: 'waiting-url',
			accountName: '',
			urlEmitted: false
		};
		setupProcesses.set(setupId, entry);
		userSetups.set(userId, setupId);

		// ── Single onData listener — handles ALL phases ──
		pty.onData((data: string) => {
			if (entry.disposed || entry.phase === 'done') return;
			entry.buffer += data;

			// Debug: stream raw PTY data to client
			ws.emit.user(userId, 'engine:claude-account-setup-pty-data', {
				setupId,
				data,
				phase: entry.phase,
				bufferLength: entry.buffer.length
			});

			const clean = stripAnsi(entry.buffer);

			if (entry.phase === 'waiting-url') {
				const url = extractAuthUrl(clean);
				if (url && !entry.urlEmitted) {
					entry.urlEmitted = true;
					debug.log('engine', `[${setupId}] Auth URL captured`);
					ws.emit.user(userId, 'engine:claude-account-setup-url', {
						setupId,
						authUrl: url
					});
				}
			} else if (entry.phase === 'waiting-token') {
				const token = extractOAuthToken(clean);
				if (token) {
					entry.phase = 'done';
					debug.log('engine', `[${setupId}] Token captured`);

					const account = engineQueries.createClaudeAccount(entry.accountName, token);
					resetEnvironment();

					ws.emit.user(userId, 'engine:claude-account-setup-complete', {
						setupId,
						accountId: account.id
					});

					cleanupSetup(setupId);
					return;
				}

				// Check for error messages in PTY output
				const error = extractPtyError(clean);
				if (error) {
					entry.phase = 'done';
					debug.warn('engine', `[${setupId}] PTY error detected: ${error}`);

					ws.emit.user(userId, 'engine:claude-account-setup-error', {
						setupId,
						message: error
					});

					cleanupSetup(setupId);
				}
			}
		});

		// ── Single onExit listener — handles ALL phases ──
		pty.onExit(() => {
			if (entry.disposed || entry.phase === 'done') return;
			debug.log('engine', `[${setupId}] PTY exited during phase: ${entry.phase}`);

			const clean = stripAnsi(entry.buffer);

			if (entry.phase === 'waiting-url') {
				ws.emit.user(userId, 'engine:claude-account-setup-error', {
					setupId,
					message: 'CLI exited before providing auth URL'
				});
			} else if (entry.phase === 'waiting-token') {
				// Last chance: check buffer for token before giving up
				const token = extractOAuthToken(clean);
				if (token) {
					debug.log('engine', `[${setupId}] Token found in final buffer`);
					const account = engineQueries.createClaudeAccount(entry.accountName, token);
					resetEnvironment();
					ws.emit.user(userId, 'engine:claude-account-setup-complete', {
						setupId,
						accountId: account.id
					});
				} else {
					// Try to extract a meaningful error message
					const error = extractPtyError(clean);
					ws.emit.user(userId, 'engine:claude-account-setup-error', {
						setupId,
						message: error || 'CLI exited without providing token'
					});
				}
			}

			cleanupSetup(setupId);
		});
	})

	// Client → Server: submit auth code (transitions phase + writes to existing PTY)
	.on('engine:claude-account-setup-submit', {
		data: t.Object({
			setupId: t.String(),
			code: t.String(),
			name: t.String({ minLength: 1 })
		})
	}, async ({ data, conn }) => {
		const userId = ws.getUserId(conn);
		const entry = setupProcesses.get(data.setupId);

		if (!entry || entry.disposed) {
			ws.emit.user(userId, 'engine:claude-account-setup-error', {
				setupId: data.setupId,
				message: 'Setup session not found or expired'
			});
			return;
		}

		debug.log('engine', `[${data.setupId}] Transitioning to waiting-token phase`);

		// Transition phase — the existing onData listener will now extract tokens
		entry.buffer = '';
		entry.phase = 'waiting-token';
		entry.accountName = data.name;

		// Write auth code to PTY, then press Enter after a short delay
		// The delay ensures the PTY input buffer has processed the code before receiving Enter
		entry.pty.write(data.code);
		setTimeout(() => {
			if (!entry.disposed) {
				entry.pty.write('\r');
			}
		}, 100);
	})

	// Client → Server: cancel setup
	.on('engine:claude-account-setup-cancel', {
		data: t.Object({
			setupId: t.String()
		})
	}, async ({ data }) => {
		if (setupProcesses.has(data.setupId)) {
			debug.log('engine', `[${data.setupId}] Setup cancelled by user`);
			cleanupSetup(data.setupId);
		}
	})

	// ═══════════════════════════════════════
	// Event declarations (Server → Client)
	// ═══════════════════════════════════════

	.emit('engine:claude-account-setup-url', t.Object({
		setupId: t.String(),
		authUrl: t.String()
	}))

	.emit('engine:claude-account-setup-complete', t.Object({
		setupId: t.String(),
		accountId: t.Number()
	}))

	.emit('engine:claude-account-setup-error', t.Object({
		setupId: t.String(),
		message: t.String()
	}))

	// Debug: raw PTY output stream
	.emit('engine:claude-account-setup-pty-data', t.Object({
		setupId: t.String(),
		data: t.String(),
		phase: t.String(),
		bufferLength: t.Number()
	}));
