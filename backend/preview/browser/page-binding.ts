/**
 * Page → server function calls, without Puppeteer's `exposeFunction`.
 *
 * `exposeFunction` installs its binding and a script wrapper in every frame of
 * the page, cross-origin iframes included. Cloudflare's challenge runs in one
 * of those iframes, sees them, and fails the check — on a challenge page the
 * user then ticks "Verify you are human" and lands back on the same page,
 * indefinitely. A binding added straight over CDP, on the page's own target,
 * reaches the main frame and its same-process iframes and nothing else, which
 * is all Clopen's in-page scripts need: cross-origin frames already relay
 * through the top frame.
 *
 * The page sees `window[name](...args)` returning a promise of the handler's
 * result, exactly as with `exposeFunction`.
 */

import type { CDPSession, Page, Protocol } from 'puppeteer';
import { debug } from '$shared/utils/logger';

type Handler = (...args: any[]) => unknown;

interface PageBindings {
	session: CDPSession;
	handlers: Map<string, Handler>;
}

const pages = new WeakMap<Page, Promise<PageBindings>>();

/**
 * Replaces Chrome's binding (which takes one string and returns nothing) with
 * a function that takes any JSON arguments and resolves with the reply. The
 * reply comes back through a non-enumerable property, so the page's own key
 * listing shows one function and nothing else.
 */
function installWrapper(name: string): void {
	const scope = globalThis as unknown as Record<string, unknown>;
	const send = scope[name] as ((payload: string) => void) | undefined;
	if (typeof send !== 'function' || (send as { __wrapped?: boolean }).__wrapped) return;

	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	let seq = 0;

	const call = function (...args: unknown[]): Promise<unknown> {
		seq += 1;
		const id = seq;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			send(JSON.stringify({ id, args }));
		});
	};
	Object.defineProperty(call, 'name', { value: name });
	Object.defineProperty(call, '__wrapped', { value: true });
	Object.defineProperty(call, '__reply', {
		value(id: number, ok: boolean, value: unknown) {
			const waiter = pending.get(id);
			if (!waiter) return;
			pending.delete(id);
			if (ok) waiter.resolve(value);
			else waiter.reject(new Error(String(value)));
		}
	});
	scope[name] = call;
}

async function bindingsFor(page: Page): Promise<PageBindings> {
	let entry = pages.get(page);
	if (!entry) {
		entry = (async () => {
			const session = await page.createCDPSession();
			const handlers = new Map<string, Handler>();
			session.on('Runtime.bindingCalled', (event: Protocol.Runtime.BindingCalledEvent) => {
				const handler = handlers.get(event.name);
				if (handler) void answer(session, handler, event);
			});
			// New-document scripts only run for a session with the Page domain on.
			await session.send('Page.enable');
			await session.send('Runtime.enable');
			return { session, handlers };
		})();
		pages.set(page, entry);
		// A failed setup is not remembered, so the next call tries again.
		entry.catch(() => pages.delete(page));
	}
	return entry;
}

async function answer(
	session: CDPSession,
	handler: Handler,
	event: Protocol.Runtime.BindingCalledEvent
): Promise<void> {
	let id: number;
	let args: unknown[];
	try {
		({ id, args } = JSON.parse(event.payload) as { id: number; args: unknown[] });
	} catch {
		return;
	}

	let ok = true;
	let value: unknown;
	try {
		value = await handler(...args);
	} catch (error) {
		ok = false;
		value = error instanceof Error ? error.message : String(error);
	}

	try {
		await session.send('Runtime.callFunctionOn', {
			functionDeclaration: `function (name, id, ok, value) {
				const fn = globalThis[name];
				if (fn && fn.__reply) fn.__reply(id, ok, value);
			}`,
			executionContextId: event.executionContextId,
			arguments: [{ value: event.name }, { value: id }, { value: ok }, { value: value ?? null }]
		});
	} catch {
		// The document that asked has gone — a navigation or a closed tab.
	}
}

/**
 * Make `window[name]` call `handler` on the server, in the page's current
 * document and every one after it. Calling it again for a name already bound
 * on this page swaps the handler.
 */
export async function exposeBinding(page: Page, name: string, handler: Handler): Promise<void> {
	const { session, handlers } = await bindingsFor(page);
	const known = handlers.has(name);
	handlers.set(name, handler);
	if (known) return;

	const wrapper = `(${installWrapper.toString()})(${JSON.stringify(name)});`;
	await session.send('Runtime.addBinding', { name });
	await session.send('Page.addScriptToEvaluateOnNewDocument', { source: wrapper });
	// The document already loaded never runs new-document scripts.
	await session.send('Runtime.evaluate', { expression: wrapper }).catch((error: unknown) => {
		debug.warn('preview', `⚠️ Binding ${name} not wrapped in the current document:`, error);
	});
}
