/**
 * Preview Host Bridge (viewer side)
 *
 * Answers the capability requests the headless browser cannot satisfy itself.
 * Every handler here runs a real Web API on the viewer's device, so the page
 * being previewed sees the same thing it would see if the user had opened it in
 * their own browser: their location, their camera, their clipboard.
 *
 * Requests split into two groups:
 * - **Silent.** Device enumeration, clipboard writes and notification delivery
 *   carry no privacy decision the user has not already made, so they are
 *   answered immediately.
 * - **Prompted.** Location, camera, microphone, clipboard reads, notification
 *   permission and file selection surface a prompt first. The prompt is not
 *   decoration: Safari only grants `getUserMedia` and `clipboard.read` to a
 *   user gesture, so the API call has to originate from the click on Allow.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import type {
	BrowserDownloadEvent,
	BrowserHostRequestEvent,
	HostRequestKind,
	PendingPermission
} from '$frontend/utils/native-ui';

export interface HostBridgeCallbacks {
	/** Show a prompt and resolve once the user decides. */
	onPermissionRequest: (request: PendingPermission) => void;
	/** Ask the viewer to pick files for an intercepted file input. */
	onFilePickRequest: (request: PendingPermission) => void;
	/**
	 * A pending request no longer needs an answer — another viewer gave one, it
	 * timed out, or its tab closed.
	 */
	onRequestSettled?: (request: { tabId: string; requestId: string }) => void;
	/** Surface a relayed download so the user can see it land. */
	onDownload?: (event: BrowserDownloadEvent) => void;
	/** Resolve the origin shown in the prompt, so it reads like a real one. */
	getTabOrigin: (tabId: string) => string;
}

/** Kinds that must wait for an explicit decision before touching a device API. */
const PROMPTED: ReadonlySet<HostRequestKind> = new Set([
	'geolocation',
	'media-request',
	'clipboard-read',
	'notification-permission',
	// Recognition opens the microphone on the viewer's device, and Chrome only
	// starts it from a user gesture — the Allow click supplies both.
	'speech-start'
]);

