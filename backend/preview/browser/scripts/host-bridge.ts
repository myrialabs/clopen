/**
 * Host Bridge Client Script
 *
 * Runs inside the headless page and re-points the capability APIs that a real
 * browser answers from the device — geolocation, camera/microphone, screen
 * capture, speech recognition, clipboard, notifications — at the *viewer's*
 * browser instead. Headless Chrome has none of those, so without this every one
 * of them fails outright and the preview stops behaving like a browser the
 * moment a page asks for anything real.
 *
 * Also stands in for the Fullscreen API. Real fullscreen resizes the renderer to
 * the browser *window*, which throws away the emulated viewport the preview is
 * built on — the page comes back zoomed, off-centre and letterboxed, with no way
 * out because the exit affordance lives in browser chrome that does not exist
 * here. A CSS-based fullscreen keeps the viewport intact and stays exitable.
 *
 * Runs in **every** frame. Cross-origin frames have no binding of their own, so
 * they relay through the top frame over `postMessage`, keyed by the same
 * randomised name the binding uses.
 */
export function hostBridgeScript(bindingName: string) {
	const scope = window as unknown as Record<string, unknown>;
	if (scope.__clopenHostBridgeReady) return;
	scope.__clopenHostBridgeReady = true;

	const RELAY_KEY = `${bindingName}R`;
	const EVENT_HOOK = `${bindingName}E`;

	interface BridgeError {
		name?: string;
		message?: string;
		code?: number;
	}

	interface BridgeResponse {
		ok: boolean;
		result?: unknown;
		error?: BridgeError;
	}

	function namedError(name: string, message: string, code?: number): Error {
		const error = new Error(message);
		error.name = name;
		if (typeof code === 'number') {
			(error as Error & { code?: number }).code = code;
		}
		return error;
	}

	function unwrap(response: BridgeResponse): unknown {
		if (!response.ok) {
			throw namedError(
				response.error?.name || 'NotAllowedError',
				response.error?.message || 'Permission denied',
				response.error?.code
			);
		}
		return response.result;
	}

	// ── Transport ───────────────────────────────────────────────────────────

	const relayWaiters = new Map<string, (response: BridgeResponse) => void>();
	let relaySeq = 0;

	/**
	 * Round-trip one request to the viewer.
	 *
	 * The binding only exists where Chrome installed it — the main frame and any
	 * same-process iframe. Everything else (a cross-origin embed, which is most
	 * of them under site isolation) hops through the top frame instead, which is
	 * why an embedded page could not open a picker or ask for a camera.
	 */
	function call(kind: string, payload?: unknown): Promise<any> {
		const binding = scope[bindingName] as ((raw: string) => Promise<string>) | undefined;

		if (typeof binding === 'function') {
			return binding(JSON.stringify({ kind, payload })).then((raw: string) =>
				unwrap(JSON.parse(raw) as BridgeResponse)
			);
		}

		if (window === window.top) {
			return Promise.reject(namedError('NotSupportedError', 'Preview host bridge is unavailable'));
		}

		relaySeq += 1;
		const id = `${relaySeq}`;

		return new Promise((resolve, reject) => {
			relayWaiters.set(id, (response) => {
				try {
					resolve(unwrap(response));
				} catch (error) {
					reject(error);
				}
			});

			try {
				window.top?.postMessage({ [RELAY_KEY]: { id, kind, payload } }, '*');
			} catch {
				relayWaiters.delete(id);
				reject(namedError('NotSupportedError', 'Preview host bridge is unreachable'));
			}

			setTimeout(() => {
				if (!relayWaiters.delete(id)) return;
				reject(namedError('AbortError', 'Preview host bridge timed out'));
			}, 180000);
		});
	}

	window.addEventListener('message', (event: MessageEvent) => {
		const data = event.data as Record<string, any> | null;
		if (!data || typeof data !== 'object') return;

		// Top frame: forward a child's request and post the answer back.
		const request = data[RELAY_KEY];
		if (request && window === window.top) {
			const binding = scope[bindingName] as ((raw: string) => Promise<string>) | undefined;
			const source = event.source as WindowProxy | null;
			if (!source) return;

			const reply = (response: BridgeResponse) => {
				try {
					source.postMessage({ [`${RELAY_KEY}Reply`]: { id: request.id, response } }, '*');
				} catch {
					// Frame went away mid-flight.
				}
			};

			if (typeof binding !== 'function') {
				reply({ ok: false, error: { name: 'NotSupportedError', message: 'Bridge unavailable' } });
				return;
			}

			binding(JSON.stringify({ kind: request.kind, payload: request.payload }))
				.then((raw: string) => reply(JSON.parse(raw) as BridgeResponse))
				.catch((error: Error) => reply({ ok: false, error: { name: error.name, message: error.message } }));
			return;
		}

		// Child frame: settle the promise the relay is holding.
		const replyPayload = data[`${RELAY_KEY}Reply`];
		if (replyPayload) {
			const waiter = relayWaiters.get(replyPayload.id);
			if (waiter) {
				relayWaiters.delete(replyPayload.id);
				waiter(replyPayload.response);
			}
			return;
		}

		// Top frame broadcasts host events down to children.
		const forwarded = data[`${RELAY_KEY}Event`];
		if (forwarded) {
			deliverEvent(forwarded.kind, forwarded.payload, false);
		}
	});

	// ── Host → page events ──────────────────────────────────────────────────
	//
	// The request/response channel cannot carry a stream, and speech recognition
	// is a stream: results keep arriving until the page stops listening.

	const eventListeners = new Map<string, Set<(payload: any) => void>>();

	function onHostEvent(kind: string, listener: (payload: any) => void): () => void {
		let listeners = eventListeners.get(kind);
		if (!listeners) {
			listeners = new Set();
			eventListeners.set(kind, listeners);
		}
		listeners.add(listener);
		return () => listeners?.delete(listener);
	}

	function deliverEvent(kind: string, payload: unknown, broadcast: boolean): void {
		const listeners = eventListeners.get(kind);
		if (listeners) {
			for (const listener of Array.from(listeners)) {
				try {
					listener(payload);
				} catch {
					// A page listener throwing must not stop the rest.
				}
			}
		}

		// Only the top frame receives the injected call, so it repeats the event
		// to every child — the frame that asked may be several levels down.
		if (!broadcast) return;
		for (let i = 0; i < window.frames.length; i += 1) {
			try {
				window.frames[i].postMessage({ [`${RELAY_KEY}Event`]: { kind, payload } }, '*');
			} catch {
				// Cross-origin child that refused the post; nothing to do.
			}
		}
	}

	// Entry point the backend calls into with `page.evaluate`.
	scope[EVENT_HOOK] = (raw: string) => {
		try {
			const parsed = JSON.parse(raw) as { kind: string; payload: unknown };
			deliverEvent(parsed.kind, parsed.payload, true);
		} catch {
			// Malformed event — ignore.
		}
	};

	/**
	 * Wrap a replacement so it reports itself as the built-in it stands in for.
	 * Bot-detection scripts read `Function.prototype.toString` far more often
	 * than they probe behaviour.
	 */
	function nativeLike<T extends (...args: never[]) => unknown>(fn: T, name: string): T {
		try {
			Object.defineProperty(fn, 'name', { value: name, configurable: true });
			return new Proxy(fn, {
				get(target, prop, receiver) {
					if (prop === 'toString') {
						return function toString() {
							return `function ${name}() { [native code] }`;
						};
					}
					return Reflect.get(target, prop, receiver);
				}
			}) as T;
		} catch {
			return fn;
		}
	}

	function define(target: object, key: string, value: unknown): void {
		try {
			Object.defineProperty(target, key, { value, configurable: true, writable: true });
		} catch {
			try {
				(target as Record<string, unknown>)[key] = value;
			} catch {
				// Frozen prototype — leave the original in place.
			}
		}
	}

	// ── Geolocation ─────────────────────────────────────────────────────────
	// Answered by the viewer's device, so the page sees the location of the
	// person actually looking at it rather than the server's datacentre.
	const geolocation = navigator.geolocation;
	if (geolocation) {
		const watchers = new Map<number, ReturnType<typeof setInterval>>();
		let watchSeq = 0;

		// Fixed cadence rather than honouring `maximumAge`: each poll may surface
		// a permission prompt on the viewer, so a page asking for 100ms updates
		// must not be able to drive that.
		const WATCH_INTERVAL_MS = 15000;

		const toPosition = (raw: Record<string, number | null>) => ({
			coords: {
				latitude: raw.latitude,
				longitude: raw.longitude,
				accuracy: raw.accuracy,
				altitude: raw.altitude ?? null,
				altitudeAccuracy: raw.altitudeAccuracy ?? null,
				heading: raw.heading ?? null,
				speed: raw.speed ?? null
			},
			timestamp: raw.timestamp || Date.now()
		});

		const toPositionError = (error: Error & { code?: number }) => ({
			code: typeof error.code === 'number' ? error.code : 1,
			message: error.message || 'User denied Geolocation',
			PERMISSION_DENIED: 1,
			POSITION_UNAVAILABLE: 2,
			TIMEOUT: 3
		});

		const requestPosition = (
			success?: (position: unknown) => void,
			failure?: (error: unknown) => void,
			options?: PositionOptions
		) => {
			call('geolocation', {
				enableHighAccuracy: !!options?.enableHighAccuracy,
				timeout: options?.timeout,
				maximumAge: options?.maximumAge
			})
				.then((raw) => {
					if (typeof success === 'function') success(toPosition(raw));
				})
				.catch((error: Error & { code?: number }) => {
					if (typeof failure === 'function') failure(toPositionError(error));
				});
		};

		define(
			geolocation,
			'getCurrentPosition',
			nativeLike(function getCurrentPosition(
				success?: (position: unknown) => void,
				failure?: (error: unknown) => void,
				options?: PositionOptions
			) {
				requestPosition(success, failure, options);
			} as never, 'getCurrentPosition')
		);

		define(
			geolocation,
			'watchPosition',
			nativeLike(function watchPosition(
				success?: (position: unknown) => void,
				failure?: (error: unknown) => void,
				options?: PositionOptions
			) {
				watchSeq += 1;
				const id = watchSeq;
				requestPosition(success, failure, options);
				watchers.set(id, setInterval(() => requestPosition(success, failure, options), WATCH_INTERVAL_MS));
				return id;
			} as never, 'watchPosition')
		);

		define(
			geolocation,
			'clearWatch',
			nativeLike(function clearWatch(id: number) {
				const handle = watchers.get(id);
				if (handle !== undefined) {
					clearInterval(handle);
					watchers.delete(id);
				}
			} as never, 'clearWatch')
		);
	}

	// ── Camera / microphone / screen ────────────────────────────────────────
	const mediaDevices = navigator.mediaDevices;
	if (mediaDevices) {
		const ICE_SERVERS = [
			{ urls: 'stun:stun.l.google.com:19302' },
			{ urls: 'stun:stun1.l.google.com:19302' }
		];

		/** Resolve once ICE gathering settles, or give up and send what we have. */
		function waitForIce(pc: RTCPeerConnection): Promise<void> {
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
				// Non-trickle signalling: a slow or unreachable STUN server must
				// not stall the request forever, host candidates alone are enough
				// whenever the viewer and the server share a network.
				setTimeout(finish, 2500);
			});
		}

		async function requestHostMedia(
			constraints: MediaStreamConstraints,
			display: boolean
		): Promise<MediaStream> {
			const wantsVideo = display ? true : !!constraints?.video;
			const wantsAudio = !!constraints?.audio;
			if (!wantsVideo && !wantsAudio) {
				throw namedError('TypeError', 'At least one of audio and video must be requested');
			}

			const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
			const stream = new MediaStream();
			const expectedTracks = (wantsVideo ? 1 : 0) + (wantsAudio ? 1 : 0);

			let markReady: () => void = () => {};
			const tracksReady = new Promise<void>((resolve) => {
				markReady = resolve;
			});

			pc.ontrack = (event) => {
				stream.addTrack(event.track);
				if (stream.getTracks().length >= expectedTracks) markReady();
			};

			if (wantsAudio) pc.addTransceiver('audio', { direction: 'recvonly' });
			if (wantsVideo) pc.addTransceiver('video', { direction: 'recvonly' });

			let sessionId = '';
			try {
				const offer = await pc.createOffer();
				await pc.setLocalDescription(offer);
				await waitForIce(pc);

				const answer = await call('media-request', {
					video: wantsVideo,
					audio: wantsAudio,
					display,
					constraints: JSON.parse(JSON.stringify(constraints ?? {})),
					sdp: pc.localDescription?.sdp || ''
				});

				sessionId = answer.sessionId;
				await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });

				await Promise.race([
					tracksReady,
					new Promise((_, reject) =>
						setTimeout(() => reject(namedError('NotReadableError', 'Timed out waiting for host media')), 15000)
					)
				]);
			} catch (error) {
				try {
					pc.close();
				} catch {
					// Already closed.
				}
				if (sessionId) call('media-stop', { sessionId }).catch(() => {});
				throw error;
			}

			// Tear the relay down when the page releases the last track, the way
			// a real capture releases the device.
			let released = false;
			const releaseIfDone = () => {
				if (released) return;
				if (!stream.getTracks().every((track) => track.readyState === 'ended')) return;
				released = true;
				try {
					pc.close();
				} catch {
					// Already closed.
				}
				call('media-stop', { sessionId }).catch(() => {});
			};

			for (const track of stream.getTracks()) {
				const nativeStop = track.stop.bind(track);
				define(
					track,
					'stop',
					nativeLike(function stop() {
						nativeStop();
						releaseIfDone();
					} as never, 'stop')
				);
				track.addEventListener('ended', releaseIfDone);
			}

			return stream;
		}

		define(
			mediaDevices,
			'getUserMedia',
			nativeLike(function getUserMedia(constraints: MediaStreamConstraints) {
				return requestHostMedia(constraints, false);
			} as never, 'getUserMedia')
		);

		// The preview's own capture pipeline calls getDisplayMedia to grab this
		// tab's compositor output. Keep the real implementation reachable under a
		// private name *before* replacing it — routing that internal call at the
		// viewer would ask for their camera on every single page load.
		const nativeGetDisplayMedia = mediaDevices.getDisplayMedia?.bind(mediaDevices);
		if (nativeGetDisplayMedia) {
			scope.__clopenNativeGetDisplayMedia = nativeGetDisplayMedia;
		}

		// Screen sharing is the same relay with a different source on the viewer's
		// side, so a page that offers "share your screen" works end to end.
		define(
			mediaDevices,
			'getDisplayMedia',
			nativeLike(function getDisplayMedia(constraints: MediaStreamConstraints) {
				return requestHostMedia(constraints ?? { video: true }, true);
			} as never, 'getDisplayMedia')
		);

		const originalEnumerateDevices = mediaDevices.enumerateDevices?.bind(mediaDevices);
		define(
			mediaDevices,
			'enumerateDevices',
			nativeLike(function enumerateDevices() {
				return call('media-devices')
					.then((devices: MediaDeviceInfo[]) =>
						devices.map((device) => ({
							deviceId: device.deviceId,
							groupId: device.groupId,
							kind: device.kind,
							label: device.label,
							toJSON() {
								return device;
							}
						}))
					)
					.catch(() => (originalEnumerateDevices ? originalEnumerateDevices() : []));
			} as never, 'enumerateDevices')
		);
	}

	// ── Speech recognition ──────────────────────────────────────────────────
	// Headless Chrome ships no speech engine, so the API exists and always fails
	// with `not-allowed`. The viewer's browser has both the engine and the
	// microphone permission, so recognition runs there and streams back.
	{
		let sessionSeq = 0;

		class HostSpeechRecognition extends EventTarget {
			lang = '';
			continuous = false;
			interimResults = false;
			maxAlternatives = 1;

			onresult: ((event: Event) => void) | null = null;
			onerror: ((event: Event) => void) | null = null;
			onend: ((event: Event) => void) | null = null;
			onstart: ((event: Event) => void) | null = null;
			onaudiostart: ((event: Event) => void) | null = null;
			onspeechstart: ((event: Event) => void) | null = null;

			#sessionId = '';
			#unsubscribe: Array<() => void> = [];
			#running = false;

			#emit(type: string, init: Record<string, unknown> = {}) {
				const event = new Event(type) as Event & Record<string, unknown>;
				Object.assign(event, init);
				this.dispatchEvent(event);
				const handler = (this as unknown as Record<string, ((e: Event) => void) | null>)[`on${type}`];
				if (typeof handler === 'function') handler(event);
			}

			#teardown() {
				for (const off of this.#unsubscribe) off();
				this.#unsubscribe = [];
				this.#running = false;
			}

			start() {
				if (this.#running) {
					throw namedError('InvalidStateError', 'recognition has already started');
				}
				sessionSeq += 1;
				this.#sessionId = `speech-${sessionSeq}-${Date.now()}`;
				this.#running = true;

				const matches = (payload: any) => payload?.sessionId === this.#sessionId;

				this.#unsubscribe.push(
					onHostEvent('speech-result', (payload) => {
						if (!matches(payload)) return;

						// SpeechRecognitionEvent shape: results is an indexed,
						// array-like collection of alternatives with a final flag.
						const results = (payload.results ?? []).map((entry: any) => {
							const alternatives = (entry.alternatives ?? []).map((alt: any) => ({
								transcript: alt.transcript ?? '',
								confidence: alt.confidence ?? 0
							}));
							return Object.assign(alternatives, {
								isFinal: !!entry.isFinal,
								length: alternatives.length,
								item: (index: number) => alternatives[index]
							});
						});

						this.#emit('result', {
							resultIndex: payload.resultIndex ?? 0,
							results: Object.assign(results, {
								length: results.length,
								item: (index: number) => results[index]
							})
						});
					})
				);

				this.#unsubscribe.push(
					onHostEvent('speech-error', (payload) => {
						if (!matches(payload)) return;
						this.#emit('error', { error: payload.error || 'aborted', message: payload.message || '' });
					})
				);

				this.#unsubscribe.push(
					onHostEvent('speech-end', (payload) => {
						if (!matches(payload)) return;
						this.#teardown();
						this.#emit('end');
					})
				);

				call('speech-start', {
					sessionId: this.#sessionId,
					lang: this.lang,
					continuous: this.continuous,
					interimResults: this.interimResults,
					maxAlternatives: this.maxAlternatives
				})
					.then(() => {
						this.#emit('start');
						this.#emit('audiostart');
					})
					.catch((error: Error) => {
						this.#teardown();
						this.#emit('error', {
							error: error.name === 'NotAllowedError' ? 'not-allowed' : 'service-not-allowed',
							message: error.message
						});
						this.#emit('end');
					});
			}

			stop() {
				if (!this.#running) return;
				call('speech-stop', { sessionId: this.#sessionId, abort: false }).catch(() => {});
			}

			abort() {
				if (!this.#running) return;
				call('speech-stop', { sessionId: this.#sessionId, abort: true }).catch(() => {});
				this.#teardown();
				this.#emit('end');
			}
		}

		try {
			Object.defineProperty(HostSpeechRecognition, 'name', {
				value: 'SpeechRecognition',
				configurable: true
			});
			define(scope, 'SpeechRecognition', HostSpeechRecognition);
			define(scope, 'webkitSpeechRecognition', HostSpeechRecognition);
		} catch {
			// Locked down — leave the (non-functional) original in place.
		}
	}

	// ── Fullscreen ──────────────────────────────────────────────────────────
	// Chrome's real fullscreen resizes the renderer to the browser window, which
	// discards the emulated viewport the whole preview pipeline is built on: the
	// captured frame comes back zoomed, off-centre and letterboxed, and survives
	// a reload because the renderer stays in that state. A CSS fullscreen gives
	// the page what it asked for without touching the viewport.
	{
		const STYLE_ID = '__clopen-fullscreen-style';
		let fullscreenElement: Element | null = null;

		const ensureStyle = () => {
			if (document.getElementById(STYLE_ID)) return;
			const style = document.createElement('style');
			style.id = STYLE_ID;
			style.textContent = `
				[data-clopen-fullscreen] {
					position: fixed !important;
					inset: 0 !important;
					width: 100vw !important;
					height: 100vh !important;
					max-width: 100vw !important;
					max-height: 100vh !important;
					margin: 0 !important;
					z-index: 2147483647 !important;
					background: #000;
					object-fit: contain;
				}
				html.clopen-fullscreen-active, body.clopen-fullscreen-active {
					overflow: hidden !important;
				}
			`;
			(document.head || document.documentElement).appendChild(style);
		};

		const notify = () => {
			const event = new Event('fullscreenchange', { bubbles: true });
			document.dispatchEvent(event);
			document.dispatchEvent(new Event('webkitfullscreenchange', { bubbles: true }));
		};

		const enter = (element: Element) => {
			ensureStyle();
			if (fullscreenElement && fullscreenElement !== element) {
				fullscreenElement.removeAttribute('data-clopen-fullscreen');
			}
			fullscreenElement = element;
			element.setAttribute('data-clopen-fullscreen', '');
			document.documentElement.classList.add('clopen-fullscreen-active');
			document.body?.classList.add('clopen-fullscreen-active');
			notify();
			return Promise.resolve();
		};

		const exit = () => {
			if (!fullscreenElement) return Promise.resolve();
			fullscreenElement.removeAttribute('data-clopen-fullscreen');
			fullscreenElement = null;
			document.documentElement.classList.remove('clopen-fullscreen-active');
			document.body?.classList.remove('clopen-fullscreen-active');
			notify();
			return Promise.resolve();
		};

		define(Element.prototype, 'requestFullscreen', nativeLike(function requestFullscreen(this: Element) {
			return enter(this);
		} as never, 'requestFullscreen'));
		define(Element.prototype, 'webkitRequestFullscreen', nativeLike(function webkitRequestFullscreen(this: Element) {
			return enter(this);
		} as never, 'webkitRequestFullscreen'));
		define(Element.prototype, 'webkitRequestFullScreen', nativeLike(function webkitRequestFullScreen(this: Element) {
			return enter(this);
		} as never, 'webkitRequestFullScreen'));

		define(document, 'exitFullscreen', nativeLike(function exitFullscreen() {
			return exit();
		} as never, 'exitFullscreen'));
		define(document, 'webkitExitFullscreen', nativeLike(function webkitExitFullscreen() {
			return exit();
		} as never, 'webkitExitFullscreen'));

		try {
			for (const key of ['fullscreenElement', 'webkitFullscreenElement']) {
				Object.defineProperty(document, key, {
					configurable: true,
					get: () => fullscreenElement
				});
			}
			for (const key of ['fullscreenEnabled', 'webkitFullscreenEnabled']) {
				Object.defineProperty(document, key, { configurable: true, get: () => true });
			}
		} catch {
			// Already non-configurable in this engine.
		}

		// Escape is how every browser leaves fullscreen, and it is the only exit
		// the page itself can offer once browser chrome is out of the picture.
		document.addEventListener(
			'keydown',
			(event: KeyboardEvent) => {
				if (event.key === 'Escape' && fullscreenElement) {
					event.preventDefault();
					void exit();
				}
			},
			true
		);

		// A video going fullscreen usually also asks to lock orientation, which
		// would throw here and abort the page's own handler.
		const orientation = (screen as unknown as { orientation?: Record<string, unknown> }).orientation;
		if (orientation && typeof orientation.lock !== 'function') {
			define(orientation, 'lock', nativeLike(function lock() {
				return Promise.resolve();
			} as never, 'lock'));
			define(orientation, 'unlock', nativeLike(function unlock() {} as never, 'unlock'));
		}
	}

	// ── Clipboard ───────────────────────────────────────────────────────────
	// The headless clipboard is invisible to the user; theirs is the one that
	// matters, and it is the one a paste in another app will read from.
	const clipboard = navigator.clipboard;
	if (clipboard) {
		define(
			clipboard,
			'readText',
			nativeLike(function readText() {
				return call('clipboard-read').then((text: string) => text ?? '');
			} as never, 'readText')
		);

		define(
			clipboard,
			'writeText',
			nativeLike(function writeText(text: string) {
				return call('clipboard-write', { text: String(text ?? '') }).then(() => undefined);
			} as never, 'writeText')
		);
	}

	// ── Notifications ───────────────────────────────────────────────────────
	const NativeNotification = scope.Notification as (typeof Notification) | undefined;
	if (NativeNotification) {
		let permission: NotificationPermission = 'default';

		class HostNotification extends EventTarget {
			static get permission(): NotificationPermission {
				return permission;
			}

			static requestPermission(callback?: (result: NotificationPermission) => void): Promise<NotificationPermission> {
				return call('notification-permission')
					.then((granted: boolean) => {
						permission = granted ? 'granted' : 'denied';
						if (typeof callback === 'function') callback(permission);
						return permission;
					})
					.catch(() => {
						permission = 'denied';
						if (typeof callback === 'function') callback(permission);
						return permission;
					});
			}

			title: string;
			body: string;
			icon: string;
			tag: string;
			data: unknown;
			onclick: ((event: Event) => void) | null = null;
			onclose: ((event: Event) => void) | null = null;
			onerror: ((event: Event) => void) | null = null;
			onshow: ((event: Event) => void) | null = null;

			constructor(title: string, options?: NotificationOptions) {
				super();
				this.title = String(title ?? '');
				this.body = options?.body ?? '';
				this.icon = options?.icon ?? '';
				this.tag = options?.tag ?? '';
				this.data = options?.data;

				call('notification-show', {
					title: this.title,
					body: this.body,
					icon: this.icon,
					tag: this.tag
				})
					.then(() => {
						const event = new Event('show');
						this.dispatchEvent(event);
						if (typeof this.onshow === 'function') this.onshow(event);
					})
					.catch(() => {
						const event = new Event('error');
						this.dispatchEvent(event);
						if (typeof this.onerror === 'function') this.onerror(event);
					});
			}

			close() {
				const event = new Event('close');
				this.dispatchEvent(event);
				if (typeof this.onclose === 'function') this.onclose(event);
			}
		}

		try {
			Object.defineProperty(HostNotification, 'name', { value: 'Notification', configurable: true });
			Object.defineProperty(scope, 'Notification', {
				value: HostNotification,
				configurable: true,
				writable: true
			});
		} catch {
			// Notification is locked down — keep the native (non-functional) one.
		}
	}

	// ── Permissions ─────────────────────────────────────────────────────────
	// Report `prompt` for everything the bridge owns: the real answer lives in
	// the viewer's browser and is only known once the page actually asks, so
	// claiming `denied` up front would make pages hide features that do work.
	const permissions = navigator.permissions;
	if (permissions?.query) {
		const BRIDGED = new Set([
			'geolocation',
			'camera',
			'microphone',
			'notifications',
			'clipboard-read',
			'clipboard-write',
			'speaker-selection',
			'display-capture'
		]);
		const originalQuery = permissions.query.bind(permissions);

		define(
			permissions,
			'query',
			nativeLike(function query(descriptor: PermissionDescriptor) {
				if (descriptor && BRIDGED.has(descriptor.name as string)) {
					const status = new EventTarget() as PermissionStatus;
					Object.defineProperty(status, 'name', { value: descriptor.name, configurable: true });
					Object.defineProperty(status, 'state', { value: 'prompt', configurable: true });
					Object.defineProperty(status, 'onchange', { value: null, writable: true, configurable: true });
					return Promise.resolve(status);
				}
				return originalQuery(descriptor);
			} as never, 'query')
		);
	}
}
