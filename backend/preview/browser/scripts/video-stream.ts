/**
 * Video Encoder Client Script
 *
 * This script runs in the headless browser to:
 * 1. Initialize RTCPeerConnection with DataChannel
 * 2. Initialize VideoEncoder for encoding frames
 * 3. Handle WebRTC signaling (offer/answer/ICE)
 * 4. Send encoded video chunks via DataChannel
 *
 * Two capture modes feed the encoder:
 *
 * - **native** — `getDisplayMedia({preferCurrentTab})` + MediaStreamTrackProcessor.
 *   Compositor frames arrive as VideoFrame objects and go straight into the
 *   encoder. No JPEG encode, no base64, no CDP round-trip; the still-page
 *   refresh re-encodes the retained last frame, which is pristine.
 *   Requires a secure context, so it is probed and silently skipped otherwise.
 *
 * - **push** — the backend feeds base64 JPEG frames from `Page.screencastFrame`
 *   into `encodeFrame()`. Universal fallback; the still-page refresh comes from
 *   a high-quality screenshot pushed by the backend.
 *
 * Both modes share one encoder, one adaptive quality ladder and one wire format.
 */

import type { StreamingConfig, VideoCodecCandidate } from '../types';

/**
 * Generate video encoder script that runs in the browser
 */