/** Ceiling on a single file handed to a page, matching the download relay. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export class PreviewHostBridge {
	private callbacks: HostBridgeCallbacks | null = null;

	/** Live camera/mic relays, keyed by the session id the page holds. */
	private mediaSessions = new Map<string, { pc: RTCPeerConnection; stream: MediaStream }>();

	/** Live speech-recognition runs, keyed by the page's session id. */
	private speechSessions = new Map<string, any>();

	private unsubscribers: Array<() => void> = [];

	// Public STUN so the relay still connects when the viewer and the server are
	// on different networks — mirrors the preview stream's own configuration.
	private readonly iceServers: RTCIceServer[] = [
		{ urls: 'stun:stun.l.google.com:19302' },
		{ urls: 'stun:stun1.l.google.com:19302' }
	];

	start(callbacks: HostBridgeCallbacks): () => void {
		this.callbacks = callbacks;

		this.unsubscribers = [
			// `kind` widens to `string` across the wire schema; the union it must
			// belong to is enforced by the backend that emits it.
			ws.on('preview:browser-host-request', (event) => {
				void this.handleRequest(event as BrowserHostRequestEvent);
			}),
			ws.on('preview:browser-download', (event: BrowserDownloadEvent) => {
				this.handleDownload(event);
			}),
			// The page asks once, but every viewer of the tab is prompted. Only the
			// first answer reaches the page, so the rest have to be told to stop
			// asking rather than being left holding a decision that no longer
			// matters.
			ws.on('preview:browser-host-request-settled', (event) => {
				this.callbacks?.onRequestSettled?.(event);
			})
		];

		return () => this.stop();
	}

	stop(): void {
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.unsubscribers = [];

		for (const session of this.mediaSessions.values()) {
			this.closeMediaSession(session);
		}
		this.mediaSessions.clear();

		for (const sessionId of Array.from(this.speechSessions.keys())) {
			this.stopSpeechSession(sessionId, true);
		}
		this.speechSessions.clear();

		this.callbacks = null;
	}

	// ── Request routing ─────────────────────────────────────────────────────

	private async handleRequest(event: BrowserHostRequestEvent): Promise<void> {
		if (PROMPTED.has(event.kind) || event.kind === 'file-pick') {
			const pending: PendingPermission = {
				requestId: event.requestId,
				tabId: event.tabId,
				kind: event.kind,
				payload: event.payload,
				origin: this.callbacks?.getTabOrigin(event.tabId) ?? 'This page'
			};

			if (event.kind === 'file-pick') {
				this.callbacks?.onFilePickRequest(pending);
			} else {
				this.callbacks?.onPermissionRequest(pending);
			}
			return;
		}

		try {
			const result = await this.runSilent(event);
			this.respond(event.requestId, { ok: true, result });
		} catch (error) {
			this.respond(event.requestId, { ok: false, error: this.toWireError(error) });
		}
	}

	/** Requests that carry no decision for the user to make. */
	private async runSilent(event: BrowserHostRequestEvent): Promise<unknown> {
		switch (event.kind) {
			case 'speech-stop':
				this.stopSpeechSession(String(event.payload?.sessionId ?? ''), !!event.payload?.abort);
				return true;

			case 'clipboard-write':
				await navigator.clipboard.writeText(String(event.payload?.text ?? ''));
				return true;

			case 'media-devices': {
				const devices = await navigator.mediaDevices.enumerateDevices();
				return devices.map((device) => ({
					deviceId: device.deviceId,
					groupId: device.groupId,
					kind: device.kind,
					label: device.label
				}));
			}

			case 'media-stop':
				this.stopMediaSession(String(event.payload?.sessionId ?? ''));
				return true;

			case 'notification-show': {
				// Only deliver if the viewer already granted it; asking here would
				// pop a prompt with no context about which page wanted it.
				if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
					throw this.namedError('NotAllowedError', 'Notifications are not permitted');
				}
				new Notification(String(event.payload?.title ?? ''), {
					body: event.payload?.body,
					icon: event.payload?.icon,
					tag: event.payload?.tag
				});
				return true;
			}

			default:
				throw this.namedError('NotSupportedError', `Unsupported host request: ${event.kind}`);
		}
	}

	// ── Prompted requests, resolved from the user's click ────────────────────

	/**
	 * Run the real API for a request the user just approved.
	 *
	 * Must be called synchronously from the Allow handler — the whole reason the
	 * prompt exists is to give these calls a user gesture to run inside.
	 */
	async approve(pending: PendingPermission): Promise<void> {
		try {
			const result = await this.runApproved(pending);
			this.respond(pending.requestId, { ok: true, result });
		} catch (error) {
			this.respond(pending.requestId, { ok: false, error: this.toWireError(error) });
		}
	}

	/** Answer a prompt with a refusal, shaped the way each API reports one. */
	deny(pending: PendingPermission): void {
		if (pending.kind === 'notification-permission') {
			// requestPermission() resolves with 'denied' rather than rejecting.
			this.respond(pending.requestId, { ok: true, result: false });
			return;
		}

		this.respond(pending.requestId, {
			ok: false,
			error: {
				name: 'NotAllowedError',
				message: 'Permission denied by the user',
				// GeolocationPositionError.PERMISSION_DENIED
				code: 1
			}
		});
	}

	/** Hand the chosen files to an intercepted file input (empty = cancelled). */
	async submitFiles(pending: PendingPermission, files: File[]): Promise<void> {
		try {
			const encoded = [];
			for (const file of files) {
				if (file.size > MAX_UPLOAD_BYTES) {
					throw this.namedError(
						'NotReadableError',
						`"${file.name}" is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB preview upload limit`
					);
				}
				encoded.push({ name: file.name, data: await this.toBase64(file) });
			}

			this.respond(pending.requestId, { ok: true, result: { files: encoded } });
		} catch (error) {
			this.respond(pending.requestId, { ok: false, error: this.toWireError(error) });
		}
	}

	private async runApproved(pending: PendingPermission): Promise<unknown> {
		switch (pending.kind) {
			case 'geolocation':
				return await this.readPosition(pending.payload);

			case 'clipboard-read':
				return await navigator.clipboard.readText();

			case 'notification-permission': {
				if (typeof Notification === 'undefined') return false;
				const outcome =
					Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
				return outcome === 'granted';
			}

			case 'media-request':
				return await this.startMediaRelay(pending);

			case 'speech-start':
				return this.startSpeechRelay(pending);

			default:
				throw this.namedError('NotSupportedError', `Unsupported host request: ${pending.kind}`);
		}
	}

	// ── Speech recognition relay ────────────────────────────────────────────

	/**
	 * Run recognition on the viewer's device and stream the results back.
	 *
	 * Headless Chrome ships no speech engine, so `SpeechRecognition` there always
	 * fails with `not-allowed` no matter what permissions are granted. The
	 * viewer's browser has both the engine and the microphone, so recognition
	 * happens there and only the transcripts travel.
	 */
	private startSpeechRelay(pending: PendingPermission): boolean {
		const Recognition =
			(window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

		if (!Recognition) {
			throw this.namedError('NotSupportedError', 'This browser has no speech recognition engine');
		}

		const sessionId = String(pending.payload?.sessionId ?? '');
		if (!sessionId) {
			throw this.namedError('DataError', 'Speech session id missing');
		}

		// Starting a second run for the same id would leave the first orphaned,
		// holding the microphone open with nothing listening to it.
		this.stopSpeechSession(sessionId, true);

		const recognition = new Recognition();
		recognition.lang = pending.payload?.lang || navigator.language;
		recognition.continuous = !!pending.payload?.continuous;
		recognition.interimResults = !!pending.payload?.interimResults;
		recognition.maxAlternatives = pending.payload?.maxAlternatives ?? 1;

		recognition.onresult = (event: any) => {
			const results = [];
			for (let i = event.resultIndex; i < event.results.length; i += 1) {
				const result = event.results[i];
				const alternatives = [];
				for (let j = 0; j < result.length; j += 1) {
					alternatives.push({
						transcript: result[j].transcript,
						confidence: result[j].confidence
					});
				}
				results.push({ isFinal: result.isFinal, alternatives });
			}

			this.sendEvent(pending.tabId, 'speech-result', {
				sessionId,
				resultIndex: event.resultIndex,
				results
			});
		};

		recognition.onerror = (event: any) => {
			this.sendEvent(pending.tabId, 'speech-error', {
				sessionId,
				error: event.error,
				message: event.message
			});
		};

		recognition.onend = () => {
			this.speechSessions.delete(sessionId);
			this.sendEvent(pending.tabId, 'speech-end', { sessionId });
		};

		recognition.start();
		this.speechSessions.set(sessionId, recognition);

		return true;
	}

	private stopSpeechSession(sessionId: string, abort: boolean): void {
		const recognition = this.speechSessions.get(sessionId);
		if (!recognition) return;

		if (abort) this.speechSessions.delete(sessionId);

		try {
			// `abort()` drops pending audio; `stop()` finishes the current phrase
			// first, which is what the page asked for when it called stop().
			if (abort) recognition.abort();
			else recognition.stop();
		} catch {
			// Already finished.
		}
	}

	private readPosition(options: PositionOptions | undefined): Promise<Record<string, number | null>> {
		return new Promise((resolve, reject) => {
			if (!navigator.geolocation) {
				reject(this.namedError('PositionUnavailableError', 'This device has no geolocation', 2));
				return;
			}

			navigator.geolocation.getCurrentPosition(
				(position) =>
					resolve({
						latitude: position.coords.latitude,
						longitude: position.coords.longitude,
						accuracy: position.coords.accuracy,
						altitude: position.coords.altitude,
						altitudeAccuracy: position.coords.altitudeAccuracy,
						heading: position.coords.heading,
						speed: position.coords.speed,
						timestamp: position.timestamp
					}),
				(error) => reject(this.namedError('NotAllowedError', error.message, error.code)),
				{
					enableHighAccuracy: !!options?.enableHighAccuracy,
					timeout: options?.timeout ?? 20000,
					maximumAge: options?.maximumAge ?? 0
				}
			);
		});
	}

	// ── Camera / microphone relay ───────────────────────────────────────────

	/**
	 * Capture from the viewer's device and answer the page's offer with those
	 * tracks. The page opened a recvonly connection, so all that is needed here
	 * is to attach the real tracks and reply — no renegotiation.
	 */
	private async startMediaRelay(pending: PendingPermission): Promise<{ sdp: string; sessionId: string }> {
		const wantsVideo = !!pending.payload?.video;
		const wantsAudio = !!pending.payload?.audio;

		// A display request opens the viewer's own screen picker; a camera request
		// opens their device. Both end up as tracks on the same relay.
		const stream = pending.payload?.display
			? await navigator.mediaDevices.getDisplayMedia({
					video: pending.payload?.constraints?.video ?? true,
					audio: wantsAudio
				})
			: await navigator.mediaDevices.getUserMedia({
					video: wantsVideo ? (pending.payload?.constraints?.video ?? true) : false,
					audio: wantsAudio ? (pending.payload?.constraints?.audio ?? true) : false
				});

		const pc = new RTCPeerConnection({ iceServers: this.iceServers });

		try {
			// Remote description first, tracks second. The page offered specific
			// recvonly transceivers; adding tracks beforehand would create fresh
			// ones and the answer would come back with mismatched m-lines.
			await pc.setRemoteDescription({ type: 'offer', sdp: String(pending.payload?.sdp ?? '') });

			for (const track of stream.getTracks()) {
				const transceiver = pc
					.getTransceivers()
					.find((candidate) => candidate.receiver.track?.kind === track.kind && !candidate.sender.track);

				if (transceiver) {
					await transceiver.sender.replaceTrack(track);
					transceiver.direction = 'sendonly';
				} else {
					pc.addTrack(track, stream);
				}
			}

			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);
			await this.waitForIce(pc);
		} catch (error) {
			this.closeMediaSession({ pc, stream });
			throw error;
		}

		const sessionId = `${pending.tabId}:${pending.requestId}`;
		this.mediaSessions.set(sessionId, { pc, stream });

		// The page can navigate away without ever calling stop(); dropping the
		// relay when the connection dies releases the camera light either way.
		pc.addEventListener('connectionstatechange', () => {
			if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
				this.stopMediaSession(sessionId);
			}
		});

		return { sdp: pc.localDescription?.sdp ?? '', sessionId };
	}

	private waitForIce(pc: RTCPeerConnection): Promise<void> {
		if (pc.iceGatheringState === 'complete') return Promise.resolve();

		return new Promise((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				pc.removeEventListener('icegatheringstatechange', onChange);
				resolve();
			};
			const onChange = () => {
				if (pc.iceGatheringState === 'complete') finish();
			};
			pc.addEventListener('icegatheringstatechange', onChange);
			// Signalling is non-trickle, so an unreachable STUN server must not
			// hold the answer back past what host candidates alone can carry.
			setTimeout(finish, 2500);
		});
	}

	private stopMediaSession(sessionId: string): void {
		const session = this.mediaSessions.get(sessionId);
		if (!session) return;
		this.mediaSessions.delete(sessionId);
		this.closeMediaSession(session);
	}

	private closeMediaSession(session: { pc: RTCPeerConnection; stream: MediaStream }): void {
		for (const track of session.stream.getTracks()) {
			try {
				track.stop();
			} catch {
				// Already stopped.
			}
		}
		try {
			session.pc.close();
		} catch {
			// Already closed.
		}
	}

	// ── Downloads ───────────────────────────────────────────────────────────

	/**
	 * Save a file the previewed page downloaded onto the viewer's machine, which
	 * is the only place a download is any use.
	 */
	private handleDownload(event: BrowserDownloadEvent): void {
		this.callbacks?.onDownload?.(event);

		if (event.state !== 'completed' || !event.data) return;

		try {
			const binary = atob(event.data);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i += 1) {
				bytes[i] = binary.charCodeAt(i);
			}

			const url = URL.createObjectURL(new Blob([bytes]));
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = event.filename || 'download';
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			// Revoke on the next tick — Safari cancels the download if the object
			// URL disappears while the click is still being processed.
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (error) {
			debug.error('preview', 'Failed to save relayed download:', error);
		}
	}

	// ── Plumbing ────────────────────────────────────────────────────────────

	/** Push a streamed result down to the page that is waiting on it. */
	private sendEvent(tabId: string, kind: string, payload: unknown): void {
		try {
			ws.emit('preview:browser-host-event', { tabId, kind, payload });
		} catch (error) {
			debug.error('preview', 'Failed to deliver host event:', error);
		}
	}

	private respond(
		requestId: string,
		response: { ok: boolean; result?: unknown; error?: { name?: string; message?: string; code?: number } }
	): void {
		try {
			ws.emit('preview:browser-host-response', { requestId, ...response });
		} catch (error) {
			debug.error('preview', 'Failed to answer host request:', error);
		}
	}

	private toWireError(error: unknown): { name?: string; message?: string; code?: number } {
		if (error instanceof Error) {
			return {
				name: error.name,
				message: error.message,
				code: (error as Error & { code?: number }).code
			};
		}
		return { name: 'UnknownError', message: String(error) };
	}

	private namedError(name: string, message: string, code?: number): Error {
		const error = new Error(message);
		error.name = name;
		if (typeof code === 'number') (error as Error & { code?: number }).code = code;
		return error;
	}

	private toBase64(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = String(reader.result ?? '');
				resolve(result.slice(result.indexOf(',') + 1));
			};
			reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
			reader.readAsDataURL(file);
		});
	}
}

export const previewHostBridge = new PreviewHostBridge();
