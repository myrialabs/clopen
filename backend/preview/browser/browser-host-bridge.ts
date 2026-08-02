/**
 * Browser Host Bridge
 *
 * Owns everything the headless browser cannot answer for itself and the
 * *viewer's* browser can: geolocation, camera/microphone, clipboard,
 * notifications, file pickers and downloads.
 *
 * Two directions meet here:
 * - **Page → viewer.** An injected shim (see `scripts/host-bridge.ts`) turns a
 *   `navigator.*` call into a request; this class parks it, emits it, and
 *   resolves the page's promise once the frontend answers.
 * - **Chrome → viewer.** File choosers and downloads are intercepted over CDP,
 *   which needs no injection because Chrome surfaces them as protocol events.
 *
 * Requests are keyed by an id rather than by tab so a slow decision on one tab
 * never blocks another, and every one carries a deadline — a page that asks for
 * a camera while nobody is watching the panel must eventually fail rather than
 * hang the renderer forever.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import type { CDPSession, Page } from 'puppeteer';
import { debug } from '$shared/utils/logger';
import { getClopenDir } from '$backend/utils/paths';

/** Capability requests the injected shim can raise. */
export type HostRequestKind =
	| 'geolocation'
	| 'media-request'
	| 'media-stop'
	| 'media-devices'
	| 'clipboard-read'
	| 'clipboard-write'
	| 'notification-permission'
	| 'notification-show'
	| 'speech-start'
	| 'speech-stop'
	| 'file-pick'
	// Not a capability and never shown to anyone: the page reporting that Chrome
	// resized the renderer behind the emulation's back, so the host can put the
	// viewport it captures from back the way it was. Answered by the service.
	| 'viewport-restore';

export interface HostRequestEvent {
	tabId: string;
	requestId: string;
	kind: HostRequestKind;
	payload: unknown;
	timestamp: number;
}

export interface HostDownloadEvent {
	tabId: string;
	downloadId: string;
	filename: string;
	url: string;
	/** base64 payload, present only once the download completed. */
	data?: string;
	state: 'started' | 'completed' | 'failed';
	totalBytes?: number;
	error?: string;
	timestamp: number;
}

export interface HostResponse {
	ok: boolean;
	result?: unknown;
	error?: { name?: string; message?: string; code?: number };
}

/** A file handed back by the viewer for an intercepted file chooser. */
export interface HostPickedFile {
	name: string;
	/** base64, without the data-URL prefix. */
	data: string;
}

interface PendingRequest {
	tabId: string;
	kind: HostRequestKind;
	resolve: (response: HostResponse) => void;
	timeout: NodeJS.Timeout;
}

interface TabBridge {
	bindingName: string;
	cdp?: CDPSession;
	transferDir: string;
}

/**
 * How long the page waits before a capability request gives up.
 *
 * Media gets longer than the rest: the viewer has to answer their own browser's
 * camera prompt, and a hurried timeout there reads as a broken feature.
 */
const REQUEST_TIMEOUT_MS: Record<HostRequestKind, number> = {
	'geolocation': 60_000,
	'media-request': 120_000,
	'media-stop': 5_000,
	'media-devices': 15_000,
	'clipboard-read': 30_000,
	'clipboard-write': 15_000,
	'notification-permission': 60_000,
	'notification-show': 15_000,
	// Only the handshake is timed; results stream back as events afterwards.
	'speech-start': 120_000,
	'speech-stop': 5_000,
	'file-pick': 300_000,
	// Nobody is asked anything — this is the host talking to itself, and the page
	// is blocked on it while a screencast restarts.
	'viewport-restore': 15_000
};

/**
 * Ceiling for a completed download relayed to the viewer over the WebSocket.
 * Above this the base64 round-trip costs more than the download is worth, so
 * the viewer is told to fetch it directly instead.
 */
const MAX_RELAYED_DOWNLOAD_BYTES = 32 * 1024 * 1024;

