import { EventEmitter } from 'events';
import type { Page, ConsoleMessage as PuppeteerConsoleMessage, HTTPResponse } from 'puppeteer';
import type { BrowserConsoleMessage, BrowserConsoleValue, BrowserTab } from './types';

import { debug } from '$shared/utils/logger';

/** Ring-buffer bounds for a tab's console history. */
const MAX_LOGS = 1000;
const TRIM_TO = 500;

/**
 * Flatten a page value into something renderable.
 *
 * Runs inside the page (serialized by `JSHandle.evaluate`), so it has to be
 * self-contained. Depth and breadth are capped because a single logged object
 * graph can otherwise be unbounded, and the panel only ever shows two levels
 * before the user expands further.
 */
function serializeConsoleValue(value: unknown, maxDepth = 2, maxEntries = 100): BrowserConsoleValue {
	const seen = new WeakSet<object>();

	function shortString(text: string, limit = 200): string {
		return text.length > limit ? `${text.slice(0, limit)}…` : text;
	}

	function walk(input: unknown, depth: number): BrowserConsoleValue {
		if (input === null) return { type: 'null', preview: 'null' };

		const raw = typeof input;

		if (raw === 'undefined') return { type: 'undefined', preview: 'undefined' };
		if (raw === 'string') return { type: 'string', preview: shortString(input as string, 1000) };
		if (raw === 'number') return { type: 'number', preview: String(input) };
		if (raw === 'boolean') return { type: 'boolean', preview: String(input) };
		if (raw === 'bigint') return { type: 'bigint', preview: `${String(input)}n` };
		if (raw === 'symbol') return { type: 'symbol', preview: String(input) };
		if (raw === 'function') {
			const fn = input as { name?: string };
			return { type: 'function', preview: `ƒ ${fn.name || '(anonymous)'}()` };
		}

		const obj = input as object;
		if (seen.has(obj)) return { type: 'object', preview: '[Circular]' };
		seen.add(obj);

		if (obj instanceof Error) {
			return { type: 'error', preview: obj.stack || `${obj.name}: ${obj.message}` };
		}
		if (typeof Node !== 'undefined' && obj instanceof Node) {
			const el = obj as Element;
			if (el.tagName) {
				const attrs = el.id ? `#${el.id}` : el.className ? `.${String(el.className).split(/\s+/)[0]}` : '';
				return { type: 'node', preview: `<${el.tagName.toLowerCase()}${attrs}>` };
			}
			return { type: 'node', preview: obj.nodeName };
		}
		if (obj instanceof Date) return { type: 'date', preview: obj.toISOString() };
		if (obj instanceof RegExp) return { type: 'regexp', preview: String(obj) };

		if (obj instanceof Map || obj instanceof Set) {
			const isMap = obj instanceof Map;
			const size = obj.size;
			const result: BrowserConsoleValue = {
				type: isMap ? 'map' : 'set',
				preview: `${isMap ? 'Map' : 'Set'}(${size})`
			};
			if (depth < maxDepth) {
				const entries: BrowserConsoleValue['entries'] = [];
				let index = 0;
				for (const item of obj as Iterable<unknown>) {
					if (index >= maxEntries) {
						result.truncated = true;
						break;
					}
					if (isMap) {
						const [key, val] = item as [unknown, unknown];
						entries.push({ key: String(key), value: walk(val, depth + 1) });
					} else {
						entries.push({ key: String(index), value: walk(item, depth + 1) });
					}
					index += 1;
				}
				result.entries = entries;
			}
			return result;
		}

		if (Array.isArray(obj)) {
			const result: BrowserConsoleValue = { type: 'array', preview: `Array(${obj.length})` };
			if (depth < maxDepth) {
				const limit = Math.min(obj.length, maxEntries);
				result.entries = [];
				for (let i = 0; i < limit; i += 1) {
					result.entries.push({ key: String(i), value: walk(obj[i], depth + 1) });
				}
				result.truncated = obj.length > limit;
			}
			return result;
		}

		const ctor = (obj as { constructor?: { name?: string } }).constructor?.name;
		const label = ctor && ctor !== 'Object' ? ctor : 'Object';
		const result: BrowserConsoleValue = { type: 'object', preview: label };

		if (depth < maxDepth) {
			let keys: string[] = [];
			try {
				keys = Object.keys(obj);
			} catch {
				keys = [];
			}
			const limit = Math.min(keys.length, maxEntries);
			result.entries = [];
			for (let i = 0; i < limit; i += 1) {
				const key = keys[i];
				try {
					result.entries.push({ key, value: walk((obj as Record<string, unknown>)[key], depth + 1) });
				} catch {
					result.entries.push({ key, value: { type: 'object', preview: '[unreadable]' } });
				}
			}
			result.truncated = keys.length > limit;
			if (keys.length > 0 && label === 'Object') {
				result.preview = `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}}`;
			}
		}

		return result;
	}

	return walk(value, 0);
}

