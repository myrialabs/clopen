/**
 * `codex login` output is scraped from a PTY, so these pin the parsers to what
 * the pinned CLI (0.159.3) actually prints for each sign-in method.
 */

import { describe, expect, test } from 'bun:test';
import { extractAuthUrl, extractDeviceCode, isLoginSuccess } from './accounts';

const BROWSER_OUTPUT = `Starting local login server on http://localhost:1455.
If your browser did not open, navigate to this URL to authenticate:

https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&code_challenge=bL5H6vSHRqMufZdc1_eRnO1yvz7jym6dQFKGe11OmPg&code_challenge_method=S256&state=U83pc_Y3JBV1i6yqxiTawcFkdW1raWCRtt8zzI7l2zg&scope=openid+profile+email+offline_access&originator=codex_cli_rs

On a remote or headless machine? Use \`codex login --device-auth\` instead.
`;

const DEVICE_OUTPUT = `Welcome to Codex [v0.159.3]
OpenAI's command-line coding agent

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   6XUJ-L2VE1

Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.
`;

describe('codex login output', () => {
	test('browser login: the authorize URL, whole, without the trailing hint', () => {
		const url = extractAuthUrl(BROWSER_OUTPUT);
		expect(url).toStartWith('https://auth.openai.com/oauth/authorize?response_type=code');
		expect(url).toEndWith('originator=codex_cli_rs');
		expect(new URL(url!).searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback');
		expect(extractDeviceCode(BROWSER_OUTPUT)).toBeNull();
	});

	test('device login: the verification URL and one-time code', () => {
		expect(extractDeviceCode(DEVICE_OUTPUT)).toEqual({ code: '6XUJ-L2VE1', verificationUrl: 'https://auth.openai.com/codex/device' });
		expect(extractAuthUrl(DEVICE_OUTPUT)).toBeNull();
	});

	test('success line, shared by both methods', () => {
		expect(isLoginSuccess('Successfully logged in.')).toBe(true);
		expect(isLoginSuccess(BROWSER_OUTPUT)).toBe(false);
	});
});
