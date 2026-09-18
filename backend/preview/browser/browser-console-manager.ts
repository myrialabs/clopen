import { EventEmitter } from 'events';
import type { JSHandle, Page, ConsoleMessage as PuppeteerConsoleMessage, HTTPResponse } from 'puppeteer';
import type { BrowserConsoleMessage, BrowserConsoleValue, BrowserTab } from './types';

import { debug } from '$shared/utils/logger';

/** Ring-buffer bounds for a tab's console history. */
const MAX_LOGS = 1000;
const TRIM_TO = 500;

/**
 * Per-tab ceiling on page-originated console traffic.
 *
 * Every message costs a structured payload to each viewer in the project, and
 * a dev build in a re-render loop can produce thousands a second. Past the
 * ceiling the messages are counted rather than carried, and the count is
 * reported — a panel that says "4,812 dropped" is honest, whereas one that
 * silently keeps up is the one that makes the whole workspace stutter.
 */
const RATE_WINDOW_MS = 1000;
const MAX_MESSAGES_PER_WINDOW = 60;

interface ConsoleBudget {
	windowStart: number;
	used: number;
	dropped: number;
}

/** What the manager needs to know about the world outside it. */
export interface ConsoleManagerDeps {
	/**
	 * Whether anyone is actually looking at this tab.
	 *
	 * Console capture used to be unconditional: every tab, watched or not,
	 * paid a CDP round-trip per logged argument and a broadcast per message,
	 * for a panel that in most cases was not even open. Unwatched tabs now
	 * keep a text-only history — enough to read back when the panel opens,
	 * with none of the per-message cost.
	 */
	isWatched(sessionId: string): boolean;
}

function shorten(text: string, limit = 200): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Read an argument's value straight off the CDP payload Chrome already sent.
 *
 * Primitives — which is what the overwhelming majority of logs are made of —
 * arrive complete with the console event, so evaluating in the page to learn
 * what `"hello"` is costs a round-trip for something already in hand. Returns
 * null for anything that genuinely needs the page to describe it.
 */
function valueFromRemoteObject(handle: JSHandle): BrowserConsoleValue | null {
	const remote = handle.remoteObject();

	switch (remote.type) {
		case 'string':
			return { type: 'string', preview: shorten(String(remote.value), 1000) };
		case 'number':
			return { type: 'number', preview: remote.unserializableValue ?? String(remote.value) };
		case 'boolean':
			return { type: 'boolean', preview: String(remote.value) };
		case 'undefined':
			return { type: 'undefined', preview: 'undefined' };
		case 'bigint':
			return { type: 'bigint', preview: remote.unserializableValue ?? `${String(remote.value)}n` };
		case 'symbol':
			return { type: 'symbol', preview: remote.description ?? 'Symbol()' };
		case 'function': {
			// `description` is the function's source; its signature is the part
			// before the body, which is what DevTools shows too.
			const signature = (remote.description ?? '').split('{')[0].trim().replace(/^function\s*/, '');
			return { type: 'function', preview: `ƒ ${shorten(signature || '()', 80)}` };
		}
		case 'object':
			if (remote.subtype === 'null') return { type: 'null', preview: 'null' };
			return null;
		default:
			return null;
	}
}

