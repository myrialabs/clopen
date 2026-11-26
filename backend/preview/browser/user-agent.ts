/**
 * The User-Agent the preview's Chrome presents.
 *
 * Headless Chrome announces itself as `HeadlessChrome/<version>`, and bot
 * checks read exactly that: Cloudflare Turnstile and Google sign-in turn the
 * browser away on it alone. Everything else headless Chrome reports is the
 * real machine, so the fix is the one token, applied with `--user-agent` at
 * launch. The flag reaches every target — pages, cross-origin iframes (where
 * Turnstile runs), workers and request headers — which a per-page CDP
 * override does not.
 *
 * The string is Chrome's own, read from the binary, rather than a template:
 * the platform part differs per OS and the version moves with every update.
 */

import puppeteer, { type Browser } from 'puppeteer';
import { debug } from '$shared/utils/logger';

/** Chrome's own User-Agent with the headless marker taken out. */
export function toHeadfulUserAgent(userAgent: string): string {
	return userAgent.replace(/HeadlessChrome\//g, 'Chrome/');
}

/** One read per binary for the life of the server; an update means a new path or a restart. */
const cache = new Map<string, Promise<string | null>>();

/**
 * Ask a throwaway headless Chrome what it calls itself.
 *
 * Costs one short launch, the first time a preview opens. Resolves to null
 * when the binary cannot be started — the real launch will report why.
 */
export function resolveUserAgent(executablePath: string): Promise<string | null> {
	let pending = cache.get(executablePath);
	if (!pending) {
		pending = readUserAgent(executablePath);
		cache.set(executablePath, pending);
		// A failed read is not remembered, so the next launch tries again.
		void pending.then((value) => {
			if (value === null) cache.delete(executablePath);
		});
	}
	return pending;
}

/**
 * Long enough for a cold start on a slow host. Past it the preview launches
 * without the flag rather than waiting on a probe that will not answer.
 */
const READ_TIMEOUT_MS = 15_000;

async function readUserAgent(executablePath: string): Promise<string | null> {
	let probe: Browser | null = null;
	let timedOut = false;
	// A probe that stopped answering is killed rather than closed: close()
	// waits on the very connection that went quiet.
	const kill = (browser: Browser) => browser.process()?.kill('SIGKILL');

	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			if (probe) kill(probe);
			reject(new Error(`no answer within ${READ_TIMEOUT_MS}ms`));
		}, READ_TIMEOUT_MS);
	});

	const read = (async () => {
		// A WebSocket, not the pipe the preview's own Chrome uses. Under Bun,
		// closing one pipe-connected Chrome and launching the next in the same
		// process leaves the new one's connection dropping replies, so a probe
		// on a pipe would hang the very launch it exists to serve.
		const browser = await puppeteer.launch({
			headless: true,
			executablePath,
			args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check'],
			pipe: false,
			timeout: READ_TIMEOUT_MS
		});
		probe = browser;
		// Started only after the wait was given up on.
		if (timedOut) kill(browser);
		try {
			return toHeadfulUserAgent(await browser.userAgent());
		} finally {
			await browser.close().catch(() => {});
		}
	})();
	// After a timeout the read still settles, with nobody left to hear it.
	void read.catch(() => {});

	try {
		return await Promise.race([read, expired]);
	} catch (error) {
		debug.warn('preview', '⚠️ Could not read Chrome\'s User-Agent:', error instanceof Error ? error.message : error);
		return null;
	} finally {
		clearTimeout(timer);
	}
}
