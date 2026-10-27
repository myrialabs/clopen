/**
 * Pairing codes — how a chat proves it belongs to a Clopen user.
 *
 * The user asks Clopen for a link while signed in; the link opens a chat with
 * the bot carrying a one-time code; the bot receives `/start <code>` from the
 * chat and binds that chat to whoever asked. Holding the code is the proof, so
 * it is single-use and short-lived.
 *
 * In memory on purpose. A code lives for minutes and only means something to
 * the process that issued it; a restart in between costs the user one more
 * tap on "Link", which is cheaper than a table whose every row is garbage ten
 * minutes after it is written.
 */

import { randomBytes } from 'crypto';

export const PAIRING_TTL_MS = 10 * 60 * 1000;

interface PendingPairing {
	userId: string;
	accountId: string;
	expiresAt: number;
}

const pending = new Map<string, PendingPairing>();

function sweep(now: number): void {
	for (const [code, entry] of pending) {
		if (entry.expiresAt <= now) pending.delete(code);
	}
}

/**
 * Issue a code. Telegram's `start` parameter allows `A-Za-z0-9_-` up to 64
 * characters; 24 base64url characters is 144 bits.
 *
 * A user asking again replaces their previous code for the same bot, so only
 * the newest link they were shown works.
 */
export function issuePairingCode(userId: string, accountId: string): { code: string; expiresAt: string } {
	const now = Date.now();
	sweep(now);
	for (const [code, entry] of pending) {
		if (entry.userId === userId && entry.accountId === accountId) pending.delete(code);
	}
	const code = randomBytes(18).toString('base64url');
	const expiresAt = now + PAIRING_TTL_MS;
	pending.set(code, { userId, accountId, expiresAt });
	return { code, expiresAt: new Date(expiresAt).toISOString() };
}

/** Withdraw a user's open code for a bot: the link they were shown stops working. */
export function revokePairingCode(userId: string, accountId: string): void {
	for (const [code, entry] of pending) {
		if (entry.userId === userId && entry.accountId === accountId) pending.delete(code);
	}
}

/**
 * Redeem a code for the bot it was issued for. Consumed whether or not it
 * matches that bot — a code that reached the wrong bot has leaked.
 */
export function redeemPairingCode(code: string, accountId: string): { userId: string } | null {
	const entry = pending.get(code);
	if (!entry) return null;
	pending.delete(code);
	if (entry.expiresAt <= Date.now() || entry.accountId !== accountId) return null;
	return { userId: entry.userId };
}

/** Tests only. */
export function resetPairingCodes(): void {
	pending.clear();
}