/**
 * Collapse Chrome's console levels onto the four the panel filters by.
 *
 * Puppeteer reports every variant `console.*` can produce (`dir`, `table`,
 * `assert`, `count`, `verbose`, group markers…); left unmapped these fall
 * outside every filter and the message becomes invisible.
 */
function normalizeConsoleType(type: string): BrowserConsoleMessage['type'] {
	switch (type) {
		case 'error':
		case 'assert':
			return 'error';
		case 'warn':
			return 'warn';
		case 'info':
			return 'info';
		case 'debug':
		case 'verbose':
			return 'debug';
		case 'trace':
			return 'trace';
		case 'clear':
			return 'clear';
		default:
			return 'log';
	}
}

export class BrowserConsoleManager extends EventEmitter {
	constructor() {
		super();
	}

	/**
	 * Append a message to the tab's buffer, collapsing an identical repeat into
	 * a counter the way DevTools does — a page logging inside a rAF loop would
	 * otherwise flood the panel and evict everything useful.
	 */
	private record(session: BrowserTab, message: BrowserConsoleMessage): void {
		const previous = session.consoleLogs[session.consoleLogs.length - 1];

		if (
			previous &&
			previous.type === message.type &&
			previous.text === message.text &&
			previous.location?.url === message.location?.url &&
			previous.location?.lineNumber === message.location?.lineNumber
		) {
			previous.count = (previous.count ?? 1) + 1;
			previous.timestamp = message.timestamp;
			this.emit('console-message', { sessionId: session.id, message: previous });
			return;
		}

		session.consoleLogs.push(message);
		if (session.consoleLogs.length > MAX_LOGS) {
			session.consoleLogs = session.consoleLogs.slice(-TRIM_TO);
		}

		this.emit('console-message', { sessionId: session.id, message });
	}

	private static makeId(prefix: string): string {
		return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
	}

