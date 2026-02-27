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

	// Cursor tracking
	let lastCursor = 'default';
	let cursorCheckInterval: any = null;

	// ICE servers
	const iceServers = [
		{ urls: 'stun:stun.l.google.com:19302' },
		{ urls: 'stun:stun1.l.google.com:19302' }
	];

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

	// Detect supported video codec
	async function detectVideoCodec() {
		const codecConfig: VideoEncoderConfig = {
			codec: config.codec,
			width: config.width,
			height: config.height,
			bitrate: config.bitrate,
			framerate: config.framerate,
			hardwareAcceleration: config.hardwareAcceleration,
			latencyMode: config.latencyMode
		};

		try {
			const support = await VideoEncoder.isConfigSupported(codecConfig);
			if (support.supported) {
				return codecConfig;
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
				(window as any).__sendIceCandidate({
					candidate: event.candidate.candidate,
					sdpMid: event.candidate.sdpMid,
					sdpMLineIndex: event.candidate.sdpMLineIndex
				});
			}
		};

		// Handle connection state
		peerConnection.onconnectionstatechange = () => {
			if ((window as any).__sendConnectionState && peerConnection) {
				(window as any).__sendConnectionState(peerConnection.connectionState);
			}
		};

		peerConnection.oniceconnectionstatechange = () => {};

		// Create DataChannel for encoded chunks
		dataChannel = peerConnection.createDataChannel('media', {
			ordered: false, // Allow out-of-order delivery for lower latency
			maxRetransmits: 0 // No retransmits = lower latency
		});

		dataChannel.binaryType = 'arraybuffer';

		dataChannel.onopen = () => {
			// Force keyframe when DataChannel opens (previous keyframes may have been lost)
			lastKeyframeTime = 0;
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

		// Send chunk via DataChannel
		// Format: [type(1)][timestamp(8)][keyframe(1)][size(4)][data]
		const isKeyframe = chunk.type === 'key' ? 1 : 0;
		const timestamp = chunk.timestamp;
		const data = new Uint8Array(chunk.byteLength);
		chunk.copyTo(data);

		const packet = new ArrayBuffer(1 + 8 + 1 + 4 + data.byteLength);
		const view = new DataView(packet);
		const packetData = new Uint8Array(packet);

		// Type: 0 = video
		view.setUint8(0, 0);
		// Timestamp (microseconds)
		view.setBigUint64(1, BigInt(timestamp), true);
		// Keyframe flag
		view.setUint8(9, isKeyframe);
		// Data size
		view.setUint32(10, data.byteLength, true);
		// Copy data
		packetData.set(data, 14);

		try {
			dataChannel.send(packet);
			videoFrameCount++;
		} catch (e) {}
	}

	// Send audio chunk (called from AudioContext interception)
	function sendAudioChunk(timestamp: number, data: Uint8Array) {
		if (!dataChannel || dataChannel.readyState !== 'open') return;

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

	// Encode video frame from JPEG data
	async function encodeFrame(imageData: string) {
		if (!videoEncoder || !isCapturing) return;

		try {
			// Base64 to arrayBuffer (more efficient)
			const imageBuffer = await fetch(`data:image/jpeg;base64,${imageData}`);
			const arrayBuffer = await imageBuffer.arrayBuffer();

			// Decode JPEG to VideoFrame
			const decoder = new ImageDecoder({
				data: arrayBuffer,
				type: 'image/jpeg',
			});

			const { image } = await decoder.decode();

			// Get aligned timestamp in microseconds
			const timestamp = performance.now() * 1000;

			// Create VideoFrame with aligned timestamp
			const frame = new VideoFrame(image, {
				timestamp,
				alpha: 'discard'
			});

			// Check if keyframe needed
			const now = Date.now();
			const needsKeyframe = (now - lastKeyframeTime) > (config.keyframeInterval * 1000);

			if (needsKeyframe) {
				lastKeyframeTime = now;
			}

			// Encode frame
			videoEncoder.encode(frame, { keyFrame: needsKeyframe });
			videoFrameCount++;

			// Close immediately to prevent memory leaks
			frame.close();
			image.close();
			decoder.close();
		} catch (error) {}
	}

	// Start streaming
	async function startStreaming() {
		if (isCapturing) return true;

		try {
			await initPeerConnection();
			await initVideoEncoder();

			isCapturing = true;
			// Set to 0 to force first frame as keyframe (required for decoder init)
			lastKeyframeTime = 0;

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

	// Add ICE candidate
	async function addIceCandidate(candidate: RTCIceCandidateInit) {
		if (!peerConnection) return false;

		try {
			await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
			return true;
		} catch (error) {
			return false;
		}
	}

	// Reconfigure video encoder with new dimensions (hot-swap)
	async function reconfigureEncoder(newWidth: number, newHeight: number) {
		if (!videoEncoder || !isCapturing) {
			return false;
		}

		try {
			// Flush pending frames
			await videoEncoder.flush();

			// Create new codec config with updated dimensions
			const newCodecConfig: VideoEncoderConfig = {
				codec: config.codec,
				width: newWidth,
				height: newHeight,
				bitrate: config.bitrate,
				framerate: config.framerate,
				hardwareAcceleration: config.hardwareAcceleration,
				latencyMode: config.latencyMode
			};

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

			// Reset keyframe timer to force keyframe after reconfigure
			lastKeyframeTime = 0;

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
				videoCodec: config.codec,
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
		sendAudioChunk,
		getStats,
		reconfigureEncoder,
		isActive: () => isCapturing
	};
}
