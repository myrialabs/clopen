/**
 * Audio Capture Client Script
 *
 * This script runs in the headless browser to capture all audio from:
 * - AudioContext API
 * - HTML5 media elements (video, audio tags)
 *
 * Audio is encoded with AudioEncoder (Opus codec) and sent via DataChannel
 * to the WebCodecs peer connection.
 */

import type { StreamingConfig } from '../types';

/**
 * Generate audio capture script that runs in the browser
 * This script intercepts AudioContext and captures all audio
 */
export function audioCaptureScript(config: StreamingConfig['audio']) {
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

	// Initialize audio encoder
	async function initAudioEncoder() {
		if (audioEncoder && audioEncoder.state === 'configured') {
			return true;
		}

		try {
			audioEncoder = new AudioEncoder({
				output: (chunk: EncodedAudioChunk) => {
					// Send audio chunk directly via __webCodecsPeer DataChannel
					const peer = (window as any).__webCodecsPeer;
					if (!peer || !peer.isActive()) {
						return;
					}

					const data = new Uint8Array(chunk.byteLength);
					chunk.copyTo(data);

					// Send via the same DataChannel used for video
					peer.sendAudioChunk(chunk.timestamp, data);
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

	// Create capture nodes for an AudioContext
	function setupCaptureForContext(ctx: AudioContext) {
		if (captureNodes.has(ctx)) return captureNodes.get(ctx);

		try {
			// Create a script processor to capture audio
			const processor = ctx.createScriptProcessor(config.bufferSize, config.numberOfChannels, config.numberOfChannels);

			processor.onaudioprocess = (event: AudioProcessingEvent) => {
				if (!isCapturing || !audioEncoder || audioEncoder.state !== 'configured') {
					// Pass through audio unchanged
					for (let ch = 0; ch < event.outputBuffer.numberOfChannels; ch++) {
						const input = event.inputBuffer.getChannelData(ch);
						const output = event.outputBuffer.getChannelData(ch);
						output.set(input);
					}
					return;
				}

				try {
					const left = event.inputBuffer.getChannelData(0);
					const right = event.inputBuffer.numberOfChannels > 1
						? event.inputBuffer.getChannelData(1)
						: left;

					// Pass through to output
					event.outputBuffer.getChannelData(0).set(left);
					if (event.outputBuffer.numberOfChannels > 1) {
						event.outputBuffer.getChannelData(1).set(right);
					}

					// Check if there's any audio (not silence)
					let hasAudio = false;
					for (let i = 0; i < left.length; i += 64) {
						if (Math.abs(left[i]) > 0.0001 || Math.abs(right[i]) > 0.0001) {
							hasAudio = true;
							break;
						}
					}

					if (!hasAudio) return;

					// Use performance.now() directly (same as video) for proper AV sync
					// Both video and audio now use the same timestamp origin
					const timestamp = performance.now() * 1000; // microseconds

					// Create AudioData with planar format
					const audioData = new AudioData({
						format: 'f32-planar',
						sampleRate: ctx.sampleRate,
						numberOfFrames: left.length,
						numberOfChannels: config.numberOfChannels,
						timestamp: timestamp,
						data: new Float32Array([...left, ...right])
					});

					audioEncoder!.encode(audioData);
					audioData.close();

					sampleCount += left.length;
				} catch (error) {
					// Silent fail to not interrupt audio
				}
			};

			const captureInfo = { processor };
			captureNodes.set(ctx, captureInfo);

			return captureInfo;
		} catch (error) {
			return null;
		}
	}

	function interceptContext(ctx: AudioContext) {
		if (interceptedContexts.has(ctx)) return;
		interceptedContexts.add(ctx);

		// Store original destination
		const originalDestination = ctx.destination;

		// Create a capture gain node that sits before the destination
		let captureGain: GainNode | null = null;
		try {
			captureGain = ctx.createGain();
			captureGain.gain.value = 1.0;

			// Setup capture processor connected to this gain
			const captureInfo = setupCaptureForContext(ctx);
			if (captureInfo) {
				captureGain.connect(captureInfo.processor);
				captureInfo.processor.connect(originalDestination);
			}
			captureGain.connect(originalDestination);
		} catch (e) {
			return;
		}

		// Store references
		(ctx as any).__captureDestination = captureGain;
		(ctx as any).__originalDestination = originalDestination;

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
			const OriginalAudioContext = (window as any).__OriginalAudioContext || window.AudioContext;
			const ctx = new OriginalAudioContext();

			// Create media element source
			const source = ctx.createMediaElementSource(element);

			// Create capture chain
			const captureInfo = setupCaptureForContext(ctx);
			if (captureInfo) {
				source.connect(captureInfo.processor);
				captureInfo.processor.connect(ctx.destination);
			} else {
				source.connect(ctx.destination);
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