export class BrowserHostBridge extends EventEmitter {
	private tabs = new Map<string, TabBridge>();
	private pending = new Map<string, PendingRequest>();

	/** Downloads seen per tab, so progress events can find their metadata. */
	private downloads = new Map<string, { tabId: string; filename: string; url: string }>();

	/**
	 * Install the bridge for a tab. Must run before the first navigation so the
	 * shim is in place by the time page scripts execute.
	 */
	async setup(tabId: string, page: Page): Promise<void> {
		if (this.tabs.has(tabId)) return;

		// Randomised per tab: a fixed global name is a one-line detection rule
		// for the same bot-detection scripts these APIs tend to sit behind.
		const bindingName = `__h${randomUUID().replace(/-/g, '').slice(0, 16)}`;
		const transferDir = join(getClopenDir(), 'preview', 'transfer', tabId.replace(/[^\w.-]/g, '_'));

		this.tabs.set(tabId, { bindingName, transferDir });

		try {
			await page.exposeFunction(bindingName, (raw: string) => this.handlePageRequest(tabId, raw));

			const { hostBridgeScript } = await import('./scripts/host-bridge');
			await page.evaluateOnNewDocument(hostBridgeScript, bindingName);

			debug.log('preview', `🌉 Host bridge installed for tab ${tabId}`);
		} catch (error) {
			debug.warn('preview', `⚠️ Host bridge injection failed for tab ${tabId}:`, error);
		}

		await this.setupCdpInterception(tabId, page, transferDir);
	}

	/**
	 * File choosers and downloads come straight off the protocol, so they work
	 * even when script injection was rejected above.
	 */
	private async setupCdpInterception(tabId: string, page: Page, transferDir: string): Promise<void> {
		try {
			const cdp = await page.createCDPSession();
			const entry = this.tabs.get(tabId);
			if (entry) entry.cdp = cdp;

			// `Page.enable` is not optional here: without it the Page domain emits
			// nothing, so `Page.fileChooserOpened` never arrived and file inputs
			// appeared to be ignored entirely.
			await cdp.send('Page.enable');
			await cdp.send('DOM.enable').catch(() => {});
			await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });

			// Covers the main frame and every same-process iframe. A chooser raised
			// inside a cross-origin (out-of-process) iframe is dispatched on that
			// frame's own target, which Puppeteer does not surface as a Target —
			// those stay un-intercepted.
			cdp.on('Page.fileChooserOpened', (params: { mode: string; backendNodeId?: number }) => {
				void this.handleFileChooser(tabId, cdp, params);
			});

			await mkdir(transferDir, { recursive: true });
			await cdp.send('Browser.setDownloadBehavior', {
				behavior: 'allowAndName',
				downloadPath: transferDir,
				eventsEnabled: true
			});

			cdp.on('Browser.downloadWillBegin', (params: { guid: string; url: string; suggestedFilename: string }) => {
				this.downloads.set(params.guid, {
					tabId,
					filename: params.suggestedFilename || 'download',
					url: params.url
				});
				this.emit('download', {
					tabId,
					downloadId: params.guid,
					filename: params.suggestedFilename || 'download',
					url: params.url,
					state: 'started',
					timestamp: Date.now()
				} satisfies HostDownloadEvent);
			});