export function videoEncoderScript(config: StreamingConfig['video']) {
	// WebCodecs Encoder for Headless Browser
	if ((window as any).__webCodecsPeer) {
		try {
			(window as any).__webCodecsPeer.stopStreaming();
		} catch (e) {}
		(window as any).__webCodecsPeer = null;
	}

	let peerConnection: RTCPeerConnection | null = null;
	let dataChannel: RTCDataChannel | null = null;
	let videoEncoder: VideoEncoder | null = null;
	let isCapturing = false;
	let videoFrameCount = 0;
	let audioFrameCount = 0;
	let lastKeyframeTime = 0;
	let forceNextKeyframe = false;
	let motionSeq = 0; // Increments per motion frame — used to detect staleness of deferred top-offs
	let topOffRetryTimer: any = null;

	// Active codec. `codecId` is embedded in every video packet so the client
	// picks the matching decoder; `activeCodec` also decides whether quality is
	// controlled per frame (quantizer mode) or by the configured bitrate.
	let activeCodec: VideoCodecCandidate = config.codecCandidates?.[config.codecCandidates.length - 1] || {
		codec: 'vp8',
		name: 'vp8',
		id: 0
	};
	let codecId = activeCodec.id;
	let usingQuantizer = false;

	// Encoder geometry. Kept in sync with whatever the capture source actually
	// produces — Chrome's screencast rounds `maxWidth/maxHeight` to preserve
	// aspect ratio, and tab-capture constraints are advisory, so the incoming
	// frame size is the authority rather than what we asked for.
	let encoderWidth = config.width;
	let encoderHeight = config.height;
	let currentBitrate = config.bitrate;
	let reconfiguring = false;

	// Adaptive framerate. The backend owns the ladder (it also sees the
	// viewer's decode queue) and pushes the target down here so native capture
	// can ask the compositor for fewer frames instead of discarding them.
	let targetFramerate = config.framerate;

	// Capture mode + retained frame for still-page refreshes in native mode.
	let captureMode: 'push' | 'native' = 'push';
	let nativeStream: MediaStream | null = null;
	let nativeTrack: MediaStreamTrack | null = null;
	let nativeReader: any = null;
	let lastNativeFrame: VideoFrame | null = null;
	let nativeIdleTimer: any = null;
	let lastNativeEncodeTime = 0;

	// Encoder cost tracking, reported back to the backend so the framerate
	// ladder reacts to CPU saturation and not just to network congestion.
	//
	// The cost that matters is the whole frame path on this thread — image
	// decode plus the encode call — not the encode call alone, which merely
	// enqueues and always measures near zero. And the queue is tracked as a
	// window maximum: sampling it once every couple of seconds says nothing
	// about whether the encoder is actually falling behind.
	let frameCostSamples = 0;
	let frameCostTotalMs = 0;
	let framesAttempted = 0;
	let framesSkippedEncoder = 0;
	let framesSkippedNetwork = 0;
	let framesEncodedWindow = 0;
	let encodeQueueMax = 0;
	let statsWindowStart = 0;
	let statsReportTimer: any = null;

	// Source-side backpressure threshold: when the DataChannel can't drain
	// (slow network), skip encoding motion frames instead of queueing them.
	// Kept SMALL (≈ 2-3 motion frames) on purpose: anything queued here is
	// display latency. Quality adapts to congestion via the quantizer ladder
	// (see currentMotionQuantizer) long before frames get skipped, so the
	// stream degrades to coarser-but-current rather than sharp-but-stale.
	const MAX_BUFFERED_BYTES = 64 * 1024;

	// Same idea for CPU: anything sitting in the encoder queue is latency the
	// viewer will see. Encoding is asynchronous, so a depth of one or two is
	// normal even on a fast host — the threshold has to sit above that or the
	// pipeline throws away frames it could comfortably have encoded.
	const MAX_ENCODE_QUEUE = 3;

	// Frames larger than this are split into fragments (packet type 2) to stay
	// well under the SCTP max-message-size (~256KB on common WebRTC stacks).
	// Mostly hit by near-lossless top-off keyframes of complex pages.
	const FRAGMENT_SIZE = 64 * 1024;

	// Frame sizes within this many pixels of the encoder are treated as the
	// same geometry and snapped, rather than triggering a reconfiguration.
	const SIZE_SNAP_TOLERANCE = 8;

	// How long the native capture track must be quiet before the retained
	// frame is re-encoded near-losslessly. Mirrors the backend's screencast
	// top-off delay so both modes sharpen at the same moment.
	const NATIVE_TOP_OFF_DELAY_MS = 300;

	// Cursor tracking
	let lastCursor = 'default';
	let cursorCheckInterval: any = null;

	// Public STUN lets the headless browser discover its public IP via srflx
	// candidates. Required when peers are on different machines/networks
	// (e.g. clopen deployed to Railway/VPS with the client browser elsewhere).
	// Host candidates still resolve first on same-machine setups, so the
	// happy path is not slowed.
	const iceServers: { urls: string }[] = [
		{ urls: 'stun:stun.l.google.com:19302' },
		{ urls: 'stun:stun1.l.google.com:19302' }
	];

	// Create a loopback (127.0.0.1) copy of a host ICE candidate.
	// Ensures WebRTC connects via loopback when VPN (e.g. Cloudflare WARP)
	// interferes with host candidate connectivity between same-machine peers.
	function createLoopbackCandidate(candidate: { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null }) {
		if (!candidate.candidate) return null;
		if (!candidate.candidate.includes('typ host')) return null;

		const parts = candidate.candidate.split(' ');
		if (parts.length < 8) return null;

		const address = parts[4];
		if (address === '127.0.0.1' || address === '::1') return null;

		parts[4] = '127.0.0.1';
		return { ...candidate, candidate: parts.join(' ') };
	}

	// Check cursor style from page
	function checkCursor() {
		try {
			const cursorInfo = (window as any).__cursorInfo;
			if (cursorInfo && cursorInfo.cursor && cursorInfo.cursor !== lastCursor) {
				lastCursor = cursorInfo.cursor;
				// Send cursor change to backend via exposed function
				if ((window as any).__sendCursorChange) {
					(window as any).__sendCursorChange(cursorInfo.cursor);
				}
			}
		} catch (e) {
			// Ignore errors - cursor tracking is non-critical
		}
	}

	// Start cursor tracking interval
	function startCursorTracking() {
		if (cursorCheckInterval) return;
		// Check cursor every 100ms (low overhead, responsive enough)
		cursorCheckInterval = setInterval(checkCursor, 100);
	}

	// Stop cursor tracking interval
	function stopCursorTracking() {
		if (cursorCheckInterval) {
			clearInterval(cursorCheckInterval);
			cursorCheckInterval = null;
		}
		lastCursor = 'default';
	}

	// Build encoder config for a codec candidate at the current geometry
	function buildEncoderConfig(candidate: VideoCodecCandidate, width: number, height: number, bitrate: number): VideoEncoderConfig {
		const base: any = {
			codec: candidate.codec,
			width,
			height,
			framerate: targetFramerate,
			hardwareAcceleration: config.hardwareAcceleration,
			latencyMode: config.latencyMode
		};

		if (candidate.annexb) {
			// Raw chunks travel without a `description`, so the stream has to
			// be self-describing. AVCC (Chrome's default) would be undecodable.
			base.avc = { format: 'annexb' };
		}

		if (candidate.quantizerKey) {
			// Quantizer mode: no bitrate — quality is chosen per frame in encode()
			base.bitrateMode = 'quantizer';
		} else {
			base.bitrate = bitrate;
			base.bitrateMode = 'variable';
		}

		return base as VideoEncoderConfig;
	}

	/**
	 * Pick the first codec candidate this browser can actually encode.
	 * The list arrives pre-ordered by the backend from the viewer's decode
	 * capabilities, so the first supported entry is also the best for the pair.
	 */
	async function detectVideoCodec(width: number, height: number, bitrate: number) {
		const candidates: VideoCodecCandidate[] =
			config.codecCandidates && config.codecCandidates.length > 0
				? config.codecCandidates
				: [{ codec: config.codec || 'vp8', name: 'vp8', id: 0 } as VideoCodecCandidate];

		for (const candidate of candidates) {
			const encoderConfig = buildEncoderConfig(candidate, width, height, bitrate);
			try {
				const support = await VideoEncoder.isConfigSupported(encoderConfig);
				if (support.supported) {
					activeCodec = candidate;
					codecId = candidate.id;
					usingQuantizer = !!candidate.quantizerKey;
					return encoderConfig;
				}
			} catch (e) {}
		}

		return null;
	}

	// Initialize RTCPeerConnection
	async function initPeerConnection() {
		if (peerConnection) {
			peerConnection.close();
		}

		peerConnection = new RTCPeerConnection({ iceServers });

		// Handle ICE candidates
		peerConnection.onicecandidate = (event) => {
			if (event.candidate && (window as any).__sendIceCandidate) {
				const candidateInit = {
					candidate: event.candidate.candidate,
					sdpMid: event.candidate.sdpMid,
					sdpMLineIndex: event.candidate.sdpMLineIndex
				};
				(window as any).__sendIceCandidate(candidateInit);

				// Also send loopback version for VPN compatibility (same-machine peers)
				const loopback = createLoopbackCandidate(candidateInit);
				if (loopback) {
					(window as any).__sendIceCandidate(loopback);
				}
			}
		};

		// Handle connection state
		peerConnection.onconnectionstatechange = () => {
			if ((window as any).__sendConnectionState && peerConnection) {
				(window as any).__sendConnectionState(peerConnection.connectionState);
			}
		};

		peerConnection.oniceconnectionstatechange = () => {};

		// Create DataChannel for encoded chunks.
		// Reliable + ordered: VP8/VP9/H.264 delta chains require in-order,
		// lossless delivery — a single lost/reordered chunk corrupts decoding
		// until the next keyframe (smearing/ghosting). Latency is bounded by
		// source-side frame dropping instead (see MAX_BUFFERED_BYTES).
		dataChannel = peerConnection.createDataChannel('media', {
			ordered: true
		});

		dataChannel.binaryType = 'arraybuffer';

		dataChannel.onopen = () => {
			// Force keyframe when DataChannel opens — the decoder on the other
			// side needs a sync point (keyframes are on-demand only)
			forceNextKeyframe = true;
		};

		dataChannel.onclose = () => {};

		dataChannel.onerror = (error) => {};

		return peerConnection;
	}

	// Initialize VideoEncoder
	async function initVideoEncoder() {
		const codecConfig = await detectVideoCodec(encoderWidth, encoderHeight, currentBitrate);
		if (!codecConfig) {
			throw new Error('No supported video codec');
		}

		videoEncoder = new VideoEncoder({
			output: (chunk, metadata) => {
				handleEncodedVideoChunk(chunk, metadata);
			},
			error: (e) => {}
		});

		await videoEncoder.configure(codecConfig);
	}

	/**
	 * Keep the encoder's geometry aligned with the frames actually arriving.
	 *
	 * The capture source is authoritative: CDP rounds screencast dimensions to
	 * preserve aspect ratio and tab-capture honours constraints only
	 * approximately, so asking for 648×406 can yield 648×405. Encoding a frame
	 * whose size differs from the configuration throws, which would stall the
	 * stream — reconfiguring on mismatch makes every rounding difference
	 * self-healing instead.
	 */
	async function ensureEncoderSize(width: number, height: number, tolerant = false): Promise<boolean> {
		if (!videoEncoder || width <= 0 || height <= 0) return false;
		if (width === encoderWidth && height === encoderHeight) return true;

		// A difference of a pixel or two is rounding, not a geometry change:
		// the screencast fits the viewport inside maxWidth/maxHeight while
		// preserving aspect ratio, and the still-page screenshot is clipped by
		// a single scalar, so the two can land a pixel apart on the same page.
		// Reconfiguring on that reset the encoder — and forced a keyframe plus
		// a client canvas resize — every time motion started or stopped.
		// Callers that pass `tolerant` snap the source instead (see snapSource).
		if (
			tolerant &&
			Math.abs(width - encoderWidth) <= SIZE_SNAP_TOLERANCE &&
			Math.abs(height - encoderHeight) <= SIZE_SNAP_TOLERANCE
		) {
			return true;
		}

		if (reconfiguring) return false;

		reconfiguring = true;
		try {
			encoderWidth = width;
			encoderHeight = height;
			currentBitrate = Math.max(400_000, Math.round(width * height * targetFramerate * 0.045));

			const encoderConfig = buildEncoderConfig(activeCodec, width, height, currentBitrate);
			videoEncoder.configure(encoderConfig);
			forceNextKeyframe = true;
			return true;
		} catch (e) {
			return false;
		} finally {
			reconfiguring = false;
		}
	}

	// Scratch surface used to snap an off-by-a-few-pixels source onto the
	// encoder's exact geometry. Only the still-page refresh normally needs it,
	// so this runs about once per still period, not per frame.
	let snapCanvas: OffscreenCanvas | null = null;
	let snapCtx: OffscreenCanvasRenderingContext2D | null = null;

	function snapSource(bitmap: ImageBitmap): CanvasImageSource {
		if (bitmap.width === encoderWidth && bitmap.height === encoderHeight) {
			return bitmap as unknown as CanvasImageSource;
		}

		try {
			if (!snapCanvas || snapCanvas.width !== encoderWidth || snapCanvas.height !== encoderHeight) {
				snapCanvas = new OffscreenCanvas(encoderWidth, encoderHeight);
				snapCtx = snapCanvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D | null;
			}
			if (!snapCtx) return bitmap as unknown as CanvasImageSource;

			snapCtx.drawImage(bitmap, 0, 0, encoderWidth, encoderHeight);
			return snapCanvas as unknown as CanvasImageSource;
		} catch (e) {
			return bitmap as unknown as CanvasImageSource;
		}
	}

	// Handle encoded video chunk
	function handleEncodedVideoChunk(chunk: EncodedVideoChunk, metadata: any) {
		if (!dataChannel || dataChannel.readyState !== 'open') return;

		const isKeyframe = chunk.type === 'key' ? 1 : 0;
		const timestamp = chunk.timestamp;
		const data = new Uint8Array(chunk.byteLength);
		chunk.copyTo(data);

		try {
			if (data.byteLength <= FRAGMENT_SIZE) {
				// Single packet
				// Format: [type=0(1)][timestamp(8)][keyframe(1)][codec(1)][size(4)][data]
				const packet = new ArrayBuffer(1 + 8 + 1 + 1 + 4 + data.byteLength);
				const view = new DataView(packet);
				const packetData = new Uint8Array(packet);

				// Type: 0 = video
				view.setUint8(0, 0);
				// Timestamp (microseconds)
				view.setBigUint64(1, BigInt(timestamp), true);
				// Keyframe flag
				view.setUint8(9, isKeyframe);
				// Codec: 0 = vp8, 1 = vp9, 2 = avc (lets the client pick the right decoder)
				view.setUint8(10, codecId);
				// Data size
				view.setUint32(11, data.byteLength, true);
				// Copy data
				packetData.set(data, 15);

				dataChannel.send(packet);
			} else {
				// Large frame (e.g. near-lossless top-off keyframe) — fragment.
				// The channel is reliable + ordered, so fragments arrive in order
				// and the client simply reassembles by index.
				// Format: [type=2(1)][timestamp(8)][keyframe(1)][codec(1)][fragIndex(2)][fragCount(2)][size(4)][data]
				const fragCount = Math.ceil(data.byteLength / FRAGMENT_SIZE);

				for (let i = 0; i < fragCount; i++) {
					const start = i * FRAGMENT_SIZE;
					const fragData = data.subarray(start, Math.min(start + FRAGMENT_SIZE, data.byteLength));

					const packet = new ArrayBuffer(1 + 8 + 1 + 1 + 2 + 2 + 4 + fragData.byteLength);
					const view = new DataView(packet);
					const packetData = new Uint8Array(packet);

					// Type: 2 = video fragment
					view.setUint8(0, 2);
					view.setBigUint64(1, BigInt(timestamp), true);
					view.setUint8(9, isKeyframe);
					view.setUint8(10, codecId);
					view.setUint16(11, i, true);
					view.setUint16(13, fragCount, true);
					view.setUint32(15, fragData.byteLength, true);
					packetData.set(fragData, 19);

					dataChannel.send(packet);
				}
			}

			videoFrameCount++;
		} catch (e) {}
	}

	// Send audio chunk (called from AudioContext interception)
	function sendAudioChunk(timestamp: number, data: Uint8Array) {
		if (!dataChannel || dataChannel.readyState !== 'open') return;

		// Backpressure: drop audio when the channel is congested — the client's
		// playback scheduler handles gaps cleanly, and stale audio is worthless
		if (dataChannel.bufferedAmount > MAX_BUFFERED_BYTES) return;

		// Format: [type(1)][timestamp(8)][size(4)][data]
		const packet = new ArrayBuffer(1 + 8 + 4 + data.byteLength);
		const view = new DataView(packet);
		const packetData = new Uint8Array(packet);

		// Type: 1 = audio
		view.setUint8(0, 1);
		// Timestamp (microseconds)
		view.setBigUint64(1, BigInt(timestamp), true);
		// Data size
		view.setUint32(9, data.byteLength, true);
		// Copy data
		packetData.set(data, 13);

		try {
			dataChannel.send(packet);
			audioFrameCount++;
		} catch (e) {}
	}

	// Congestion-adaptive motion quantizer: when the DataChannel is backing up
	// (slow network), spend fewer bits per frame instead of stalling. The
	// still-page top-off restores full quality once motion stops, so temporary
	// coarseness during congestion is invisible in the end result.
	function currentMotionQuantizer(): number {
		const buffered = dataChannel ? dataChannel.bufferedAmount : 0;
		if (buffered > MAX_BUFFERED_BYTES / 2) return Math.min(60, config.motionQuantizer + 16);
		if (buffered > MAX_BUFFERED_BYTES / 4) return Math.min(60, config.motionQuantizer + 8);
		return config.motionQuantizer;
	}

	/**
	 * Whether a motion frame should be skipped before any decode/encode work.
	 *
	 * Two independent limits, both of which mean "the viewer is already behind":
	 * the network can't drain the channel, or this host can't encode fast
	 * enough. Dropping input frames is safe — the encoder simply references the
	 * last encoded frame — whereas dropping encoded chunks would corrupt the
	 * delta chain.
	 */
	function shouldSkipMotionFrame(): boolean {
		framesAttempted++;

		if (dataChannel && dataChannel.bufferedAmount > MAX_BUFFERED_BYTES) {
			framesSkippedNetwork++;
			return true;
		}
		if (videoEncoder) {
			if (videoEncoder.encodeQueueSize > encodeQueueMax) {
				encodeQueueMax = videoEncoder.encodeQueueSize;
			}
			if (videoEncoder.encodeQueueSize >= MAX_ENCODE_QUEUE) {
				framesSkippedEncoder++;
				return true;
			}
		}
		return false;
	}

	/**
	 * Encode a VideoFrame with the right quality for its kind.
	 *
	 * In quantizer mode quality is per frame: coarse during motion (raised
	 * further under congestion), near-lossless for the still-page refresh. In
	 * fixed-bitrate mode (H.264, VP8) the same effect is achieved by briefly
	 * raising the target bitrate around the refresh keyframe, since there is no
	 * per-frame quality knob.
	 */
	function encodeVideoFrame(frame: VideoFrame, isTopOff: boolean) {
		if (!videoEncoder) return;

		const now = Date.now();
		const needsKeyframe =
			forceNextKeyframe ||
			(isTopOff && !usingQuantizer) ||
			(config.keyframeInterval > 0 && now - lastKeyframeTime > config.keyframeInterval * 1000);

		if (needsKeyframe) {
			lastKeyframeTime = now;
			forceNextKeyframe = false;
		}

		if (usingQuantizer && activeCodec.quantizerKey) {
			const quantizer = isTopOff ? config.topOffQuantizer : currentMotionQuantizer();
			const options: any = { keyFrame: needsKeyframe };
			options[activeCodec.quantizerKey] = { quantizer };
			videoEncoder.encode(frame, options as VideoEncoderEncodeOptions);
		} else {
			// Fixed-bitrate codec. The still-page refresh is a plain keyframe:
			// VBR already spends far more on keyframes than on deltas, and
			// reconfiguring the encoder to bump the bitrate around it resets
			// the codec twice per still period — on a page with any recurring
			// damage (a blinking caret is enough) that is a reset storm.
			videoEncoder.encode(frame, { keyFrame: needsKeyframe || isTopOff });
		}

		videoFrameCount++;
		if (!isTopOff) framesEncodedWindow++;
	}

	/**
	 * Decode base64 into bytes.
	 *
	 * `Uint8Array.fromBase64` is a single native pass; the manual loop it
	 * replaces ran `charCodeAt` per byte, which at full-viewport resolution was
	 * millions of calls per second on the page's main thread.
	 */
	function base64ToBytes(input: string): Uint8Array<ArrayBuffer> {
		const fromBase64 = (Uint8Array as any).fromBase64;
		if (typeof fromBase64 === 'function') {
			try {
				return fromBase64.call(Uint8Array, input) as Uint8Array<ArrayBuffer>;
			} catch (e) {}
		}

		const binaryStr = atob(input);
		const len = binaryStr.length;
		const bytes = new Uint8Array(len);
		for (let i = 0; i < len; i++) {
			bytes[i] = binaryStr.charCodeAt(i);
		}
		return bytes;
	}

	// Encode video frame from image data (push mode).
	// Motion frames arrive as JPEG (CDP screencast); top-off frames arrive as
	// a high-quality screenshot when the page goes still, and are encoded
	// near-losslessly so the last motion-degraded frame doesn't stick.
	async function encodeFrame(imageData: string, isTopOff?: boolean, mimeType?: string) {
		if (!videoEncoder || !isCapturing) return;
		// Native capture owns the encoder — a stray pushed frame would fight it.
		if (captureMode === 'native' && !isTopOff) return;

		try {
			if (!isTopOff) {
				motionSeq++;
				if (shouldSkipMotionFrame()) return;
			} else if (dataChannel && dataChannel.bufferedAmount > MAX_BUFFERED_BYTES) {
				// Channel congested — dumping a large near-lossless frame on it
				// now would spike latency. Defer briefly; abandon if new motion
				// arrives (the backend captures a fresh top-off after the next
				// still period anyway).
				const seqAtCapture = motionSeq;
				if (topOffRetryTimer) clearTimeout(topOffRetryTimer);
				topOffRetryTimer = setTimeout(() => {
					topOffRetryTimer = null;
					if (motionSeq === seqAtCapture && isCapturing) {
						encodeFrame(imageData, true, mimeType);
					}
				}, 250);
				return;
			}

			const costStart = performance.now();
			const bytes = base64ToBytes(imageData);

			// Decode via createImageBitmap (avoids per-frame ImageDecoder
			// constructor/destructor overhead)
			const blob = new Blob([bytes], { type: mimeType || (isTopOff ? 'image/png' : 'image/jpeg') });
			const bitmap = await createImageBitmap(blob);

			if (!videoEncoder || !isCapturing) {
				bitmap.close();
				return;
			}

			// The source is authoritative for geometry (see ensureEncoderSize),
			// but only for real changes — small rounding differences are
			// snapped onto the current geometry instead.
			if (!(await ensureEncoderSize(bitmap.width, bitmap.height, true))) {
				bitmap.close();
				return;
			}

			// Get aligned timestamp in microseconds
			const timestamp = performance.now() * 1000;

			const frame = new VideoFrame(snapSource(bitmap), {
				timestamp,
				alpha: 'discard'
			});

			encodeVideoFrame(frame, !!isTopOff);

			// Close immediately to prevent memory leaks
			frame.close();
			bitmap.close();

			if (!isTopOff) {
				frameCostTotalMs += performance.now() - costStart;
				frameCostSamples++;
			}
		} catch (error) {}
	}

	// ------------------------------------------------------------------
	// Native capture (getDisplayMedia + MediaStreamTrackProcessor)
	// ------------------------------------------------------------------

	function retainNativeFrame(frame: VideoFrame) {
		if (lastNativeFrame) {
			try {
				lastNativeFrame.close();
			} catch (e) {}
		}
		try {
			lastNativeFrame = frame.clone();
		} catch (e) {
			lastNativeFrame = null;
		}
	}

	/**
	 * Still-page refresh for native capture.
	 *
	 * The retained frame came straight from the compositor, so re-encoding it
	 * near-losslessly is genuinely lossless relative to the source — no
	 * screenshot, no JPEG round-trip, no CDP traffic. Push mode can't do this:
	 * its retained frame would already carry JPEG artifacts.
	 */
	function scheduleNativeTopOff() {
		if (nativeIdleTimer) clearTimeout(nativeIdleTimer);
		nativeIdleTimer = setTimeout(() => {
			nativeIdleTimer = null;
			if (!isCapturing || !lastNativeFrame || !videoEncoder) return;
			if (dataChannel && dataChannel.bufferedAmount > MAX_BUFFERED_BYTES) {
				scheduleNativeTopOff();
				return;
			}
			try {
				encodeVideoFrame(lastNativeFrame, true);
			} catch (e) {}
		}, NATIVE_TOP_OFF_DELAY_MS);
	}

	async function readNativeFrames() {
		if (!nativeReader) return;

		while (isCapturing && nativeReader) {
			let result: any;
			try {
				result = await nativeReader.read();
			} catch (e) {
				break;
			}

			if (result.done) break;

			const frame: VideoFrame = result.value;
			try {
				// Secondary rate limit. The track is already constrained to
				// `targetFramerate`, so this only exists for a source that
				// ignores the constraint.
				//
				// The tolerance is essential: with the track delivering at
				// exactly the target, frame-to-frame jitter puts gaps a hair
				// under a full interval, and a threshold of one full interval
				// then rejects roughly every second frame — halving the frame
				// rate the viewer sees while every other counter still reads
				// perfectly healthy.
				const now = performance.now();
				const minInterval = 1000 / Math.max(1, targetFramerate);
				if (now - lastNativeEncodeTime < minInterval * 0.75) {
					continue;
				}

				if (shouldSkipMotionFrame()) continue;

				if (!(await ensureEncoderSize(frame.displayWidth, frame.displayHeight))) continue;

				const costStart = performance.now();
				lastNativeEncodeTime = now;
				motionSeq++;
				encodeVideoFrame(frame, false);
				retainNativeFrame(frame);
				scheduleNativeTopOff();

				frameCostTotalMs += performance.now() - costStart;
				frameCostSamples++;
			} catch (e) {
			} finally {
				try {
					frame.close();
				} catch (e) {}
			}
		}
	}

	/**
	 * Probe in-page capture. Returns false (quietly) whenever it isn't
	 * available so the backend falls back to the CDP screencast path:
	 * insecure origin, missing API, denied permission, or no frame in time.
	 */
	async function startNativeCapture(): Promise<boolean> {
		if (!config.nativeCapture) return false;
		if (captureMode === 'native') return true;
		if (!isCapturing) return false;

		try {
			// getDisplayMedia is gated on a secure context, and the preview
			// navigates to arbitrary URLs — plain-http targets simply use the
			// fallback path.
			if (!window.isSecureContext) return false;
			if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') return false;
			if (typeof (window as any).MediaStreamTrackProcessor !== 'function') return false;

			const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T | null> =>
				Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

			const stream = await withTimeout(
				navigator.mediaDevices.getDisplayMedia({
					video: {
						frameRate: { max: Math.max(1, targetFramerate) },
						width: { max: encoderWidth },
						height: { max: encoderHeight }
					},
					audio: false,
					// Chrome-only hints: capture this tab without a picker.
					preferCurrentTab: true,
					selfBrowserSurface: 'include',
					surfaceSwitching: 'exclude',
					systemAudio: 'exclude'
				} as any),
				2000
			);

			if (!stream) return false;

			const track = stream.getVideoTracks()[0];
			if (!track) {
				stream.getTracks().forEach((t) => t.stop());
				return false;
			}

			const processor = new (window as any).MediaStreamTrackProcessor({ track });
			nativeStream = stream;
			nativeTrack = track;
			nativeReader = processor.readable.getReader();
			captureMode = 'native';
			forceNextKeyframe = true;

			track.addEventListener('ended', () => {
				// The surface went away (navigation, tab teardown) — drop back
				// to push mode rather than freezing on the last frame.
				stopNativeCapture();
			});

			readNativeFrames();
			return true;
		} catch (e) {
			stopNativeCapture();
			return false;
		}
	}

	function stopNativeCapture() {
		captureMode = 'push';

		if (nativeIdleTimer) {
			clearTimeout(nativeIdleTimer);
			nativeIdleTimer = null;
		}

		if (nativeReader) {
			try {
				nativeReader.cancel();
			} catch (e) {}
			nativeReader = null;
		}

		if (nativeTrack) {
			try {
				nativeTrack.stop();
			} catch (e) {}
			nativeTrack = null;
		}

		if (nativeStream) {
			try {
				nativeStream.getTracks().forEach((t) => t.stop());
			} catch (e) {}
			nativeStream = null;
		}

		if (lastNativeFrame) {
			try {
				lastNativeFrame.close();
			} catch (e) {}
			lastNativeFrame = null;
		}
	}

	// ------------------------------------------------------------------
	// Adaptive controls driven by the backend
	// ------------------------------------------------------------------

	/**
	 * Apply a new framerate target. In native mode this is pushed down to the
	 * capture track so the compositor stops producing frames we would discard;
	 * in push mode the backend enforces it by withholding the screencast ack.
	 */
	function setTargetFramerate(fps: number) {
		const next = Math.max(1, Math.min(60, Math.round(fps)));
		if (next === targetFramerate) return;
		targetFramerate = next;

		if (nativeTrack) {
			try {
				nativeTrack.applyConstraints({ frameRate: { max: next } } as MediaTrackConstraints).catch(() => {});
			} catch (e) {}
		}
	}

	function reportEncoderStats() {
		const send = (window as any).__sendEncoderStats;
		if (typeof send !== 'function') return;

		const now = performance.now();
		const windowMs = statsWindowStart > 0 ? now - statsWindowStart : 0;
		statsWindowStart = now;

		try {
			send({
				captureMode,
				codec: activeCodec.name,
				avgFrameCostMs: frameCostSamples > 0 ? frameCostTotalMs / frameCostSamples : 0,
				encodeQueueMax,
				bufferedAmount: dataChannel ? dataChannel.bufferedAmount : 0,
				framesAttempted,
				framesSkippedEncoder,
				framesSkippedNetwork,
				// Frames per second the viewer actually receives. Every other
				// counter can read healthy while this quietly sits at half the
				// target, so it is the one number worth trusting.
				measuredFps: windowMs > 0 ? (framesEncodedWindow * 1000) / windowMs : 0,
				width: encoderWidth,
				height: encoderHeight
			});
		} catch (e) {}

		frameCostSamples = 0;
		frameCostTotalMs = 0;
		framesAttempted = 0;
		framesSkippedEncoder = 0;
		framesSkippedNetwork = 0;
		framesEncodedWindow = 0;
		encodeQueueMax = 0;
	}

	// Force the next encoded frame to be a keyframe (client-driven sync point,
	// PLI equivalent — used when the client decoder errors or joins mid-stream)
	function forceKeyframe() {
		forceNextKeyframe = true;
		// On a still page nothing new will be encoded, so nudge the retained
		// frame out immediately when we have one.
		if (captureMode === 'native' && lastNativeFrame && videoEncoder) {
			try {
				encodeVideoFrame(lastNativeFrame, true);
			} catch (e) {}
		}
	}

	// Start streaming
	async function startStreaming() {
		if (isCapturing) return true;

		try {
			await initPeerConnection();
			await initVideoEncoder();

			isCapturing = true;
			// Force first frame as keyframe (required for decoder init)
			forceNextKeyframe = true;

			// Start tracking cursor changes
			startCursorTracking();

			if (statsReportTimer) clearInterval(statsReportTimer);
			statsReportTimer = setInterval(reportEncoderStats, 2000);

			return true;
		} catch (error) {
			isCapturing = false;
			return false;
		}
	}

	// Stop streaming
	function stopStreaming() {
		isCapturing = false;

		// Cancel any deferred top-off retry
		if (topOffRetryTimer) {
			clearTimeout(topOffRetryTimer);
			topOffRetryTimer = null;
		}

		if (statsReportTimer) {
			clearInterval(statsReportTimer);
			statsReportTimer = null;
		}

		stopNativeCapture();

		// Stop cursor tracking
		stopCursorTracking();

		if (videoEncoder) {
			try {
				videoEncoder.flush();
				videoEncoder.close();
			} catch (e) {}
			videoEncoder = null;
		}

		if (dataChannel) {
			dataChannel.close();
			dataChannel = null;
		}

		if (peerConnection) {
			peerConnection.close();
			peerConnection = null;
		}
	}

	// Create and send offer
	async function createOffer() {
		if (!peerConnection) {
			await initPeerConnection();
		}

		try {
			const offer = await peerConnection!.createOffer();
			await peerConnection!.setLocalDescription(offer);

			return {
				type: offer.type,
				sdp: offer.sdp
			};
		} catch (error) {
			return null;
		}
	}

	// Handle answer from client
	async function handleAnswer(answer: RTCSessionDescriptionInit) {
		if (!peerConnection) return false;

		try {
			await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
			return true;
		} catch (error) {
			return false;
		}
	}

	// Add ICE candidate (+ loopback variant for VPN compatibility)
	async function addIceCandidate(candidate: RTCIceCandidateInit) {
		if (!peerConnection) return false;

		try {
			await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
		} catch (error) {
			return false;
		}

		// Also try loopback version for VPN compatibility (same-machine peers)
		const loopback = createLoopbackCandidate(candidate);
		if (loopback) {
			try {
				await peerConnection.addIceCandidate(new RTCIceCandidate(loopback as RTCIceCandidateInit));
			} catch {
				// Expected to fail if loopback is not applicable
			}
		}

		return true;
	}

	// Reconfigure video encoder with new dimensions (hot-swap)
	async function reconfigureEncoder(newWidth: number, newHeight: number, newBitrate?: number) {
		if (!videoEncoder || !isCapturing) {
			return false;
		}

		try {
			// Flush pending frames
			await videoEncoder.flush();

			currentBitrate = newBitrate || currentBitrate;
			const newCodecConfig = buildEncoderConfig(activeCodec, newWidth, newHeight, currentBitrate);

			const support = await VideoEncoder.isConfigSupported(newCodecConfig);
			if (!support.supported) {
				return false;
			}

			videoEncoder.configure(newCodecConfig);

			encoderWidth = newWidth;
			encoderHeight = newHeight;
			config.width = newWidth;
			config.height = newHeight;

			// Native capture has to be told separately — its frame size comes
			// from track constraints, not from the encoder.
			if (nativeTrack) {
				try {
					nativeTrack
						.applyConstraints({
							width: { max: newWidth },
							height: { max: newHeight },
							frameRate: { max: targetFramerate }
						} as MediaTrackConstraints)
						.catch(() => {});
				} catch (e) {}
			}

			// Force keyframe after reconfigure (decoder needs a sync point at the new dimensions)
			forceNextKeyframe = true;

			return true;
		} catch (error) {
			return false;
		}
	}

	// Get stats
	async function getStats() {
		if (!peerConnection) return null;

		try {
			const stats = await peerConnection.getStats();
			const result = {
				videoBytesSent: 0,
				audioBytesSent: 0,
				videoFramesEncoded: videoFrameCount,
				audioFramesEncoded: audioFrameCount,
				connectionState: peerConnection.connectionState,
				videoCodec: activeCodec.name,
				audioCodec: 'opus' as const,
				captureMode
			};

			stats.forEach(report => {
				if (report.type === 'data-channel') {
					result.videoBytesSent = (report as any).bytesSent || 0;
				}
			});

			return result;
		} catch (error) {
			return null;
		}
	}

	// Expose API
	(window as any).__webCodecsPeer = {
		startStreaming,
		stopStreaming,
		createOffer,
		handleAnswer,
		addIceCandidate,
		encodeFrame,
		forceKeyframe,
		sendAudioChunk,
		getStats,
		reconfigureEncoder,
		startNativeCapture,
		stopNativeCapture,
		setTargetFramerate,
		getCaptureMode: () => captureMode,
		isActive: () => isCapturing
	};
}