	async setupConsoleLogging(sessionId: string, page: Page, session: BrowserTab) {
		// Clear any existing console logs for this session
		session.consoleLogs = [];

		// Listen to ALL console events from the page
		page.on('console', async (consoleMessage: PuppeteerConsoleMessage) => {
			if (!session.consoleEnabled) {
				return;
			}

			try {
				const text = consoleMessage.text();
				const type = normalizeConsoleType(consoleMessage.type());

				// Get location information (Puppeteer uses location() method)
				const location = consoleMessage.location();
				const messageLocation = location
					? {
							url: location.url || '',
							lineNumber: location.lineNumber || 0,
							columnNumber: location.columnNumber || 0
						}
					: undefined;

				// Structured argument previews. Serializing in the page keeps DOM
				// nodes, class instances and circular graphs renderable — all of
				// which make `jsonValue()` throw and used to be dropped entirely.
				let values: BrowserConsoleValue[] = [];
				try {
					const args = consoleMessage.args();
					if (args.length > 0) {
						values = await Promise.all(
							args.map((arg) =>
								arg
									.evaluate(serializeConsoleValue as never)
									.catch(() => ({ type: 'object', preview: '[unserializable]' }) as BrowserConsoleValue)
							)
						);
					}
				} catch (error) {
					debug.warn('preview', 'Could not extract console message args:', error);
				}

				const stack = consoleMessage.stackTrace();

				this.record(session, {
					id: BrowserConsoleManager.makeId('console'),
					type,
					text,
					values,
					location: messageLocation,
					stackTrace:
						stack.length > 0
							? stack.map((frame) => `  at ${frame.url}:${frame.lineNumber}:${frame.columnNumber}`).join('\n')
							: undefined,
					timestamp: Date.now()
				});
			} catch (error) {
				debug.error('preview', '❌ Error processing console message:', error);
			}
		});

		// Listen to page errors (uncaught JavaScript errors)
		page.on('pageerror', (err) => {
			if (!session.consoleEnabled) {
				return;
			}

			try {
				const error = err as Error;
				this.record(session, {
					id: BrowserConsoleManager.makeId('error'),
					type: 'error',
					text: `Uncaught ${error.message || String(err)}`,
					stackTrace: error.stack,
					timestamp: Date.now()
				});
			} catch (err2) {
				debug.error('preview', '❌ Error processing page error:', err2);
			}
		});

		// Listen to response failures (network errors)
		page.on('response', (response: HTTPResponse) => {
			if (!session.consoleEnabled) return;
			if (response.ok() || response.status() < 400) return;

			try {
				this.record(session, {
					id: BrowserConsoleManager.makeId('network'),
					type: 'error',
					text: `${response.status()} ${response.statusText()} — ${response.url()}`,
					status: response.status(),
					location: {
						url: response.url(),
						lineNumber: 0,
						columnNumber: 0
					},
					timestamp: Date.now()
				});
			} catch (err) {
				debug.error('preview', '❌ Error processing network error:', err);
			}
		});

		// Requests that never got a response at all (DNS failure, refused
		// connection, blocked by an extension) never fire `response`, so they
		// would otherwise be invisible in the panel.
		page.on('requestfailed', (request) => {
			if (!session.consoleEnabled) return;

			try {
				const failure = request.failure();
				this.record(session, {
					id: BrowserConsoleManager.makeId('network'),
					type: 'error',
					text: `${failure?.errorText || 'Request failed'} — ${request.url()}`,
					location: { url: request.url(), lineNumber: 0, columnNumber: 0 },
					timestamp: Date.now()
				});
			} catch (err) {
				debug.error('preview', '❌ Error processing request failure:', err);
			}
		});
	}

	getConsoleLogs(session: BrowserTab): BrowserConsoleMessage[] {
		return session ? session.consoleLogs : [];
	}

	clearConsoleLogs(session: BrowserTab): boolean {
		if (!session) return false;

		session.consoleLogs = [];

		// Emit clear event
		this.emit('console-clear', {
			sessionId: session.id,
			timestamp: Date.now()
		});

		return true;
	}

	toggleConsoleLogging(session: BrowserTab, enabled: boolean): boolean {
		if (!session) return false;

		session.consoleEnabled = enabled;

		return true;
	}

	/**
	 * Evaluate a REPL entry in the page and record both the input and its result.
	 *
	 * Expressions and statements are both accepted: the expression form is tried
	 * first so `{a: 1}` reads as an object rather than a block, and the statement
	 * form catches everything the parser rejects (`let x = 1`, `for (…)`).
	 */
	async executeConsoleCommand(session: BrowserTab, command: string): Promise<BrowserConsoleValue> {
		if (!session) throw new Error('Session not found');

		this.record(session, {
			id: BrowserConsoleManager.makeId('input'),
			type: 'input',
			text: command,
			timestamp: Date.now()
		});

		try {
			const outcome = await session.page.evaluate(
				async (source: string, serializerSource: string) => {
					const serialize = new Function(`return (${serializerSource})`)() as (
						value: unknown
					) => BrowserConsoleValue;

					let value: unknown;
					try {
						value = await (0, eval)(`(${source})`);
					} catch (expressionError) {
						if (!(expressionError instanceof SyntaxError)) {
							return { failed: true, value: serialize(expressionError) };
						}
						try {
							value = await (0, eval)(source);
						} catch (statementError) {
							return { failed: true, value: serialize(statementError) };
						}
					}
					return { failed: false, value: serialize(value) };
				},
				command,
				serializeConsoleValue.toString()
			);

			this.record(session, {
				id: BrowserConsoleManager.makeId('result'),
				type: outcome.failed ? 'error' : 'result',
				text: outcome.value.preview,
				values: [outcome.value],
				timestamp: Date.now()
			});

			return outcome.value;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);

			this.record(session, {
				id: BrowserConsoleManager.makeId('result'),
				type: 'error',
				text: message,
				timestamp: Date.now()
			});

			throw error;
		}
	}
}
