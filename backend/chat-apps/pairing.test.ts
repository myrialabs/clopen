import { describe, it, expect, beforeEach, setSystemTime, afterEach } from 'bun:test';
import { issuePairingCode, redeemPairingCode, revokePairingCode, resetPairingCodes, PAIRING_TTL_MS } from './pairing';

beforeEach(() => resetPairingCodes());
afterEach(() => setSystemTime());

describe('pairing codes', () => {
	it('fit a Telegram start parameter', () => {
		const { code } = issuePairingCode('user-1', 'acct-1');
		expect(code).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
	});

	it('work once, for the bot they were issued for', () => {
		const { code } = issuePairingCode('user-1', 'acct-1');
		expect(redeemPairingCode(code, 'acct-1')).toEqual({ userId: 'user-1' });
		expect(redeemPairingCode(code, 'acct-1')).toBeNull();
	});

	it('are burned when they reach the wrong bot', () => {
		const { code } = issuePairingCode('user-1', 'acct-1');
		expect(redeemPairingCode(code, 'acct-2')).toBeNull();
		expect(redeemPairingCode(code, 'acct-1')).toBeNull();
	});

	it('expire', () => {
		const { code } = issuePairingCode('user-1', 'acct-1');
		setSystemTime(new Date(Date.now() + PAIRING_TTL_MS + 1000));
		expect(redeemPairingCode(code, 'acct-1')).toBeNull();
	});

	it('asking again invalidates the previous link', () => {
		const first = issuePairingCode('user-1', 'acct-1');
		const second = issuePairingCode('user-1', 'acct-1');
		expect(redeemPairingCode(first.code, 'acct-1')).toBeNull();
		expect(redeemPairingCode(second.code, 'acct-1')).toEqual({ userId: 'user-1' });
	});

	it('a closed link stops working, and only that user’s link for that bot', () => {
		const mine = issuePairingCode('user-1', 'acct-1');
		const theirs = issuePairingCode('user-2', 'acct-1');
		revokePairingCode('user-1', 'acct-1');
		expect(redeemPairingCode(mine.code, 'acct-1')).toBeNull();
		expect(redeemPairingCode(theirs.code, 'acct-1')).toEqual({ userId: 'user-2' });
	});
});
