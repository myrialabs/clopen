import { describe, expect, test } from 'bun:test';
import { outsideBotChecks } from './bot-check-frames';

/** Run the generated source the way a frame would, and report whether the script ran. */
function runsIn(href: string, ancestors: string[] = []): boolean {
	const url = new URL(href);
	const location = {
		hostname: url.hostname,
		pathname: url.pathname,
		ancestorOrigins: ancestors
	};
	const source = outsideBotChecks(function (flag: string) {
		(globalThis as unknown as Record<string, boolean>)[flag] = true;
	}, '__botCheckProbe');
	const globals = globalThis as unknown as Record<string, boolean>;
	delete globals.__botCheckProbe;
	new Function('location', source)(location);
	const ran = globals.__botCheckProbe === true;
	delete globals.__botCheckProbe;
	return ran;
}

describe('outsideBotChecks', () => {
	test('runs in ordinary pages and embeds', () => {
		expect(runsIn('https://example.com/')).toBe(true);
		expect(runsIn('https://www.youtube.com/embed/x', ['https://example.com'])).toBe(true);
		expect(runsIn('https://www.google.com/maps/embed?pb=1', ['https://example.com'])).toBe(true);
	});

	test('skips a challenge widget frame', () => {
		expect(runsIn('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2')).toBe(false);
		expect(runsIn('https://newassets.hcaptcha.com/captcha/v1/static/hcaptcha.html')).toBe(false);
		expect(runsIn('https://www.google.com/recaptcha/api2/anchor?k=1')).toBe(false);
	});

	test('skips frames nested inside a challenge widget', () => {
		expect(runsIn('https://example.com/', ['https://challenges.cloudflare.com', 'https://example.com'])).toBe(false);
	});

	test('a path-scoped host does not make its whole origin a bot check', () => {
		// An ancestor only exposes its origin, and www.google.com serves far more than reCAPTCHA.
		expect(runsIn('https://example.com/', ['https://www.google.com'])).toBe(true);
	});

	test('passes the script its arguments', () => {
		const source = outsideBotChecks((a: number, b: { c: string }) => a + b.c.length, 1, { c: 'xy' });
		expect(source).toContain('(1, {"c":"xy"})');
	});
});