			cdp.on(
				'Browser.downloadProgress',
				(params: { guid: string; state: string; totalBytes?: number; receivedBytes?: number }) => {
					if (params.state === 'inProgress') return;
					void this.finalizeDownload(params.guid, params.state, transferDir, params.totalBytes);
				}
			);
		} catch (error) {
			debug.warn('preview', `⚠️ Host bridge CDP interception failed for tab ${tabId}:`, error);
		}
	}

	/**
	 * Park a request from the page and hand it to whoever is watching the panel.
	 * The returned promise is what the page's `await` is blocked on, so it always
	 * settles — a rejection here would surface as an unhandled error in the page.
	 */
	private handlePageRequest(tabId: string, raw: string): Promise<string> {
		let parsed: { kind: HostRequestKind; payload?: unknown };
		try {
			parsed = JSON.parse(raw);
		} catch {
			return Promise.resolve(
				JSON.stringify({ ok: false, error: { name: 'DataError', message: 'Malformed bridge request' } })
			);
		}

		return this.request(tabId, parsed.kind, parsed.payload).then((response) => JSON.stringify(response));
	}

	/**
	 * Emit a request and wait for the frontend's answer.
	 */
	request(tabId: string, kind: HostRequestKind, payload: unknown): Promise<HostResponse> {
		const requestId = randomUUID();

		return new Promise<HostResponse>((resolve) => {
			const timeout = setTimeout(() => {
				this.pending.delete(requestId);
				this.emit('request-settled', { tabId, requestId });
				resolve({
					ok: false,
					error: { name: 'NotAllowedError', message: 'No response from the preview host', code: 1 }
				});
			}, REQUEST_TIMEOUT_MS[kind] ?? 60_000);

			this.pending.set(requestId, { tabId, kind, resolve, timeout });

			this.emit('request', {
				tabId,
				requestId,
				kind,
				payload,
				timestamp: Date.now()
			} satisfies HostRequestEvent);
		});
	}

	/**
	 * Push an event down to the page.
	 *
	 * The request/response channel cannot carry a stream, and speech recognition
	 * is one — results keep arriving until the page stops listening. The top
	 * frame receives this and rebroadcasts to its children.
	 */
	async dispatchEvent(page: Page, tabId: string, kind: string, payload: unknown): Promise<void> {
		const entry = this.tabs.get(tabId);
		if (!entry) return;

		try {
			await page.evaluate(
				(hook: string, raw: string) => {
					const deliver = (window as unknown as Record<string, ((value: string) => void) | undefined>)[hook];
					if (typeof deliver === 'function') deliver(raw);
				},
				`${entry.bindingName}E`,
				JSON.stringify({ kind, payload })
			);
		} catch {
			// Page navigated away mid-stream; the session ends with it.
		}
	}

	/**
	 * Deliver the viewer's answer. Unknown ids are ignored — they belong to
	 * requests that already timed out or to a tab that has since closed.
	 */
	respond(requestId: string, response: HostResponse): boolean {
		const pending = this.pending.get(requestId);
		if (!pending) return false;

		clearTimeout(pending.timeout);
		this.pending.delete(requestId);
		// The page asked once, but the prompt was raised on every device watching
		// this tab. Whoever answered first answered for all of them, so the rest
		// are told to take their copy down.
		this.emit('request-settled', { tabId: pending.tabId, requestId });
		pending.resolve(response);
		return true;
	}

	// ── File chooser ────────────────────────────────────────────────────────

	/**
	 * Chrome cannot open a file picker in headless mode, so the viewer's browser
	 * opens a real one and the bytes are written to a scratch dir the renderer
	 * can read. Cancelling still has to answer the protocol, otherwise the input
	 * stays wedged open for the life of the page.
	 */
	private async handleFileChooser(
		tabId: string,
		cdp: CDPSession,
		params: { mode: string; backendNodeId?: number }
	): Promise<void> {
		const backendNodeId = params.backendNodeId;
		if (!backendNodeId) return;

		const entry = this.tabs.get(tabId);
		const transferDir = entry?.transferDir;
		let paths: string[] = [];

		try {
			const response = await this.request(tabId, 'file-pick', {
				multiple: params.mode === 'selectMultiple'
			});

			if (response.ok && transferDir) {
				const files = (response.result as { files?: HostPickedFile[] })?.files ?? [];
				paths = await this.writePickedFiles(transferDir, files);
			}
		} catch (error) {
			debug.warn('preview', `⚠️ File chooser relay failed for tab ${tabId}:`, error);
		}

		try {
			await cdp.send('DOM.setFileInputFiles', { files: paths, backendNodeId });
		} catch (error) {
			debug.warn('preview', `⚠️ Failed to hand files to the page for tab ${tabId}:`, error);
		}
	}

	private async writePickedFiles(transferDir: string, files: HostPickedFile[]): Promise<string[]> {
		if (files.length === 0) return [];

		const uploadDir = join(transferDir, 'upload', randomUUID());
		await mkdir(uploadDir, { recursive: true });

		const paths: string[] = [];
		for (const file of files) {
			// Names come from the viewer's filesystem — keep the basename only so
			// a crafted "../" cannot escape the scratch directory.
			const safeName = (file.name || 'file').split(/[\\/]/).pop() || 'file';
			const target = join(uploadDir, safeName);
			await writeFile(target, Buffer.from(file.data, 'base64'));
			paths.push(target);
		}
		return paths;
	}

	// ── Downloads ───────────────────────────────────────────────────────────

	/**
	 * Relay a finished download to the viewer, then drop the server-side copy —
	 * the file belongs on the machine the person is sitting at, not on the host.
	 */
	private async finalizeDownload(
		guid: string,
		state: string,
		transferDir: string,
		totalBytes?: number
	): Promise<void> {
		const meta = this.downloads.get(guid);
		this.downloads.delete(guid);
		if (!meta) return;

		const filePath = join(transferDir, guid);

		if (state !== 'completed') {
			await rm(filePath, { force: true }).catch(() => {});
			this.emit('download', {
				tabId: meta.tabId,
				downloadId: guid,
				filename: meta.filename,
				url: meta.url,
				state: 'failed',
				error: 'Download was cancelled',
				timestamp: Date.now()
			} satisfies HostDownloadEvent);
			return;
		}

		try {
			const bytes = await readFile(filePath);

			if (bytes.byteLength > MAX_RELAYED_DOWNLOAD_BYTES) {
				this.emit('download', {
					tabId: meta.tabId,
					downloadId: guid,
					filename: meta.filename,
					url: meta.url,
					state: 'failed',
					totalBytes: bytes.byteLength,
					error: `File is too large to transfer (${Math.round(bytes.byteLength / 1024 / 1024)}MB). Open the link in your own browser instead.`,
					timestamp: Date.now()
				} satisfies HostDownloadEvent);
				return;
			}

			this.emit('download', {
				tabId: meta.tabId,
				downloadId: guid,
				filename: meta.filename,
				url: meta.url,
				state: 'completed',
				totalBytes: totalBytes ?? bytes.byteLength,
				data: bytes.toString('base64'),
				timestamp: Date.now()
			} satisfies HostDownloadEvent);
		} catch (error) {
			this.emit('download', {
				tabId: meta.tabId,
				downloadId: guid,
				filename: meta.filename,
				url: meta.url,
				state: 'failed',
				error: error instanceof Error ? error.message : 'Failed to read the downloaded file',
				timestamp: Date.now()
			} satisfies HostDownloadEvent);
		} finally {
			await rm(filePath, { force: true }).catch(() => {});
		}
	}

	// ── Lifecycle ───────────────────────────────────────────────────────────

	/**
	 * Release a tab: settle anything it left pending so the renderer's promises
	 * do not dangle, then drop the scratch directory.
	 */
	async teardown(tabId: string): Promise<void> {
		for (const [requestId, pending] of this.pending) {
			if (pending.tabId !== tabId) continue;
			clearTimeout(pending.timeout);
			this.pending.delete(requestId);
			this.emit('request-settled', { tabId, requestId });
			pending.resolve({ ok: false, error: { name: 'AbortError', message: 'Tab closed' } });
		}

		const entry = this.tabs.get(tabId);
		this.tabs.delete(tabId);
		if (!entry) return;

		if (entry.cdp) {
			await entry.cdp.detach().catch(() => {});
		}
		await rm(entry.transferDir, { recursive: true, force: true }).catch(() => {});
	}

	async cleanup(): Promise<void> {
		const tabIds = Array.from(this.tabs.keys());
		await Promise.all(tabIds.map((tabId) => this.teardown(tabId)));
		this.downloads.clear();
	}
}
