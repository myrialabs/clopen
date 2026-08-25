/**
 * Audio Capture Client Script
 *
 * This script runs in the headless browser to capture all audio from:
 * - AudioContext API
 * - HTML5 media elements (video, audio tags)
 *
 * Audio is encoded with AudioEncoder (Opus codec) and sent via DataChannel
 * to the WebCodecs peer connection.
 *
 * The tap is a side-chain: the page's own signal path stays untouched and a
 * parallel branch feeds the encoder through a muted sink. `ScriptProcessor`
 * (the only option before AudioWorklet) had to sit *inside* the signal path
 * and re-emit what it received, which both ran the mixdown on the page's main
 * thread and added a buffer of latency to everything the page played.
 */

import type { StreamingConfig } from '../types';

/**
 * Generate audio capture script that runs in the browser
 * This script intercepts AudioContext and captures all audio
 */
export function audioCaptureScript(config: StreamingConfig['audio']) {
	// Idempotency guard — prevent double-injection when both evaluateOnNewDocument
	// and page.evaluate inject this script into the same page context.
	if ((window as any).__audioCaptureInstalled) return;
	(window as any).__audioCaptureInstalled = true;

	// Check AudioEncoder support
	if (typeof AudioEncoder === 'undefined') {
		(window as any).__audioEncoderSupported = false;
		return;
	}

	(window as any).__audioEncoderSupported = true;

	let audioEncoder: AudioEncoder | null = null;
	let isCapturing = false;
	let sampleCount = 0;
	// Use performance.now() for each chunk to align with video timestamps
	// This ensures audio and video have the same timestamp origin

	// Track all intercepted contexts
	const interceptedContexts = new WeakSet();
	const captureNodes = new Map();

	// ── Cross-frame delivery ────────────────────────────────────────────────
	//
	// The DataChannel lives on `__webCodecsPeer`, which only exists in the top
	// frame. This script runs in every frame (it is injected on new document),
	// so audio produced inside an iframe — embedded players, ad frames, anything
	// on a CDN origin — encoded fine and was then dropped for want of a channel.
	// Same-origin frames can reach the peer directly; cross-origin ones hand the
	// encoded chunk to the top frame over postMessage.
	const RELAY_KEY = '__clopenAudioChunk';
	const isTopFrame = window === window.top;

	/** The peer, if this frame can legally reach it. */
	function resolvePeer(): any | null {
		const local = (window as any).__webCodecsPeer;
		if (local) return local;

		try {
			// Throws for cross-origin parents, which is the signal to relay.
			const top = (window.top as any)?.__webCodecsPeer;
			return top ?? null;
		} catch {
			return null;
		}
	}

	function deliverChunk(timestamp: number, data: Uint8Array) {
		const peer = resolvePeer();
		if (peer) {
			if (!peer.isActive()) return;
			peer.sendAudioChunk(timestamp, data);
			return;
		}

		if (isTopFrame) return;

		try {
			// Copy into a fresh buffer: the encoder's view may be reused, and the
			// transfer would neuter it out from under the next chunk.
			const copy = new Uint8Array(data);
			window.top?.postMessage({ [RELAY_KEY]: { timestamp, data: copy } }, '*', [copy.buffer]);
		} catch {
			// Frame is detached or the post was refused — drop the chunk; audio
			// gaps are handled by the client's playback scheduler.
		}
	}

	// Top frame: accept chunks relayed up from cross-origin children.
	if (isTopFrame) {
		window.addEventListener('message', (event: MessageEvent) => {
			const relayed = (event.data as Record<string, any> | null)?.[RELAY_KEY];
			if (!relayed) return;

			const peer = (window as any).__webCodecsPeer;
			if (!peer || !peer.isActive()) return;
			peer.sendAudioChunk(relayed.timestamp, new Uint8Array(relayed.data));
		});
	}

	// Initialize audio encoder
	async function initAudioEncoder() {
		if (audioEncoder && audioEncoder.state === 'configured') {
			return true;
		}

		try {
			audioEncoder = new AudioEncoder({
				output: (chunk: EncodedAudioChunk) => {
					const data = new Uint8Array(chunk.byteLength);
					chunk.copyTo(data);

					// Reaches the DataChannel directly in the top frame, or via the
					// relay when this encoder is running inside an iframe.
					deliverChunk(chunk.timestamp, data);
				},
				error: (e: Error) => {}
			});

			await audioEncoder.configure({
				codec: 'opus',
				sampleRate: config.sampleRate,
				numberOfChannels: config.numberOfChannels,
				bitrate: config.bitrate
			});
			return true;
		} catch (error) {
			return false;
		}
	}

	/**
	 * Encode one interleaved-by-channel block.
	 * `left`/`right` are separate planes; AudioData wants them concatenated
	 * for the planar format.
	 */
	function encodeBlock(left: Float32Array, right: Float32Array, sampleRate: number) {
		if (!isCapturing || !audioEncoder || audioEncoder.state !== 'configured') return;

		// Skip digital silence — most pages are silent most of the time, and an
		// Opus frame of silence still costs an encode, a packet and a decode.
		let hasAudio = false;
		for (let i = 0; i < left.length; i += 64) {
			if (Math.abs(left[i]) > 0.0001 || Math.abs(right[i]) > 0.0001) {
				hasAudio = true;
				break;
			}
		}
		if (!hasAudio) return;

		try {
			const planar = new Float32Array(left.length * config.numberOfChannels);
			planar.set(left, 0);
			if (config.numberOfChannels > 1) {
				planar.set(right, left.length);
			}

			// Use performance.now() directly (same as video) for proper AV sync
			const audioData = new AudioData({
				format: 'f32-planar',
				sampleRate,
				numberOfFrames: left.length,
				numberOfChannels: config.numberOfChannels,
				timestamp: performance.now() * 1000, // microseconds
				data: planar
			});

			audioEncoder.encode(audioData);
			audioData.close();

			sampleCount += left.length;
		} catch (error) {
			// Silent fail to not interrupt audio
		}
	}

	/**
	 * AudioWorklet tap. Runs on the audio rendering thread, so the page's main
	 * thread (which is also running the video encoder) never sees it.
	 */
	const workletSource = `
		class ClopenTapProcessor extends AudioWorkletProcessor {
			constructor(options) {
				super();
				this.blockSize = (options.processorOptions && options.processorOptions.blockSize) || 2048;
				this.left = new Float32Array(this.blockSize);
				this.right = new Float32Array(this.blockSize);
				this.filled = 0;
			}
			process(inputs) {
				const input = inputs[0];
				if (!input || input.length === 0) return true;
				const l = input[0];
				const r = input.length > 1 ? input[1] : input[0];
				if (!l) return true;
				for (let i = 0; i < l.length; i++) {
					this.left[this.filled] = l[i];
					this.right[this.filled] = r[i];
					this.filled++;
					if (this.filled === this.blockSize) {
						this.port.postMessage(
							{ left: this.left, right: this.right },
							[this.left.buffer, this.right.buffer]
						);
						this.left = new Float32Array(this.blockSize);
						this.right = new Float32Array(this.blockSize);
						this.filled = 0;
					}
				}
				return true;
			}
		}
		registerProcessor('clopen-tap', ClopenTapProcessor);
	`;

	let workletModuleUrl: string | null = null;

	function getWorkletUrl(): string | null {
		if (workletModuleUrl) return workletModuleUrl;
		try {
			workletModuleUrl = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
			return workletModuleUrl;
		} catch (e) {
			return null;
		}
	}

	/**
	 * Attach a capture tap to a context.
	 *
	 * Returns the node the page's audio should be routed *into*. The tap itself
	 * terminates in a muted gain node so it never contributes to what the page
	 * plays — the audible path is a separate direct connection.
	 */
	function setupCaptureForContext(ctx: AudioContext, destination: AudioNode) {
		if (captureNodes.has(ctx)) return captureNodes.get(ctx);

		let sink: GainNode;
		try {
			// Muted terminator: nodes only pull audio while connected to a
			// destination, but this branch must stay inaudible.
			sink = ctx.createGain();
			sink.gain.value = 0;
			sink.connect(destination);
		} catch (e) {
			return null;
		}

		const captureInfo: { input: AudioNode | null; sink: GainNode } = { input: null, sink };
		captureNodes.set(ctx, captureInfo);

		const url = getWorkletUrl();
		if (url && ctx.audioWorklet) {
			ctx.audioWorklet
				.addModule(url)
				.then(() => {
					const node = new AudioWorkletNode(ctx, 'clopen-tap', {
						numberOfInputs: 1,
						numberOfOutputs: 1,
						outputChannelCount: [config.numberOfChannels],
						processorOptions: { blockSize: config.bufferSize }
					});
					node.port.onmessage = (event) => {
						encodeBlock(event.data.left, event.data.right, ctx.sampleRate);
					};
					node.connect(sink);
					captureInfo.input = node;
				})
				.catch(() => {
					// Blob worklets are blocked by strict CSP on some pages —
					// fall back to the legacy tap rather than losing audio.
					captureInfo.input = createScriptProcessorTap(ctx, sink);
				});
		} else {
			captureInfo.input = createScriptProcessorTap(ctx, sink);
		}

		return captureInfo;
	}

	/**
	 * Run `connect` once the tap node exists. Bounded: if the worklet module
	 * never loads and the fallback also failed, give up instead of polling for
	 * the lifetime of the page.
	 */
	function whenTapReady(
		captureInfo: { input: AudioNode | null },
		connect: (input: AudioNode) => void,
		attempt = 0
	) {
		if (captureInfo.input) {
			try {
				connect(captureInfo.input);
			} catch (e) {}
			return;
		}
		if (attempt >= 40) return; // ~2s
		setTimeout(() => whenTapReady(captureInfo, connect, attempt + 1), 50);
	}

	function createScriptProcessorTap(ctx: AudioContext, sink: GainNode): AudioNode | null {
		try {
			const processor = ctx.createScriptProcessor(
				config.bufferSize,
				config.numberOfChannels,
				config.numberOfChannels
			);

			processor.onaudioprocess = (event: AudioProcessingEvent) => {
				if (!isCapturing) return;
				const left = event.inputBuffer.getChannelData(0);
				const right =
					event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : left;
				// Copy: the event buffers are reused by the audio thread.
				encodeBlock(new Float32Array(left), new Float32Array(right), ctx.sampleRate);
			};

			processor.connect(sink);
			return processor;
		} catch (e) {
			return null;
		}
	}

	function interceptContext(ctx: AudioContext) {
		if (interceptedContexts.has(ctx)) return;
		interceptedContexts.add(ctx);

		// Resume AudioContext immediately — in headless Chrome without a user gesture,
		// AudioContext starts in 'suspended' state and rendering never runs.
		if (ctx.state === 'suspended') {
			ctx.resume().catch(() => {});
		}

		// Store original destination
		const originalDestination = ctx.destination;
		(ctx as any).__originalDestination = originalDestination;

		// Create a capture gain node that sits before the destination
		let captureGain: GainNode | null = null;
		try {
			captureGain = ctx.createGain();
			captureGain.gain.value = 1.0;

			// Audible path — unchanged, full gain, no added latency.
			captureGain.connect(originalDestination);

			// Side-chain tap for the encoder.
			const captureInfo = setupCaptureForContext(ctx, originalDestination);
			if (captureInfo) {
				// The tap node may appear asynchronously (worklet module load).
				const gain = captureGain;
				whenTapReady(captureInfo, (input) => gain.connect(input));
			}
		} catch (e) {
			return;
		}

		// Store references
		(ctx as any).__captureDestination = captureGain;

		// Override the destination getter to return our capture node
		try {
			Object.defineProperty(ctx, 'destination', {
				get: function() {
					return (this as any).__captureDestination || originalDestination;
				},
				configurable: true
			});
		} catch (e) {}
	}

	// Store original AudioContext BEFORE overriding
	const OriginalAudioContext = window.AudioContext || (window as any).webkitAudioContext;
	(window as any).__OriginalAudioContext = OriginalAudioContext;

	// Intercept AudioContext constructor
	if (OriginalAudioContext) {
		(window as any).AudioContext = function(...args: any[]) {
			const ctx = new OriginalAudioContext(...args);
			interceptContext(ctx);
			return ctx;
		};
		(window as any).AudioContext.prototype = OriginalAudioContext.prototype;
		Object.setPrototypeOf((window as any).AudioContext, OriginalAudioContext);
	}

	if ((window as any).webkitAudioContext) {
		(window as any).webkitAudioContext = (window as any).AudioContext;
	}

	// Capture audio from HTML5 media elements (video, audio)
	const mediaElementSources = new WeakMap();

	function captureMediaElement(element: HTMLMediaElement) {
		if (mediaElementSources.has(element)) return;

		try {
			// We need an AudioContext to capture from media element
			const OriginalCtor = (window as any).__OriginalAudioContext || window.AudioContext;
			const ctx = new OriginalCtor();

			// Resume context immediately — headless Chrome requires explicit resume
			if (ctx.state === 'suspended') {
				ctx.resume().catch(() => {});
			}

			// Create media element source
			const source = ctx.createMediaElementSource(element);

			// Audible path first so playback never depends on the tap.
			source.connect(ctx.destination);

			const captureInfo = setupCaptureForContext(ctx, ctx.destination);
			if (captureInfo) {
				whenTapReady(captureInfo, (input) => source.connect(input));
			}

			mediaElementSources.set(element, { ctx, source });
		} catch (error) {}
	}

	// Monitor for new media elements
	function setupMediaElementObserver() {
		// Capture existing media elements
		document.querySelectorAll('video, audio').forEach((el) => {
			captureMediaElement(el as HTMLMediaElement);
		});

		// Watch for new media elements
		const observer = new MutationObserver((mutations) => {
			mutations.forEach((mutation) => {
				mutation.addedNodes.forEach((node) => {
					if (node instanceof HTMLMediaElement) {
						captureMediaElement(node);
					}
					if (node instanceof Element) {
						node.querySelectorAll('video, audio').forEach((el) => {
							captureMediaElement(el as HTMLMediaElement);
						});
					}
				});
			});
		});

		observer.observe(document.documentElement, {
			childList: true,
			subtree: true
		});

		return observer;
	}

	// Expose functions globally
	(window as any).__audioEncoder = {
		init: initAudioEncoder,
		start: () => {
			isCapturing = true;
			// No timestampOffset needed - using performance.now() directly for each chunk
			// This aligns with video timestamps for proper AV sync
			// Start observing media elements when capture starts
			if (document.readyState === 'loading') {
				document.addEventListener('DOMContentLoaded', setupMediaElementObserver);
			} else {
				setupMediaElementObserver();
			}
			return true;
		},
		isSupported: () => (window as any).__audioEncoderSupported === true,
		isCapturing: () => isCapturing,
		getSampleCount: () => sampleCount,
		captureMedia: captureMediaElement,
		stop: () => {
			isCapturing = false;
			if (audioEncoder) {
				audioEncoder.flush().catch(() => {});
				audioEncoder.close();
				audioEncoder = null;
			}
			sampleCount = 0;
		}
	};
}
