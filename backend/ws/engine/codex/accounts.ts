/**
 * OpenAI Codex Account Management Handlers
 *
 * Codex supports TWO auth modes (per backend/engine/README.md §9.13):
 *
 *   1. **API key** — paste-token flow, identical to Copilot's. The `apiKey`
 *      is wrapped as `{kind:"api_key", apiKey}` and stored in
 *      `engine_accounts.credential`. No filesystem mutation.
 *
 *   2. **ChatGPT browser OAuth** — spawn `codex login` inside a PTY (so the
 *      CLI thinks it's interactive and emits its banner + URL prompt),
 *      scrape stdout for the `https://auth.openai.com/...` URL, surface it
 *      to the UI. The CLI writes `~/.codex/auth.json` after the user
 *      finishes OAuth in the browser. We snapshot the file content into
 *      `engine_accounts.credential` as `{kind:"chatgpt", authJson:<file>}`.
 *
 *      Headless fallback: `codex login --device-auth` produces a device code
 *      printed to stdout that the user enters at openai.com/auth/device.
 *
 * Switching between accounts:
 *   - chatgpt → write the stored `authJson` blob back to `~/.codex/auth.json`
 *     (atomic replace) so the next `codex exec` subprocess picks it up.
 *   - api_key → no filesystem mutation; the engine adapter passes `apiKey` to
 *     `new Codex({ apiKey })`.
 *
 * Concurrency: a backend-wide mutex serializes ChatGPT login flows because
 * `codex login` writes to the shared `~/.codex/auth.json` — two concurrent
 * logins would clobber each other.
 *
 * Why a PTY (bun-pty) instead of Bun.spawn pipes?
 *   The Codex CLI suppresses its sign-in banner (URL / device-code prompt)
 *   when stdout is not a TTY — running it under a pipe yields zero output,
 *   leaving the UI stuck on "Waiting for browser sign-in…". A real PTY
 *   makes the CLI behave as if a human were watching, so the prompt text
 *   reaches us and we can scrape it.
 */

