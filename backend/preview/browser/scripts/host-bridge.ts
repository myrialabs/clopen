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
 * Also stands in for the Fullscreen API. Real fullscreen collapses the surface
 * Chrome composites to the browser *window* and leaves it there, so the preview
 * comes back cropped and zoomed with no way out — the exit affordance lives in
 * browser chrome that does not exist here. A CSS-based fullscreen leaves the
 * captured surface alone and stays exitable, and
 * the requests Chrome makes on the page's behalf — the button on its own media
 * controls, which is C++ and never touches these patches — are caught after the
 * fact and converted. Picture-in-Picture, which has no such equivalent, is
 * reported as unavailable instead of dropping the video into a window nobody can
 * see.
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
	// Chrome's real fullscreen resizes the surface it composites down to the
	// browser window, and leaves it there once the fullscreen ends. The page goes
	// on being laid out against the emulated viewport the whole time, so what the
	// preview captures is that layout seen through a window-sized hole: zoomed,
	// cropped at the right and the bottom, and stuck that way until a reload,
	// because nothing in the page ever noticed. A CSS fullscreen gives the page
	// what it asked for and leaves the surface alone.
	//
	// Which means *every* spelling has to be covered, not just the standard one.
	// A single unpatched entry point — `video.webkitEnterFullscreen()`, which
	// media players still reach for — hands the renderer straight to Chrome, and
	// that is exactly the cropped state that then survives the exit.
	{
		const STYLE_ID = '__clopen-fullscreen-style';
		const MAX_Z = 2147483647;
		/** How long the exit hint stays up before fading, as in Chrome itself. */
		const EXIT_HINT_MS = 3200;
		/** What counts as "the user is still there" and brings the hint back. */
		const ACTIVITY_EVENTS = ['mousemove', 'touchstart', 'keydown'];

		let fullscreenElement: Element | null = null;
		let exitButton: HTMLElement | null = null;
		let hideHintTimer: ReturnType<typeof setTimeout> | undefined;

		// Captured before the patches further down shadow them. Every replacement
		// below is installed as an *own* property of `document`, while the real
		// `fullscreenElement` and `exitFullscreen` live on `Document.prototype` — so
		// the originals stay reachable, and reading them is the only way to tell an
		// actual browser fullscreen from the one this shim fakes.
		const readNativeElement = ((): (() => Element | null) => {
			for (const key of ['fullscreenElement', 'webkitFullscreenElement']) {
				const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, key);
				if (descriptor?.get) return descriptor.get.bind(document) as () => Element | null;
			}
			return () => null;
		})();

		const nativeExit = ((): (() => unknown) | null => {
			const target = document as Document & { webkitExitFullscreen?: () => unknown };
			const fn = target.exitFullscreen || target.webkitExitFullscreen;
			return typeof fn === 'function' ? fn.bind(document) : null;
		})();

		const ensureStyle = () => {
			if (document.getElementById(STYLE_ID)) return;
			const style = document.createElement('style');
			style.id = STYLE_ID;
			// `100%` of the fixed containing block, not `100vw`/`100vh`: viewport
			// units include the scrollbar gutter, so the element overhung the
			// visible area by however wide that is.
			//
			// The black background is scoped to replaced content, which is the only
			// thing `object-fit: contain` letterboxes and therefore the only place
			// bars need filling. Applied to everything, it repainted a fullscreened
			// container black over whatever background the page had given it.
			style.textContent = `
				[data-clopen-fullscreen] {
					position: fixed !important;
					inset: 0 !important;
					width: 100% !important;
					height: 100% !important;
					max-width: none !important;
					max-height: none !important;
					min-width: 0 !important;
					min-height: 0 !important;
					margin: 0 !important;
					z-index: ${MAX_Z} !important;
				}
				video[data-clopen-fullscreen],
				img[data-clopen-fullscreen],
				canvas[data-clopen-fullscreen] {
					object-fit: contain !important;
					background: #000 !important;
				}
				html.clopen-fullscreen-active, body.clopen-fullscreen-active {
					overflow: hidden !important;
				}
			`;
			(document.head || document.documentElement).appendChild(style);
		};

		/**
		 * Bring the hint back and start its countdown again.
		 *
		 * It stays clickable while faded — the fade is there so the corner of a
		 * video is not permanently covered, not to withdraw the way out. A phone
		 * has no pointer to move, so a tap has to land on something.
		 */
		const revealExitButton = () => {
			if (!exitButton) return;
			exitButton.style.opacity = '1';
			clearTimeout(hideHintTimer);
			hideHintTimer = setTimeout(() => {
				if (exitButton) exitButton.style.opacity = '0.12';
			}, EXIT_HINT_MS);
		};

		/**
		 * The exit affordance.
		 *
		 * Rendered inside the page on purpose: it is then part of the captured
		 * frame and answers a normal click or tap, so it works on a phone and on
		 * a second viewer's screen. Anything app-side would need a channel of its
		 * own and would still miss the pages that swallow Escape.
		 *
		 * It fades the way Chrome's own "Press Esc to exit full screen" notice
		 * does and returns on the next sign of life. A badge pinned over the
		 * corner of a video for the whole of playback is not what full screen
		 * looks like anywhere else.
		 */
		const showExitButton = () => {
			if (exitButton) {
				revealExitButton();
				return;
			}

			const button = document.createElement('button');
			button.type = 'button';
			button.setAttribute('data-clopen-fullscreen-ui', '');
			button.textContent = 'Exit full screen (Esc)';
			button.style.cssText = [
				'position:fixed',
				'top:12px',
				'right:12px',
				`z-index:${MAX_Z}`,
				'margin:0',
				'padding:6px 12px',
				'border:0',
				'border-radius:9999px',
				'font:500 12px/1.4 system-ui,-apple-system,Segoe UI,sans-serif',
				'color:#fff',
				'background:rgba(15,23,42,0.82)',
				'box-shadow:0 2px 10px rgba(0,0,0,0.45)',
				'cursor:pointer',
				'opacity:1',
				'transition:opacity 220ms ease'
			].join(';');
			button.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				void exit();
			});
			(document.body || document.documentElement).appendChild(button);
			exitButton = button;

			// Capture phase: a player that swallows pointer events over its own
			// surface would otherwise keep the hint from ever coming back.
			for (const type of ACTIVITY_EVENTS) {
				document.addEventListener(type, revealExitButton, true);
			}
			revealExitButton();
		};

		const removeChrome = () => {
			clearTimeout(hideHintTimer);
			hideHintTimer = undefined;
			for (const type of ACTIVITY_EVENTS) {
				document.removeEventListener(type, revealExitButton, true);
			}
			exitButton?.remove();
			exitButton = null;
		};

		/**
		 * Chrome fires this *on the element*; listeners on `document` only see it
		 * because it bubbles. Dispatching it on `document` alone therefore never
		 * reached a player that listens on its own container — which left the page
		 * convinced it was still fullscreen after the exit, laying out its content
		 * for a viewport it no longer had.
		 */
		const notify = (target: EventTarget | null) => {
			const on = target && (target as Node).isConnected ? target : document;
			for (const type of ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange']) {
				on.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
			}
		};

		const clearMarks = (element: Element | null) => {
			if (!element) return;
			element.removeAttribute('data-clopen-fullscreen');
		};

		const enter = (element: Element) => {
			ensureStyle();
			if (fullscreenElement && fullscreenElement !== element) clearMarks(fullscreenElement);

			fullscreenElement = element;
			// The root and the body already fill the viewport; pinning them as
			// fixed boxes only breaks their own layout.
			if (element !== document.documentElement && element !== document.body) {
				element.setAttribute('data-clopen-fullscreen', '');
			}
			document.documentElement.classList.add('clopen-fullscreen-active');
			document.body?.classList.add('clopen-fullscreen-active');
			showExitButton();
			notify(element);
			return Promise.resolve();
		};

		const exit = () => {
			const previous = fullscreenElement;
			if (!previous) return Promise.resolve();

			clearMarks(previous);
			fullscreenElement = null;
			document.documentElement.classList.remove('clopen-fullscreen-active');
			document.body?.classList.remove('clopen-fullscreen-active');
			removeChrome();
			notify(previous);
			return Promise.resolve();
		};

		/**
		 * Read the current element, dropping it if the page has since replaced it.
		 *
		 * A re-render (any framework will do) can detach the node that went
		 * fullscreen. Reporting a detached element keeps the page in fullscreen
		 * mode forever with nothing on screen to leave it by — so the read itself
		 * is where that state gets cleaned up.
		 */
		const currentElement = (): Element | null => {
			if (fullscreenElement && !fullscreenElement.isConnected) void exit();
			return fullscreenElement;
		};

		// A fresh function per name: `nativeLike` stamps `fn.name`, so one shared
		// implementation would end up reporting whichever alias was installed last.
		const enterFrom = (name: string) =>
			nativeLike(function (this: Element) {
				return enter(this);
			} as never, name);

		for (const key of [
			'requestFullscreen',
			'webkitRequestFullscreen',
			'webkitRequestFullScreen',
			'mozRequestFullScreen',
			'msRequestFullscreen'
		]) {
			define(Element.prototype, key, enterFrom(key));
		}

		// Media players reach for these before the standard API when they think
		// they are on iOS. In Chrome they are real, and they are real *browser*
		// fullscreen — the one path that wrecks the emulated viewport.
		if (typeof HTMLVideoElement !== 'undefined') {
			define(HTMLVideoElement.prototype, 'webkitEnterFullscreen', enterFrom('webkitEnterFullscreen'));
			define(HTMLVideoElement.prototype, 'webkitEnterFullScreen', enterFrom('webkitEnterFullScreen'));
			define(HTMLVideoElement.prototype, 'webkitExitFullscreen', nativeLike(function webkitExitFullscreen() {
				return exit();
			} as never, 'webkitExitFullscreen'));
			try {
				Object.defineProperty(HTMLVideoElement.prototype, 'webkitSupportsFullscreen', {
					configurable: true,
					get: () => true
				});
				Object.defineProperty(HTMLVideoElement.prototype, 'webkitDisplayingFullscreen', {
					configurable: true,
					get(this: Element) {
						return currentElement() === this;
					}
				});
			} catch {
				// Already non-configurable in this engine.
			}
		}

		for (const key of ['exitFullscreen', 'webkitExitFullscreen', 'webkitCancelFullScreen', 'mozCancelFullScreen', 'msExitFullscreen']) {
			define(document, key, nativeLike(function exitFullscreen() {
				return exit();
			} as never, key));
		}

		try {
			for (const key of ['fullscreenElement', 'webkitFullscreenElement', 'mozFullScreenElement', 'msFullscreenElement']) {
				Object.defineProperty(document, key, {
					configurable: true,
					get: () => currentElement()
				});
			}
			for (const key of ['fullscreenEnabled', 'webkitFullscreenEnabled', 'mozFullScreenEnabled', 'msFullscreenEnabled']) {
				Object.defineProperty(document, key, { configurable: true, get: () => true });
			}
			for (const key of ['webkitIsFullScreen', 'mozFullScreen']) {
				Object.defineProperty(document, key, { configurable: true, get: () => currentElement() !== null });
			}
		} catch {
			// Already non-configurable in this engine.
		}

		// Escape is how every browser leaves fullscreen. It stays, but it is no
		// longer the only way out — a preview is often driven from a phone, where
		// there is no Escape key to press.
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

		// ── Fullscreen that never went through JavaScript ────────────────────
		//
		// The fullscreen button on a `<video controls>` bar is not scripted. Chrome
		// draws those controls itself and its button asks for fullscreen from C++,
		// so every patch above is stepped over and the surface collapses after all
		// — the zoomed, cropped, unexitable frame this whole block exists to avoid.
		// Double-clicking a video takes the same route.
		//
		// Nothing inside the page can stop that from happening. It can, however, be
		// seen the instant it does, and undone: leave Chrome's fullscreen and replay
		// the request as the CSS one, which is indistinguishable to the person who
		// pressed the button.
		//
		// The round trip is hidden from the page. Left visible it reads as fullscreen
		// starting and immediately ending, which is precisely how a player decides
		// the user backed out — and it would then tear down its own fullscreen
		// layout underneath us.
		let unwinding = false;
		let unwindTimer: ReturnType<typeof setTimeout> | undefined;

		const finishUnwind = () => {
			unwinding = false;
			clearTimeout(unwindTimer);
			unwindTimer = undefined;
		};

		const onNativeFullscreenChange = (event: Event) => {
			// Synthetic events are this shim's own, and they are the ones the page
			// is meant to hear.
			if (!event.isTrusted) return;

			const native = readNativeElement();

			if (unwinding) {
				event.stopImmediatePropagation();
				// Chrome fires the prefixed alias alongside the standard event, so
				// the pair has to clear before the guard drops — a same-task reset
				// would let the second one through as a spurious exit.
				if (!native) setTimeout(finishUnwind, 0);
				return;
			}

			// A trusted exit with nothing left in fullscreen is Chrome tidying up
			// after itself; there is nothing to convert.
			if (!native) return;

			event.stopImmediatePropagation();
			unwinding = true;

			/**
			 * Have the host re-assert the emulated viewport.
			 *
			 * Unconditionally, because the page cannot tell whether it is needed.
			 * What Chrome's fullscreen strands is the surface it composites — the
			 * frames the capture is cut from collapse to the window and stay there
			 * after the exit. The layout viewport is untouched throughout, so
			 * `innerWidth` and everything measurable from here reports business as
			 * usual while the preview is quietly cropped.
			 */
			let restoreSent = false;
			const restoreHost = () => {
				if (restoreSent) return;
				restoreSent = true;
				void call('viewport-restore').catch(() => {
					// No bridge in this frame and no top frame to relay through; the
					// CSS fullscreen still stands regardless.
				});
			};

			// A promise that never settles, or a browser that fires no closing
			// event, must not wedge every later toggle — or skip the restore.
			unwindTimer = setTimeout(() => {
				finishUnwind();
				restoreHost();
			}, 2000);

			try {
				const result = nativeExit?.() as Promise<void> | undefined;
				if (result && typeof result.then === 'function') {
					// One frame after the exit resolves: the renderer resizes back
					// asynchronously, and measuring before it has would report the
					// fullscreen geometry and ask for a restore that is not needed.
					result.then(
						() => requestAnimationFrame(restoreHost),
						() => {
							finishUnwind();
							restoreHost();
						}
					);
				} else {
					requestAnimationFrame(restoreHost);
				}
			} catch {
				finishUnwind();
				restoreHost();
			}

			// The same element twice means the built-in button was pressed while
			// this shim already had it full screen — which, to whoever pressed it,
			// is the request to come back out.
			if (fullscreenElement === native) void exit();
			else void enter(native);
		};

		for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
			document.addEventListener(type, onNativeFullscreenChange, true);
		}

		// A video going fullscreen usually also asks to lock orientation, which
		// would throw here and abort the page's own handler.
		const orientation = (screen as unknown as { orientation?: Record<string, unknown> }).orientation;
		if (orientation) {
			define(orientation, 'lock', nativeLike(function lock() {
				return Promise.resolve();
			} as never, 'lock'));
			if (typeof orientation.unlock !== 'function') {
				define(orientation, 'unlock', nativeLike(function unlock() {} as never, 'unlock'));
			}
		}
	}

	// ── Picture-in-Picture ──────────────────────────────────────────────────
	// The fullscreen problem again, minus any way to answer it: Picture-in-Picture
	// moves the video into an operating-system window, and a headless renderer has
	// no windows. The video leaves the page and is simply never seen again. The
	// button that sends it there is Chrome's own, so it cannot be intercepted on
	// the way out either.
	//
	// So the preview presents itself as a browser where the feature is unavailable
	// — a state the web already knows how to handle. The built-in button drops out
	// of the controls, feature detection reports it off, and a scripted request is
	// refused the way a policy-blocked one is.
	{
		const withhold = (event: Event) => {
			const video = event.target as HTMLVideoElement | null;
			if (!video || typeof HTMLVideoElement === 'undefined') return;
			if (video instanceof HTMLVideoElement && !video.disablePictureInPicture) {
				video.disablePictureInPicture = true;
			}
		};

		// Media events do not bubble, but a capture listener still sees them on the
		// way down to the target — which catches every video, including ones added
		// later, without watching the whole document for them.
		for (const type of ['loadstart', 'loadedmetadata', 'play']) {
			document.addEventListener(type, withhold, true);
		}

		try {
			Object.defineProperty(document, 'pictureInPictureEnabled', {
				configurable: true,
				get: () => false
			});
		} catch {
			// Already non-configurable in this engine.
		}

		if (typeof HTMLVideoElement !== 'undefined') {
			define(
				HTMLVideoElement.prototype,
				'requestPictureInPicture',
				nativeLike(function requestPictureInPicture() {
					return Promise.reject(
						namedError('SecurityError', 'Picture-in-Picture is not available in this preview')
					);
				} as never, 'requestPictureInPicture')
			);
		}

		// Whatever still slips through — a Chrome build with different controls, a
		// route added later — must not take the video off screen for good.
		document.addEventListener(
			'enterpictureinpicture',
			() => {
				const exitPip = (document as Document & { exitPictureInPicture?: () => Promise<void> })
					.exitPictureInPicture;
				try {
					void exitPip?.call(document).catch(() => {});
				} catch {
					// Nothing else to try; the video is out of reach either way.
				}
			},
			true
		);
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
