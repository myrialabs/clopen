/**
 * Video Encoder Client Script
 *
 * This script runs in the headless browser to:
 * 1. Initialize RTCPeerConnection with DataChannel
 * 2. Initialize VideoEncoder for encoding frames
 * 3. Handle WebRTC signaling (offer/answer/ICE)
 * 4. Send encoded video chunks via DataChannel
 */

import type { StreamingConfig } from '../types';

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

	// Codec selection: prefer VP9 in quantizer mode (per-frame quality control,
	// Chrome-Remote-Desktop-style), fall back to VP8 with fixed bitrate.
	// codecId is embedded in every video packet so the client picks the right decoder.
	// vp9Allowed comes from the CLIENT (decode capability, negotiated at stream
	// start) — the headless browser can encode VP9, but the viewer must decode it.
	let codecId = 0; // 0 = vp8, 1 = vp9
	let usingQuantizer = false;
	let vp9Allowed = true;

	// Source-side backpressure threshold: when the DataChannel can't drain
	// (slow network), skip encoding motion frames instead of queueing them.
	// Kept SMALL (≈ 2-3 motion frames) on purpose: anything queued here is
	// display latency. Quality adapts to congestion via the quantizer ladder
	// (see currentMotionQuantizer) long before frames get skipped, so the
	// stream degrades to coarser-but-current rather than sharp-but-stale.
	const MAX_BUFFERED_BYTES = 64 * 1024;

	// Frames larger than this are split into fragments (packet type 2) to stay
	// well under the SCTP max-message-size (~256KB on common WebRTC stacks).
	// Mostly hit by near-lossless top-off keyframes of complex pages.
	const FRAGMENT_SIZE = 64 * 1024;

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

	// Build encoder config for the currently selected codec mode
	function buildEncoderConfig(width: number, height: number, bitrate?: number): VideoEncoderConfig {
		if (usingQuantizer) {
			// Quantizer mode: no bitrate — quality is controlled per-frame in encode()
			return {
				codec: 'vp09.00.10.08',
				width,
				height,
				framerate: config.framerate,
				bitrateMode: 'quantizer',
				hardwareAcceleration: config.hardwareAcceleration,
				latencyMode: config.latencyMode
			} as VideoEncoderConfig;
		}

		return {
			codec: config.codec,
			width,
			height,
			bitrate: bitrate || config.bitrate,
			framerate: config.framerate,
			hardwareAcceleration: config.hardwareAcceleration,
			latencyMode: config.latencyMode
		};
	}

	// Detect supported video codec — prefer VP9 quantizer mode, fall back to VP8
	async function detectVideoCodec() {
		if (vp9Allowed) {
			usingQuantizer = true;
			codecId = 1;
			const vp9Config = buildEncoderConfig(config.width, config.height);
			try {
				const support = await VideoEncoder.isConfigSupported(vp9Config);
				if (support.supported) {
					return vp9Config;
				}
			} catch (e) {}
		}

		usingQuantizer = false;
		codecId = 0;
		const vp8Config = buildEncoderConfig(config.width, config.height);
		try {
			const support = await VideoEncoder.isConfigSupported(vp8Config);
			if (support.supported) {
				return vp8Config;
			}
		} catch (e) {}

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
		// Reliable + ordered: VP8/VP9 delta chains require in-order, lossless
		// delivery — a single lost/reordered chunk corrupts decoding until the
		// next keyframe (smearing/ghosting). Latency is bounded by source-side
		// frame dropping instead (see MAX_BUFFERED_BYTES backpressure).
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
		const codecConfig = await detectVideoCodec();
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
				// Codec: 0 = vp8, 1 = vp9 (lets the client pick the right decoder)
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

	// Encode video frame from image data.
	// Motion frames arrive as JPEG (CDP screencast); top-off frames arrive as
	// lossless PNG (Page.captureScreenshot) when the page goes still, and are
	// encoded near-losslessly so the last motion-degraded frame doesn't stick.
	async function encodeFrame(imageData: string, isTopOff?: boolean) {
		if (!videoEncoder || !isCapturing) return;

		try {
			// Source-side backpressure: if the network can't drain the channel,
			// skip motion frames BEFORE decoding/encoding. Dropping input frames
			// is safe (the encoder just references the last encoded frame);
			// dropping encoded chunks would corrupt the delta chain.
			if (!isTopOff) {
				motionSeq++;
				if (dataChannel && dataChannel.bufferedAmount > MAX_BUFFERED_BYTES) {
					return;
				}
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
						encodeFrame(imageData, true);
					}
				}, 250);
				return;
			}

			// Direct base64 decode (avoids fetch() + data URL parsing overhead)
			const binaryStr = atob(imageData);
			const len = binaryStr.length;
			const bytes = new Uint8Array(len);
			for (let i = 0; i < len; i++) {
				bytes[i] = binaryStr.charCodeAt(i);
			}

			// Decode via createImageBitmap (avoids per-frame ImageDecoder
			// constructor/destructor overhead)
			const blob = new Blob([bytes], { type: isTopOff ? 'image/png' : 'image/jpeg' });
			const bitmap = await createImageBitmap(blob);

			// Get aligned timestamp in microseconds
			const timestamp = performance.now() * 1000;

			// Create VideoFrame from ImageBitmap
			const frame = new VideoFrame(bitmap, {
				timestamp,
				alpha: 'discard'
			});

			// Keyframes are on-demand only (stream start, reconnect, reconfigure,
			// client request) — the channel is reliable so no periodic keyframes
			// are needed. keyframeInterval > 0 re-enables a periodic timer.
			const now = Date.now();
			const needsKeyframe = forceNextKeyframe ||
				(config.keyframeInterval > 0 && (now - lastKeyframeTime) > (config.keyframeInterval * 1000));

			if (needsKeyframe) {
				lastKeyframeTime = now;
				forceNextKeyframe = false;
			}

			// Encode frame — in quantizer mode, quality is chosen per frame:
			// cheap during motion (raised further under congestion),
			// near-lossless for still-page top-off refreshes
			if (usingQuantizer) {
				const quantizer = isTopOff ? config.topOffQuantizer : currentMotionQuantizer();
				videoEncoder.encode(frame, {
					keyFrame: needsKeyframe,
					vp9: { quantizer }
				} as VideoEncoderEncodeOptions);
			} else {
				videoEncoder.encode(frame, { keyFrame: needsKeyframe });
			}
			videoFrameCount++;

			// Close immediately to prevent memory leaks
			frame.close();
			bitmap.close();
		} catch (error) {}
	}

	// Force the next encoded frame to be a keyframe (client-driven sync point,
	// PLI equivalent — used when the client decoder errors or joins mid-stream)
	function forceKeyframe() {
		forceNextKeyframe = true;
	}

	// Start streaming
	// allowVp9: client decode capability negotiated at stream start
	async function startStreaming(allowVp9?: boolean) {
		if (isCapturing) return true;

		vp9Allowed = allowVp9 !== false;

		try {
			await initPeerConnection();
			await initVideoEncoder();

			isCapturing = true;
			// Force first frame as keyframe (required for decoder init)
			forceNextKeyframe = true;

			// Start tracking cursor changes
			startCursorTracking();

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

			// Create new codec config with updated dimensions (keeps current codec mode)
			const newCodecConfig = buildEncoderConfig(newWidth, newHeight, newBitrate);

			// Check if new config is supported
			const support = await VideoEncoder.isConfigSupported(newCodecConfig);
			if (!support.supported) {
				return false;
			}

			// Reconfigure encoder with new dimensions
			await videoEncoder.configure(newCodecConfig);

			// Update config reference
			config.width = newWidth;
			config.height = newHeight;
			if (newBitrate) {
				config.bitrate = newBitrate;
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
				videoCodec: usingQuantizer ? 'vp9' : config.codec,
				audioCodec: 'opus' as const
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
		isActive: () => isCapturing
	};
}