import { t } from 'elysia';
import { spawn } from 'bun-pty';
import { createRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import { engineQueries } from '../../../database/queries';
import { disposeAllProjectEnginesByType } from '../../../engine';
import {
	authModeOf,
	applyAccountAuth,
	readAuthJson,
	serializeCodexCredential,
	getCodexHomeDir,
} from '../../../engine/adapters/codex/credential';
import { resolveBinaryWithRefresh } from '../../../utils/cli';
import { getCleanSpawnEnv } from '../../../utils/env';
import { debug } from '$shared/utils/logger';
import { requireSetupSessionAccess } from '../access';

// ─────────────────────────────────────────────────────────────────────────────
// ANSI helpers — Codex emits coloured output and cursor moves; we strip them
// before pattern-matching but stream the raw bytes (with ANSI) to the UI's
// xterm.js so the user sees the CLI exactly as it would render in a real
// terminal.
// ─────────────────────────────────────────────────────────────────────────────

function stripAnsi(str: string): string {
	return str
		.replace(/\x1B\[\d+;\d+[Hf]/g, '\n')
		.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine cleanup helper — called after any account mutation that might affect
// the active account so the next stream re-reads the credential from DB.
// ─────────────────────────────────────────────────────────────────────────────

async function disposeCodexEngines(): Promise<void> {
	try {
		await disposeAllProjectEnginesByType('codex');
	} catch {
		/* engine may not be initialised — ignore */
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// ChatGPT login PTY management
// ─────────────────────────────────────────────────────────────────────────────

interface CodexLoginProcess {
	pty: ReturnType<typeof spawn>;
	buffer: string;
	urlEmitted: boolean;
	completed: boolean;
	cancelled: boolean;
	disposed: boolean;
	userId: string;
	accountName: string;
	deviceAuth: boolean;
	timer: ReturnType<typeof setTimeout>;
}

const setupProcesses = new Map<string, CodexLoginProcess>();
const userSetups = new Map<string, string>();

const SETUP_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — matches device-code expiry window

/**
 * Backend-wide mutex protecting `codex login` so two simultaneous calls don't
 * clobber `~/.codex/auth.json`. Implemented as a chained Promise — every new
 * login waits for the previous one to settle before spawning.
 */
let codexLoginChain: Promise<void> = Promise.resolve();
function serializeCodexLogin<T>(work: () => Promise<T>): Promise<T> {
	const next = codexLoginChain.then(() => work());
	codexLoginChain = next.then(() => undefined, () => undefined);
	return next;
}

function cleanupSetup(setupId: string): void {
	const entry = setupProcesses.get(setupId);
	if (!entry || entry.disposed) return;
	entry.disposed = true;
	clearTimeout(entry.timer);
	if (!entry.completed) {
		try { entry.pty.kill(); } catch { /* already dead */ }
	}
	userSetups.delete(entry.userId);
	setupProcesses.delete(setupId);
}

function extractAuthUrl(buffer: string): string | null {
	// Browser-OAuth flow URL printed by `codex login` (no --device-auth).
	const match = buffer.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s]+/);
	return match ? match[0] : null;
}

function extractDeviceCode(buffer: string): { code: string; verificationUrl: string } | null {
	// `codex login --device-auth` (v0.120+) prints a multi-line block:
	//   1. Open this link in your browser and sign in to your account
	//      https://auth.openai.com/codex/device
	//
	//   2. Enter this one-time code (expires in 15 minutes)
	//      6XUJ-L2VE1
	//
	// The code lives on its own line, indented. The URL is any
	// auth.openai.com path containing "device".
	const urlMatch = buffer.match(/https:\/\/[^\s]*openai\.com\/[^\s]*device[^\s]*/i);
	if (!urlMatch) return null;

	// Codes seen so far are 4–5 alphanum chars, dash, 4–5 alphanum chars
	// (e.g. "6XUJ-L2VE1"). Match on its own line so we don't pick up
	// stray dashes from the banner.
	const codeMatch = buffer.match(/(?:^|\n)\s*([A-Z0-9]{3,8}-[A-Z0-9]{3,8})\s*(?:\r?\n|$)/);
	if (!codeMatch) return null;

	return { code: codeMatch[1], verificationUrl: urlMatch[0] };
}

function isLoginSuccess(buffer: string): boolean {
	return /Successfully logged in/i.test(buffer);
}

function persistChatGptLoginResult(accountName: string): { ok: true; accountId: number } | { ok: false; error: string } {
	const provider = engineQueries.getProviderBySlug('codex', 'openai');
	if (!provider) return { ok: false, error: 'OpenAI Codex provider not found in DB' };

	const authJson = readAuthJson();
	if (authJson === null) {
		return { ok: false, error: 'Codex CLI reported success but ~/.codex/auth.json was not found' };
	}

	const credential = serializeCodexCredential({ kind: 'chatgpt', authJson });
	const account = engineQueries.createAccount(provider.id, accountName, credential);
	return { ok: true, accountId: account.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export const codexAccountsHandler = createRouter()

	.http('engine:codex-accounts-list', {
		data: t.Object({}),
		response: t.Object({
			accounts: t.Array(t.Object({
				id: t.Number(),
				name: t.String(),
				isActive: t.Boolean(),
				authMode: t.Union([t.Literal('api_key'), t.Literal('chatgpt'), t.Null()]),
				createdAt: t.String()
			}))
		})
	}, async () => {
		const provider = engineQueries.getProviderBySlug('codex', 'openai');
		if (!provider) return { accounts: [] };
		const accounts = engineQueries.getAccountsByProvider(provider.id);
		return {
			accounts: accounts.map(a => ({
				id: a.id,
				name: a.name,
				isActive: a.is_active === 1,
				authMode: authModeOf(a),
				createdAt: a.created_at
			}))
		};
	})

	// ─── API-key flow (paste-token) ───
	.http('engine:codex-accounts-add-api-key', {
		data: t.Object({
			name: t.String({ minLength: 1 }),
			apiKey: t.String({ minLength: 1 })
		}),
		response: t.Object({
			account: t.Object({
				id: t.Number(),
				name: t.String(),
				isActive: t.Boolean(),
				authMode: t.Union([t.Literal('api_key'), t.Literal('chatgpt'), t.Null()]),
				createdAt: t.String()
			})
		})
	}, async ({ data }) => {
		const provider = engineQueries.getProviderBySlug('codex', 'openai');
		if (!provider) {
			throw new Error('OpenAI Codex provider not found in database');
		}

		const credential = serializeCodexCredential({ kind: 'api_key', apiKey: data.apiKey.trim() });
		const account = engineQueries.createAccount(provider.id, data.name.trim(), credential);

		if (account.is_active === 1) {
			await disposeCodexEngines();
		}

		return {
			account: {
				id: account.id,
				name: account.name,
				isActive: account.is_active === 1,
				authMode: authModeOf(account),
				createdAt: account.created_at
			}
		};
	})

	.http('engine:codex-accounts-switch', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		const account = engineQueries.getAccount(data.id);
		if (!account) throw new Error('Account not found');

		engineQueries.switchAccount(data.id);

		// For ChatGPT-mode accounts, swap `~/.codex/auth.json` immediately so
		// the next `codex exec` (which may run before the engine's
		// stream-start hook fires) reads the right credential.
		applyAccountAuth(account);

		await disposeCodexEngines();
		return { success: true };
	})

	.http('engine:codex-accounts-delete', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		const active = engineQueries.getActiveAccountForEngine('codex');
		engineQueries.deleteAccount(data.id);

		if (active?.id === data.id) {
			// The new active account (auto-promoted by deleteAccount) needs its
			// auth applied so the next stream uses the correct credential.
			const newActive = engineQueries.getActiveAccountForEngine('codex');
			if (newActive) applyAccountAuth(newActive);
			await disposeCodexEngines();
		}
		return { success: true };
	})

	.http('engine:codex-accounts-rename', {
		data: t.Object({ id: t.Number(), name: t.String({ minLength: 1 }) }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.renameAccount(data.id, data.name.trim());
		return { success: true };
	})

	// ─── ChatGPT browser OAuth flow ───
	//
	// Spawn `codex login` in a PTY (the CLI silently no-ops when stdout
	// isn't a TTY), scan stdout for the URL/device-code prompt, surface it
	// to the UI, then on success snapshot ~/.codex/auth.json into
	// engine_accounts.credential.
	.on('engine:codex-account-setup-start', {
		data: t.Object({
			name: t.String({ minLength: 1 }),
			deviceAuth: t.Optional(t.Boolean())
		})
	}, async ({ data, conn }) => {
		const userId = ws.getUserId(conn);
		const setupId = crypto.randomUUID();

		debug.log('engine', `[${setupId}] Starting codex login PTY (deviceAuth=${!!data.deviceAuth})`);

		// Cancel any existing setup for this user — only one login at a time.
		const existing = userSetups.get(userId);
		if (existing) cleanupSetup(existing);

		const codexCmd = await resolveBinaryWithRefresh('codex');
		if (!codexCmd) {
			ws.emit.user(userId, 'engine:codex-account-setup-error', {
				setupId,
				message: 'Codex CLI not found on PATH. Install it via Settings → System Tools.'
			});
			return;
		}

		// Serialize across all in-flight Codex logins so we don't clobber
		// ~/.codex/auth.json. Each setup waits for the previous to settle.
		await serializeCodexLogin(async () => {
			const args = data.deviceAuth ? ['login', '--device-auth'] : ['login'];

			// Clean env + force a non-interactive browser fallback so the CLI
			// prints the URL instead of trying to open a browser on the
			// server. (`BROWSER=false` is honoured by most OS open helpers.)
			const ptyEnv = getCleanSpawnEnv();
			ptyEnv['BROWSER'] = 'false';
			// Write auth.json into Clopen's isolated Codex home, not ~/.codex.
			ptyEnv['CODEX_HOME'] = getCodexHomeDir();

			let pty: ReturnType<typeof spawn>;
			try {
				pty = spawn(codexCmd, args, {
					name: 'xterm-256color',
					cols: 1000,
					rows: 30,
					cwd: process.cwd(),
					env: ptyEnv,
				});
			} catch (err) {
				ws.emit.user(userId, 'engine:codex-account-setup-error', {
					setupId,
					message: `Failed to start codex login: ${err instanceof Error ? err.message : String(err)}`
				});
				return;
			}

			const timer = setTimeout(() => {
				ws.emit.user(userId, 'engine:codex-account-setup-error', {
					setupId,
					message: 'Codex login timed out after 15 minutes'
				});
				cleanupSetup(setupId);
			}, SETUP_TIMEOUT_MS);

			const entry: CodexLoginProcess = {
				pty,
				buffer: '',
				urlEmitted: false,
				completed: false,
				cancelled: false,
				disposed: false,
				userId,
				accountName: data.name.trim(),
				deviceAuth: !!data.deviceAuth,
				timer,
			};
			setupProcesses.set(setupId, entry);
			userSetups.set(userId, setupId);

			// ── Single onData listener — matches the Claude Code pattern ──
			pty.onData((chunk: string) => {
				if (entry.disposed || entry.completed) return;
				entry.buffer += chunk;

				// Stream raw PTY bytes to the UI's xterm.js (handles ANSI).
				ws.emit.user(userId, 'engine:codex-account-setup-stream-data', {
					setupId,
					data: chunk,
				});

				const clean = stripAnsi(entry.buffer);

				if (!entry.deviceAuth && !entry.urlEmitted) {
					const url = extractAuthUrl(clean);
					if (url) {
						entry.urlEmitted = true;
						debug.log('engine', `[${setupId}] Auth URL captured`);
						ws.emit.user(userId, 'engine:codex-account-setup-url', {
							setupId,
							authUrl: url,
						});
					}
				}

				if (entry.deviceAuth && !entry.urlEmitted) {
					const device = extractDeviceCode(clean);
					if (device) {
						entry.urlEmitted = true;
						debug.log('engine', `[${setupId}] Device code captured: ${device.code}`);
						ws.emit.user(userId, 'engine:codex-account-setup-device-code', {
							setupId,
							code: device.code,
							verificationUrl: device.verificationUrl,
						});
					}
				}

				if (isLoginSuccess(clean) && !entry.completed) {
					entry.completed = true;
					debug.log('engine', `[${setupId}] Codex login success — persisting auth.json`);
					const result = persistChatGptLoginResult(entry.accountName);
					if (result.ok) {
						disposeCodexEngines().finally(() => {
							ws.emit.user(userId, 'engine:codex-account-setup-complete', {
								setupId,
								accountId: result.accountId,
							});
						});
					} else {
						ws.emit.user(userId, 'engine:codex-account-setup-error', {
							setupId,
							message: result.error,
						});
					}
					try { entry.pty.kill(); } catch { /* ignore */ }
					cleanupSetup(setupId);
				}
			});

			pty.onExit(({ exitCode }) => {
				if (entry.disposed || entry.cancelled) return;
				if (entry.completed) return;

				const clean = stripAnsi(entry.buffer);

				// Last-chance success check — sometimes the success line lands
				// in the final chunk right before exit.
				if (isLoginSuccess(clean)) {
					entry.completed = true;
					const result = persistChatGptLoginResult(entry.accountName);
					if (result.ok) {
						disposeCodexEngines().finally(() => {
							ws.emit.user(userId, 'engine:codex-account-setup-complete', {
								setupId,
								accountId: result.accountId,
							});
						});
					} else {
						ws.emit.user(userId, 'engine:codex-account-setup-error', {
							setupId,
							message: result.error,
						});
					}
				} else {
					ws.emit.user(userId, 'engine:codex-account-setup-error', {
						setupId,
						message: exitCode === 0
							? 'Codex login exited without confirming success'
							: `Codex login exited with code ${exitCode}`,
					});
				}
				cleanupSetup(setupId);
			});
		});
	})

	.on('engine:codex-account-setup-cancel', {
		data: t.Object({ setupId: t.String() })
	}, async ({ data, conn }) => {
		let entry: CodexLoginProcess;
		try {
			entry = requireSetupSessionAccess(conn, data.setupId, setupProcesses);
		} catch {
			return;
		}
		entry.cancelled = true;
		cleanupSetup(data.setupId);
	})

	// Restart all Codex engine instances. Use after changing the active
	// account so subsequent models:list / chat calls re-initialise with the
	// right credential. (The auth-blob swap on accounts-switch already
	// handles the on-disk file; this just drops cached engine instances.)
	.http('engine:codex-restart', {
		data: t.Object({}),
		response: t.Object({ success: t.Boolean() })
	}, async () => {
		await disposeCodexEngines();
		return { success: true };
	})

	// ─── Server → client events ───

	.emit('engine:codex-account-setup-url', t.Object({
		setupId: t.String(),
		authUrl: t.String()
	}))

	.emit('engine:codex-account-setup-device-code', t.Object({
		setupId: t.String(),
		code: t.String(),
		verificationUrl: t.String()
	}))

	.emit('engine:codex-account-setup-complete', t.Object({
		setupId: t.String(),
		accountId: t.Number()
	}))

	.emit('engine:codex-account-setup-error', t.Object({
		setupId: t.String(),
		message: t.String()
	}))

	.emit('engine:codex-account-setup-stream-data', t.Object({
		setupId: t.String(),
		data: t.String()
	}));