/** The shape of an object, without asking the page to walk it. */
function outlineFromRemoteObject(handle: JSHandle): BrowserConsoleValue {
	const remote = handle.remoteObject();
	const label = remote.className || remote.subtype || 'Object';
	return { type: 'object', preview: remote.description ? shorten(remote.description) : label };
}

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
	private deps: ConsoleManagerDeps;
	private budgets = new Map<string, ConsoleBudget>();

	constructor(deps: ConsoleManagerDeps) {
		super();
		this.deps = deps;
	}

	private isWatched(sessionId: string): boolean {
		try {
			return this.deps.isWatched(sessionId);
		} catch {
			return true;
		}
	}

	/**
	 * Whether this tab may spend another message this second.
	 *
	 * Rolling the window is also where a burst gets reported, so the drop is
	 * visible in the panel at the point it happened rather than inferred from
	 * a gap in the log.
	 */
	private admit(session: BrowserTab): boolean {
		const now = Date.now();
		let budget = this.budgets.get(session.id);

		if (!budget || now - budget.windowStart >= RATE_WINDOW_MS) {
			const dropped = budget?.dropped ?? 0;
			budget = { windowStart: now, used: 0, dropped: 0 };
			this.budgets.set(session.id, budget);

			if (dropped > 0) {
				budget.used += 1;
				this.record(session, {
					id: BrowserConsoleManager.makeId('console'),
					type: 'warn',
					text: `${dropped} more console message${dropped === 1 ? '' : 's'} dropped (rate limit)`,
					timestamp: now
				});
			}
		}

		if (budget.used >= MAX_MESSAGES_PER_WINDOW) {
			budget.dropped += 1;
			return false;
		}

		budget.used += 1;
		return true;
	}

	/**
	 * Turn a console call's arguments into renderable values.
	 *
	 * Primitives are read off the event itself. Objects need the page to walk
	 * them, which is a round-trip per argument — worth paying while someone is
	 * watching, and not worth paying at all for a tab in the background, which
	 * gets the outline Chrome already sent instead.
	 */
	private async collectValues(
		consoleMessage: PuppeteerConsoleMessage,
		watched: boolean
	): Promise<BrowserConsoleValue[]> {
		const args = consoleMessage.args();
		if (args.length === 0) return [];

		// Still one Promise.all: the arguments that do need the page are walked
		// concurrently, as they always were. What changed is how few of them
		// reach that path at all.
		return Promise.all(
			args.map((arg) => {
				const cheap = valueFromRemoteObject(arg);
				if (cheap) return cheap;
				if (!watched) return outlineFromRemoteObject(arg);

				return arg
					.evaluate(serializeConsoleValue as never)
					.catch(() => ({ type: 'object', preview: '[unserializable]' }) as BrowserConsoleValue);
			})
		);
	}

	/**
	 * Append a message to the tab's buffer, collapsing an identical repeat into
	 * a counter the way DevTools does — a page logging inside a rAF loop would
	 * otherwise flood the panel and evict everything useful.
	 */
	private record(session: BrowserTab, message: BrowserConsoleMessage, force = false): void {
		// The buffer is always kept — it is what the panel reads back when it
		// opens. Only the live broadcast is conditional: pushing a message to
		// every viewer in the project for a tab none of them is looking at is
		// work that ends in nothing being displayed.
		const publish = force || this.isWatched(session.id);
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
			if (publish) this.emit('console-message', { sessionId: session.id, message: previous });
			return;
		}

		session.consoleLogs.push(message);
		if (session.consoleLogs.length > MAX_LOGS) {
			session.consoleLogs = session.consoleLogs.slice(-TRIM_TO);
		}

		if (publish) this.emit('console-message', { sessionId: session.id, message });
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

			if (!this.admit(session)) return;

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
					values = await this.collectValues(consoleMessage, this.isWatched(session.id));
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

			if (!this.admit(session)) return;

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
			if (!this.admit(session)) return;

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
			if (!this.admit(session)) return;

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
		this.budgets.delete(session.id);

		// Emit clear event
		this.emit('console-clear', {
			sessionId: session.id,
			timestamp: Date.now()
		});

		return true;
	}

	/** Drop a closed tab's rate-limit bookkeeping. */
	forgetSession(sessionId: string): void {
		this.budgets.delete(sessionId);
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

		this.record(
			session,
			{
				id: BrowserConsoleManager.makeId('input'),
				type: 'input',
				text: command,
				timestamp: Date.now()
			},
			true
		);

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

			this.record(
				session,
				{
					id: BrowserConsoleManager.makeId('result'),
					type: outcome.failed ? 'error' : 'result',
					text: outcome.value.preview,
					values: [outcome.value],
					timestamp: Date.now()
				},
				true
			);

			return outcome.value;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);

			this.record(
				session,
				{
					id: BrowserConsoleManager.makeId('result'),
					type: 'error',
					text: message,
					timestamp: Date.now()
				},
				true
			);

			throw error;
		}
	}
}
