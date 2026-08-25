import type { Elysia } from 'elysia';

/**
 * Security Headers Middleware
 *
 * Adds the response headers a browser needs to constrain what a Clopen page is
 * allowed to do. Each directive below is set to what the app actually uses —
 * see the notes on the loose ones, which are loose for a reason rather than by
 * oversight.
 */

/**
 * `@monaco-editor/loader` fetches the editor at runtime from jsDelivr; nothing
 * calls `loader.config()` to point it at a local copy, so the code editor, diff
 * viewer, conflict resolver and SQL console all load their scripts, stylesheet
 * and codicon font cross-origin. Monaco then boots its language workers from a
 * `blob:` that `importScripts()` the same host, which is why `blob:` appears in
 * `script-src` and `worker-src` too. Bundling Monaco locally would let every
 * one of these entries go.
 */
const MONACO_CDN = 'https://cdn.jsdelivr.net';

const CONTENT_SECURITY_POLICY = [
	"default-src 'self'",

	// No <base> tag and no cross-origin form target in the app, so these cost
	// nothing and close two common ways an injected tag redirects a page.
	"base-uri 'self'",
	"form-action 'self'",
	"object-src 'none'",

	// Clopen is never meant to be embedded. Paired with X-Frame-Options below
	// for browsers that predate frame-ancestors.
	"frame-ancestors 'none'",

	// 'unsafe-inline' and 'unsafe-eval' are what Monaco's AMD loader needs. They
	// blunt the XSS value of script-src considerably — the origin allowlist is
	// what this directive still buys us.
	`script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${MONACO_CDN}`,
	`style-src 'self' 'unsafe-inline' ${MONACO_CDN}`,
	`font-src 'self' data: ${MONACO_CDN}`,

	// Markdown renders whatever image URL the author wrote, including remote
	// ones from agent output and project READMEs. Narrowing this would silently
	// break those, so images stay open and the tighter directives above carry
	// the weight.
	"img-src 'self' data: blob: https: http:",

	// Media previews, notification sounds and the PDF viewer all read from
	// object URLs built in the browser.
	"media-src 'self' blob:",
	"frame-src 'self' blob:",
	"worker-src 'self' blob:",
	"child-src 'self' blob:",

	// The WebSocket is always same-origin (`frontend/utils/ws.ts` builds it from
	// window.location), which 'self' covers under CSP3.
	`connect-src 'self' blob: data: ${MONACO_CDN}`,

	"manifest-src 'self'"
].join('; ');

/**
 * Browser features are granted to the app itself, not to third parties. The
 * Preview Browser relays a page's device requests to the viewer's own browser
 * (`frontend/services/preview/browser/host-bridge.service.ts`), so camera,
 * microphone, geolocation, clipboard and screen capture have to stay
 * available; everything Clopen never touches is denied outright.
 */
const PERMISSIONS_POLICY = [
	'camera=(self)',
	'microphone=(self)',
	'geolocation=(self)',
	'display-capture=(self)',
	'clipboard-read=(self)',
	'clipboard-write=(self)',
	'fullscreen=(self)',
	'accelerometer=()',
	'ambient-light-sensor=()',
	'bluetooth=()',
	'gyroscope=()',
	'hid=()',
	'idle-detection=()',
	'local-fonts=()',
	'magnetometer=()',
	'midi=()',
	'payment=()',
	'serial=()',
	'usb=()',
	'xr-spatial-tracking=()'
].join(', ');

export const SECURITY_HEADERS: Record<string, string> = {
	'Content-Security-Policy': CONTENT_SECURITY_POLICY,

	// Every asset the static handler serves gets an explicit Content-Type from
	// Bun.file().type, so refusing to sniff can't strand one of them.
	'X-Content-Type-Options': 'nosniff',

	// frame-ancestors already covers this on current browsers; kept for older
	// ones that only understand the legacy header.
	'X-Frame-Options': 'DENY',

	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'Permissions-Policy': PERMISSIONS_POLICY
};

export function securityMiddleware(app: Elysia) {
	return app.onAfterHandle(({ set }) => {
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
			set.headers[name] = value;
		}
	});
}
