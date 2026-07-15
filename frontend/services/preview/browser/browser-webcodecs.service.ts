/**
 * Browser WebCodecs Service
 *
 * Client-side service for receiving WebCodecs-encoded video/audio via DataChannel.
 * Achieves ultra low-latency (~20-40ms) with lower bandwidth than traditional WebRTC.
 *
 * Flow:
 * 1. Request offer from server (headless browser creates offer with DataChannel)
 * 2. Create RTCPeerConnection and set remote description (offer)
 * 3. Create and send answer
 * 4. Exchange ICE candidates
 * 5. Receive encoded chunks via DataChannel
 * 6. Decode with VideoDecoder + AudioDecoder
 * 7. Render video to canvas, play audio
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

export interface BrowserWebCodecsStreamStats {
	isConnected: boolean;
	connectionState: RTCPeerConnectionState;
	iceConnectionState: RTCIceConnectionState;
	videoBytesReceived: number;
	audioBytesReceived: number;
	videoFramesReceived: number;
	audioFramesReceived: number;
	videoFramesDecoded: number;
	audioFramesDecoded: number;
	videoFramesDropped: number;
	audioFramesDropped: number;
	frameWidth: number;
	frameHeight: number;
	// Bandwidth stats
	videoBitrate: number; // bits per second
	audioBitrate: number; // bits per second
	totalBitrate: number; // bits per second
	totalBandwidthMBps: number; // MB per second
	// Codec info
	videoCodec: string;
	audioCodec: string;
	// First frame status
	firstFrameRendered: boolean;
}

export class BrowserWebCodecsService {
	private projectId: string; // REQUIRED for project isolation
	private sessionId: string | null = null;
	private peerConnection: RTCPeerConnection | null = null;
	private dataChannel: RTCDataChannel | null = null;
	private videoDecoder: VideoDecoder | null = null;
	private audioDecoder: AudioDecoder | null = null;
	private audioContext: AudioContext | null = null;
	private canvas: HTMLCanvasElement | null = null;
	private ctx: CanvasRenderingContext2D | null = null;
	private isConnected = false;
	private isCleaningUp = false;

	// Frame rendering optimization with timestamp-based scheduling
	private pendingFrame: VideoFrame | null = null;
	private isRenderingFrame = false;
	private renderFrameId: number | null = null;
	private lastFrameTime = 0;
	private startTime = 0;
	private firstFrameTimestamp = 0; // Timestamp of first frame (for relative timing)

	// AV Sync: Shared timeline reference
	// When first video frame arrives, we establish: realTime = streamTimestamp mapping
	private syncEstablished = false;
	private syncRealTimeOrigin = 0; // performance.now() when first video frame decoded
	private syncStreamTimestamp = 0; // stream timestamp of first video frame (microseconds)
	private lastVideoTimestamp = 0; // Last rendered video timestamp for audio sync
	private lastVideoRealTime = 0; // performance.now() when last video frame was rendered

	// Audio playback scheduling
	private nextAudioPlayTime = 0; // When the next audio chunk should play
	private audioBufferQueue: Array<{ buffer: AudioBuffer; scheduledTime: number }> = [];
	private maxAudioQueueSize = 10; // Limit queue to prevent audio lag
	private audioSyncInitialized = false; // Track if audio sync is initialized
	private audioCalibrationSamples = 0; // Count calibration samples for initial sync
	private audioOffsetAccumulator = 0; // Accumulate offset during calibration
	private readonly CALIBRATION_SAMPLES = 5; // Number of samples needed for calibration
	private calibratedAudioOffset = 0; // Final calibrated offset in seconds

	// Codec configuration
	private videoCodecConfig: VideoDecoderConfig | null = null;
	private audioCodecConfig: AudioDecoderConfig | null = null;
	private activeCodecId = -1; // Codec of the current decoder (0 = vp8, 1 = vp9)
	private lastKeyframeRequestTime = 0; // Throttle for requestKeyframe (PLI equivalent)

	// Reassembly of fragmented video frames (packet type 2 — large frames,
	// e.g. near-lossless top-off keyframes, split to fit SCTP message limits)
	private fragmentBuffer: Uint8Array[] | null = null;
	private fragmentTimestamp = 0;

	// Stats tracking
	private stats: BrowserWebCodecsStreamStats = {
		isConnected: false,
		connectionState: 'new',
		iceConnectionState: 'new',
		videoBytesReceived: 0,
		audioBytesReceived: 0,
		videoFramesReceived: 0,
		audioFramesReceived: 0,
		videoFramesDecoded: 0,
		audioFramesDecoded: 0,
		videoFramesDropped: 0,
		audioFramesDropped: 0,
		frameWidth: 0,
		frameHeight: 0,
		videoBitrate: 0,
		audioBitrate: 0,
		totalBitrate: 0,
		totalBandwidthMBps: 0,
		videoCodec: 'unknown',
		audioCodec: 'unknown',
		firstFrameRendered: false
	};

	// Bandwidth tracking
	private lastVideoBytesReceived = 0;
	private lastAudioBytesReceived = 0;
	private lastStatsTime = 0;

	// Public STUN lets the client discover its public IP via srflx candidates.
	// Required when peers are on different machines/networks (e.g. clopen
	// deployed to Railway/VPS with the client browser elsewhere). Host
	// candidates still resolve first on same-machine setups.
	private readonly iceServers: RTCIceServer[] = [
		{ urls: 'stun:stun.l.google.com:19302' },
		{ urls: 'stun:stun1.l.google.com:19302' }
	];

	// Callbacks
	private onConnectionChange: ((connected: boolean) => void) | null = null;
	private onConnectionFailed: (() => void) | null = null;
	private onNavigationReconnect: (() => void) | null = null; // Fast reconnection after navigation
	private onReconnectingStart: (() => void) | null = null; // Signals reconnecting state started (for UI)
	private onFirstFrame: (() => void) | null = null; // Fires immediately when first frame is decoded
	private onError: ((error: Error) => void) | null = null;
	private onStats: ((stats: BrowserWebCodecsStreamStats) => void) | null = null;
	private onCursorChange: ((cursor: string) => void) | null = null;

	// Grace period for transient ICE 'disconnected' states. On flaky networks
	// (mobile, tunnels) ICE regularly drops and recovers by itself within a few
	// seconds — tearing down immediately caused an endless loading/reconnect loop.
	private disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
	private static readonly DISCONNECT_GRACE_MS = 5000;

	// Navigation state - when true, DataChannel close is expected and recovery is suppressed
	private isNavigating = false;
	private navigationCleanupFn: (() => void) | null = null;
	private navigationSafetyTimeout: ReturnType<typeof setTimeout> | null = null;

	// SPA navigation frame freeze — holds last frame briefly during SPA transitions
	private spaFreezeUntil = 0;

	// WebSocket cleanup
	private wsCleanupFunctions: Array<() => void> = [];

	// Stats interval
	private statsIntervalId: ReturnType<typeof setInterval> | null = null;

	// Bandwidth logging interval
	private bandwidthLogIntervalId: ReturnType<typeof setInterval> | null = null;

	// User gesture listener for AudioContext resume (needed after page refresh)
	private userGestureHandler: (() => void) | null = null;

	constructor(projectId: string) {
		if (!projectId) {
			throw new Error('projectId is required for BrowserWebCodecsService');
		}
		this.projectId = projectId;

		// Register a one-time user gesture listener to resume suspended AudioContext.
		// After page refresh, AudioContext cannot resume without a user gesture.
		// This listener fires on the first click/keydown and resumes it.
		this.userGestureHandler = () => {
			if (this.audioContext && this.audioContext.state === 'suspended') {
				this.audioContext.resume().catch(() => {});
				debug.log('webcodecs', 'AudioContext resumed via user gesture');
			}
			// Remove listeners after first successful gesture
			if (this.userGestureHandler) {
				document.removeEventListener('click', this.userGestureHandler);
				document.removeEventListener('keydown', this.userGestureHandler);
				this.userGestureHandler = null;
			}
		};
		document.addEventListener('click', this.userGestureHandler, { once: false });
		document.addEventListener('keydown', this.userGestureHandler, { once: false });
	}

	/**
	 * Check if WebCodecs is supported
	 */
	static isSupported(): boolean {
		return (
			typeof VideoDecoder !== 'undefined' &&
			typeof AudioDecoder !== 'undefined' &&
			typeof RTCPeerConnection !== 'undefined'
		);
	}

	/**
	 * Start WebCodecs streaming for a preview session
	 */
	async startStreaming(sessionId: string, canvas: HTMLCanvasElement): Promise<boolean> {
		debug.log('webcodecs', `[DIAG] startStreaming called: sessionId=${sessionId}, isConnected=${this.isConnected}, existingSessionId=${this.sessionId}`);

		if (!BrowserWebCodecsService.isSupported()) {
			debug.error('webcodecs', 'Not supported in this browser');
			if (this.onError) {
				this.onError(new Error('WebCodecs not supported'));
			}
			return false;
		}

		// Pre-initialize AudioContext NOW, during user gesture context.
		// Browsers require a user gesture to start AudioContext — creating it
		// later (e.g. when first audio chunk arrives) results in a permanently
		// suspended context that never plays audio.
		if (!this.audioContext || this.audioContext.state === 'closed') {
			this.audioContext = new AudioContext({ sampleRate: 48000 });
		}
		if (this.audioContext.state === 'suspended') {
			// Fire-and-forget: don't await — after page refresh (no user gesture),
			// resume() returns a promise that NEVER resolves until user interacts.
			// Awaiting it would block streaming indefinitely. Audio will resume
			// automatically on first user interaction via the safety net in playAudioFrame.
			this.audioContext.resume().catch(() => {});
		}

		// Clean up any existing connection
		if (this.peerConnection || this.isConnected || this.sessionId) {
			debug.log('webcodecs', 'Cleaning up previous connection');
			await this.cleanupConnection();
		}

		this.isCleaningUp = false;
		this.stats.firstFrameRendered = false;

		this.sessionId = sessionId;
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d', {
			alpha: false,
			desynchronized: true,
			willReadFrequently: false
		});

		if (this.ctx) {
			this.ctx.imageSmoothingEnabled = true;
			this.ctx.imageSmoothingQuality = 'medium';
		}

		this.clearCanvas();

		try {
			// Setup WebSocket listeners
			this.setupEventListeners();

			// Detect VP9 decode capability — the encoder prefers VP9 quantizer
			// mode (adaptive quality) but must fall back to VP8 if we can't decode it
			let vp9Supported = false;
			try {
				const support = await VideoDecoder.isConfigSupported({ codec: 'vp09.00.10.08' });
				vp9Supported = support.supported === true;
			} catch {
				vp9Supported = false;
			}

			// Request server to start streaming and get offer
			// Send explicit tabId to ensure backend targets the correct tab
			// even if user switches tabs during the async negotiation
			debug.log('webcodecs', `[DIAG] Sending preview:browser-stream-start for session: ${sessionId} (vp9: ${vp9Supported})`);
			const response = await ws.http('preview:browser-stream-start', { tabId: sessionId, vp9: vp9Supported }, 30000);
			debug.log('webcodecs', `[DIAG] preview:browser-stream-start response: success=${response.success}, hasOffer=${!!response.offer}, message=${response.message}`);

			if (!response.success) {
				throw new Error(response.message || 'Failed to start streaming');
			}

			// Create peer connection
			await this.createPeerConnection();

			// Set remote description (offer)
			if (response.offer) {
				debug.log('webcodecs', `[DIAG] Using offer from stream-start response`);
				await this.handleOffer({
					type: response.offer.type as RTCSdpType,
					sdp: response.offer.sdp
				});
			} else {
				// Offer not ready yet — peer may still be initializing. Retry with backoff.
				debug.log('webcodecs', `[DIAG] No offer in stream-start response, retrying stream-offer with backoff`);

				let offer: { type: string; sdp?: string } | undefined;
				const offerMaxRetries = 5;
				const offerRetryDelay = 200;

				for (let attempt = 0; attempt < offerMaxRetries; attempt++) {
					if (attempt > 0) {
						await new Promise(resolve => setTimeout(resolve, offerRetryDelay * attempt));
					}
					debug.log('webcodecs', `[DIAG] stream-offer attempt ${attempt + 1}/${offerMaxRetries}`);
					const offerResponse = await ws.http('preview:browser-stream-offer', { tabId: sessionId }, 10000);
					if (offerResponse.offer) {
						offer = offerResponse.offer;
						break;
					}
				}

				if (offer) {
					await this.handleOffer({
						type: offer.type as RTCSdpType,
						sdp: offer.sdp
					});
				} else {
					throw new Error('No offer received from server after retries');
				}
			}

			debug.log('webcodecs', '[DIAG] Streaming setup complete, waiting for ICE/DataChannel');
			return true;
		} catch (error) {
			debug.error('webcodecs', 'Failed to start streaming:', error);

			if (this.onError) {
				this.onError(error instanceof Error ? error : new Error(String(error)));
			}

			await this.cleanup();
			return false;
		}
	}

	/**
	 * Create RTCPeerConnection
	 */
	private async createPeerConnection(): Promise<void> {
		const config: RTCConfiguration = {
			iceServers: this.iceServers,
			bundlePolicy: 'max-bundle',
			rtcpMuxPolicy: 'require',
			iceCandidatePoolSize: 0
		};

		this.peerConnection = new RTCPeerConnection(config);

		// Handle DataChannel
		this.peerConnection.ondatachannel = (event) => {
			debug.log('webcodecs', 'DataChannel received');
			this.dataChannel = event.channel;
			this.dataChannel.binaryType = 'arraybuffer';

			this.dataChannel.onopen = () => {
				debug.log('webcodecs', 'DataChannel open');
			};

			this.dataChannel.onclose = () => {
				debug.log('webcodecs', 'DataChannel closed');
				// Clear navigation safety timeout — DataChannel closed normally
				if (this.navigationSafetyTimeout) {
					clearTimeout(this.navigationSafetyTimeout);
					this.navigationSafetyTimeout = null;
				}
				// Trigger recovery if channel closed while we were connected
				// BUT skip recovery if we're navigating (expected behavior during page navigation)
				if (this.isConnected && !this.isCleaningUp && !this.isNavigating && this.onConnectionFailed) {
					debug.warn('webcodecs', 'DataChannel closed unexpectedly - triggering recovery');
					this.onConnectionFailed();
				} else if (this.isNavigating) {
					debug.log('webcodecs', 'DataChannel closed during navigation - scheduling fast reconnect');
					// Signal reconnecting state IMMEDIATELY (for UI - keeps progress bar showing)
					if (this.onReconnectingStart) {
						this.onReconnectingStart();
					}
					// Backend is already ready (navigation-complete fires after backend setup).
					// Short delay to let state settle, then trigger fast reconnection.
					setTimeout(() => {
						if (this.isCleaningUp) return;
						debug.log('webcodecs', '🔄 Triggering fast reconnection after navigation');
						this.isNavigating = false; // Reset navigation state
						// Use dedicated navigation reconnect handler (fast path, no delay)
						if (this.onNavigationReconnect) {
							this.onNavigationReconnect();
						} else if (this.onConnectionFailed) {
							// Fallback to regular recovery if no navigation handler
							this.onConnectionFailed();
						}
					}, 100);
				}
			};

			this.dataChannel.onerror = (error) => {
				// Suppress error log during intentional cleanup (User-Initiated Abort is expected)
				if (this.isCleaningUp) {
					debug.log('webcodecs', 'DataChannel error during cleanup (expected, suppressed)');
					return;
				}

				debug.error('webcodecs', 'DataChannel error:', error);
				debug.log('webcodecs', `DataChannel error state: isConnected=${this.isConnected}, isNavigating=${this.isNavigating}`);
				// Trigger recovery on DataChannel error
				// BUT skip recovery if we're navigating (expected behavior during page navigation)
				if (this.isConnected && !this.isNavigating && this.onConnectionFailed) {
					debug.warn('webcodecs', 'DataChannel error - triggering recovery');
					this.onConnectionFailed();
				} else if (this.isNavigating) {
					debug.log('webcodecs', '🛡️ DataChannel error during navigation - recovery suppressed');
				}
			};

			this.dataChannel.onmessage = (event) => {
				this.handleDataChannelMessage(event.data);
			};
		};

		// Handle ICE candidates
		this.peerConnection.onicecandidate = (event) => {
			if (event.candidate && this.sessionId) {
				const candidateInit: RTCIceCandidateInit = {
					candidate: event.candidate.candidate,
					sdpMid: event.candidate.sdpMid,
					sdpMLineIndex: event.candidate.sdpMLineIndex
				};

				ws.http('preview:browser-stream-ice', { candidate: candidateInit, tabId: this.sessionId }).catch((error) => {
					debug.warn('webcodecs', 'Failed to send ICE candidate:', error);
				});

				// Also send loopback version for VPN compatibility (same-machine peers)
				const loopback = this.createLoopbackCandidate(candidateInit);
				if (loopback) {
					ws.http('preview:browser-stream-ice', { candidate: loopback, tabId: this.sessionId }).catch(() => {});
				}
			}
		};

		// Handle connection state
		this.peerConnection.onconnectionstatechange = () => {
			const state = this.peerConnection?.connectionState || 'closed';
			debug.log('webcodecs', `Connection state: ${state}`);

			this.stats.connectionState = state as RTCPeerConnectionState;

			if (state === 'connected') {
				this.clearDisconnectGrace();
				this.isConnected = true;
				this.stats.isConnected = true;
				this.startStatsCollection();
				// this.startBandwidthLogging();
				if (this.onConnectionChange) {
					this.onConnectionChange(true);
				}
			} else if (state === 'failed') {
				debug.error('webcodecs', 'Connection FAILED');
				this.clearDisconnectGrace();
				this.isConnected = false;
				this.stats.isConnected = false;
				this.stopStatsCollection();
				this.stopBandwidthLogging();
				if (this.onConnectionChange) {
					this.onConnectionChange(false);
				}
				if (this.onConnectionFailed) {
					this.onConnectionFailed();
				}
			} else if (state === 'disconnected') {
				// Transient on flaky networks (mobile/tunnel) — ICE usually
				// recovers on its own within seconds. Don't tear down yet;
				// only treat as failure if the grace period expires without
				// returning to 'connected' (prevents the loading/reconnect loop).
				this.scheduleDisconnectGrace();
			} else if (state === 'closed') {
				this.clearDisconnectGrace();
				this.isConnected = false;
				this.stats.isConnected = false;
				this.stopStatsCollection();
				this.stopBandwidthLogging();
				if (this.onConnectionChange) {
					this.onConnectionChange(false);
				}
			}
		};

		// Handle ICE connection state
		this.peerConnection.oniceconnectionstatechange = () => {
			const state = this.peerConnection?.iceConnectionState || 'closed';
			debug.log('webcodecs', `ICE connection state: ${state}`);
			this.stats.iceConnectionState = state as RTCIceConnectionState;

			if (state === 'failed') {
				debug.error('webcodecs', 'ICE connection FAILED');
				if (this.onConnectionFailed) {
					this.onConnectionFailed();
				}
			}
		};
	}

	/**
	 * Handle offer from headless browser
	 */
	private async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
		if (!this.peerConnection) {
			throw new Error('Peer connection not initialized');
		}

		await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
		debug.log('webcodecs', 'Remote description set');

		const answer = await this.peerConnection.createAnswer();
		await this.peerConnection.setLocalDescription(answer);
		debug.log('webcodecs', 'Local description set');

		if (this.sessionId) {
			await ws.http('preview:browser-stream-answer', {
				answer: {
					type: answer.type,
					sdp: answer.sdp
				},
				tabId: this.sessionId
			});
		}
	}

	/**
	 * Handle DataChannel message (encoded video/audio chunks)
	 */
	private handleDataChannelMessage(data: ArrayBuffer): void {
		try {
			const view = new DataView(data);

			// Parse packet header
			const type = view.getUint8(0); // 0 = video, 1 = audio

			if (type === 0) {
				// Video packet
				// Format: [type(1)][timestamp(8)][keyframe(1)][codec(1)][size(4)][data]
				const timestamp = Number(view.getBigUint64(1, true));
				const isKeyframe = view.getUint8(9) === 1;
				const codecId = view.getUint8(10); // 0 = vp8, 1 = vp9
				const size = view.getUint32(11, true);
				const chunkData = new Uint8Array(data, 15, size);

				this.stats.videoBytesReceived += size;
				this.stats.videoFramesReceived++;

				this.handleVideoChunk(chunkData, timestamp, isKeyframe, codecId);
			} else if (type === 1) {
				// Audio packet
				// Format: [type(1)][timestamp(8)][size(4)][data]
				const timestamp = Number(view.getBigUint64(1, true));
				const size = view.getUint32(9, true);
				const chunkData = new Uint8Array(data, 13, size);

				this.stats.audioBytesReceived += size;
				this.stats.audioFramesReceived++;

				this.handleAudioChunk(chunkData, timestamp);
			} else if (type === 2) {
				// Fragmented video packet (large frames, e.g. top-off keyframes)
				// Format: [type(1)][timestamp(8)][keyframe(1)][codec(1)][fragIndex(2)][fragCount(2)][size(4)][data]
				const timestamp = Number(view.getBigUint64(1, true));
				const isKeyframe = view.getUint8(9) === 1;
				const codecId = view.getUint8(10);
				const fragIndex = view.getUint16(11, true);
				const fragCount = view.getUint16(13, true);
				const size = view.getUint32(15, true);
				const fragData = new Uint8Array(data, 19, size);

				this.stats.videoBytesReceived += size;

				// New timestamp invalidates any incomplete fragment set.
				// The channel is reliable + ordered, so this shouldn't happen —
				// it's a safety net against desync after reconnects.
				if (!this.fragmentBuffer || this.fragmentTimestamp !== timestamp) {
					this.fragmentBuffer = [];
					this.fragmentTimestamp = timestamp;
				}
				this.fragmentBuffer[fragIndex] = fragData;

				const received = this.fragmentBuffer.filter(Boolean).length;
				if (received === fragCount) {
					const totalSize = this.fragmentBuffer.reduce((sum, f) => sum + f.byteLength, 0);
					const fullData = new Uint8Array(totalSize);
					let offset = 0;
					for (const frag of this.fragmentBuffer) {
						fullData.set(frag, offset);
						offset += frag.byteLength;
					}
					this.fragmentBuffer = null;

					this.stats.videoFramesReceived++;
					this.handleVideoChunk(fullData, timestamp, isKeyframe, codecId);
				}
			}
		} catch (error) {
			debug.error('webcodecs', 'DataChannel message parse error:', error);
		}
	}

	/**
	 * Handle video chunk - decode and render
	 */
	private async handleVideoChunk(data: Uint8Array, timestamp: number, isKeyframe: boolean, codecId: number): Promise<void> {
		// Codec changed mid-stream (e.g. navigation re-injected the encoder
		// with different codec support) — reinit decoder on the keyframe
		if (this.videoDecoder && isKeyframe && codecId !== this.activeCodecId) {
			try {
				this.videoDecoder.close();
			} catch {}
			this.videoDecoder = null;
		}

		// Initialize decoder on first keyframe
		if (!this.videoDecoder && isKeyframe) {
			try {
				await this.initVideoDecoder(codecId);
			} catch {
				// Codec unsupported or init failed — chunk is dropped below;
				// keyframe request throttle prevents a request storm
			}
		}

		if (!this.videoDecoder) {
			// Delta frame without a decoder (joined mid-stream or decoder just
			// errored) — ask the server for a sync point instead of waiting
			// for the periodic keyframe interval
			this.stats.videoFramesDropped++;
			this.requestKeyframe();
			return;
		}

		try {
			const chunk = new EncodedVideoChunk({
				type: isKeyframe ? 'key' : 'delta',
				timestamp,
				data
			});

			this.videoDecoder.decode(chunk);
		} catch (error) {
			debug.error('webcodecs', 'Video decode error:', error);
			this.stats.videoFramesDropped++;
			this.requestKeyframe();
		}
	}

	/**
	 * Handle audio chunk - decode and queue for playback
	 */
	private async handleAudioChunk(data: Uint8Array, timestamp: number): Promise<void> {
		// Initialize decoder on first chunk
		if (!this.audioDecoder) {
			await this.initAudioDecoder();
		}

		if (!this.audioDecoder) {
			this.stats.audioFramesDropped++;
			return;
		}

		try {
			const chunk = new EncodedAudioChunk({
				type: 'key', // Opus frames are all keyframes
				timestamp,
				data
			});

			this.audioDecoder.decode(chunk);
		} catch (error) {
			debug.error('webcodecs', 'Audio decode error:', error);
			this.stats.audioFramesDropped++;
		}
	}

	/**
	 * Initialize VideoDecoder for the codec announced in the packet header
	 */
	private async initVideoDecoder(codecId: number): Promise<void> {
		// Codec string must match the encoder in the headless browser:
		// 0 = VP8 (fallback), 1 = VP9 profile 0 (quantizer mode)
		const codec = codecId === 1 ? 'vp09.00.10.08' : 'vp8';
		this.stats.videoCodec = codecId === 1 ? 'vp9' : 'vp8';

		this.videoCodecConfig = {
			codec,
			optimizeForLatency: true
		};

		try {
			const support = await VideoDecoder.isConfigSupported(this.videoCodecConfig);
			if (!support.supported) {
				throw new Error(`Video codec ${codec} not supported`);
			}

			this.videoDecoder = new VideoDecoder({
				output: (frame) => this.handleDecodedVideoFrame(frame),
				error: (e) => {
					debug.error('webcodecs', 'VideoDecoder error:', e);
					// Null out so next keyframe triggers reinitialization.
					// Without this, the decoder stays in 'closed' state but non-null,
					// causing handleVideoChunk's `!this.videoDecoder` check to never fire
					// → all subsequent frames permanently dropped (stuck frames bug).
					this.videoDecoder = null;
					// Ask the server for a fresh sync point right away
					this.requestKeyframe();
				}
			});

			this.videoDecoder.configure(this.videoCodecConfig);
			this.activeCodecId = codecId;
			debug.log('webcodecs', 'VideoDecoder initialized:', codec);
		} catch (error) {
			debug.error('webcodecs', 'VideoDecoder init error:', error);
			throw error;
		}
	}

	/**
	 * Start the grace timer for a transient 'disconnected' state.
	 * If the connection doesn't return to 'connected' before the timer fires,
	 * treat it as a real failure and trigger recovery.
	 */
	private scheduleDisconnectGrace(): void {
		if (this.disconnectGraceTimer) return;

		debug.warn('webcodecs', `Connection disconnected — ${BrowserWebCodecsService.DISCONNECT_GRACE_MS}ms grace period before recovery`);
		this.disconnectGraceTimer = setTimeout(() => {
			this.disconnectGraceTimer = null;

			if (this.isCleaningUp) return;
			if (this.peerConnection?.connectionState === 'connected') return;

			debug.warn('webcodecs', 'Disconnect grace period expired — treating as connection failure');
			this.isConnected = false;
			this.stats.isConnected = false;
			this.stopStatsCollection();
			this.stopBandwidthLogging();
			if (this.onConnectionChange) {
				this.onConnectionChange(false);
			}
			if (this.onConnectionFailed) {
				this.onConnectionFailed();
			}
		}, BrowserWebCodecsService.DISCONNECT_GRACE_MS);
	}

	private clearDisconnectGrace(): void {
		if (this.disconnectGraceTimer) {
			clearTimeout(this.disconnectGraceTimer);
			this.disconnectGraceTimer = null;
		}
	}

	/**
	 * Request a keyframe from the server (PLI equivalent), throttled to 1/s.
	 * Used when the decoder errors or delta frames arrive without a decoder —
	 * much faster recovery than waiting for the periodic keyframe interval.
	 */
	private requestKeyframe(): void {
		const now = Date.now();
		if (now - this.lastKeyframeRequestTime < 1000) return;
		this.lastKeyframeRequestTime = now;

		if (this.sessionId) {
			debug.log('webcodecs', 'Requesting keyframe from server');
			ws.http('preview:browser-stream-keyframe', { tabId: this.sessionId }).catch(() => {});
		}
	}

	/**
	 * Initialize AudioDecoder
	 */
	private async initAudioDecoder(): Promise<void> {
		this.audioCodecConfig = {
			codec: 'opus',
			sampleRate: 48000,
			numberOfChannels: 2
		};

		try {
			const support = await AudioDecoder.isConfigSupported(this.audioCodecConfig);
			if (!support.supported) {
				throw new Error('Opus audio codec not supported');
			}

			this.audioDecoder = new AudioDecoder({
				output: (frame) => this.handleDecodedAudioFrame(frame),
				error: (e) => {
					debug.error('webcodecs', 'AudioDecoder error:', e);
					// Null out so next chunk triggers reinitialization.
					this.audioDecoder = null;
				}
			});

			this.audioDecoder.configure(this.audioCodecConfig);
			this.stats.audioCodec = 'opus';

			// Initialize AudioContext for playback
			await this.initAudioContext();

			debug.log('webcodecs', 'AudioDecoder initialized: opus');
		} catch (error) {
			debug.error('webcodecs', 'AudioDecoder init error:', error);
		}
	}

	/**
	 * Initialize AudioContext for audio playback
	 */
	private async initAudioContext(): Promise<void> {
		try {
			// Reuse AudioContext created in startStreaming (user gesture context)
			if (!this.audioContext || this.audioContext.state === 'closed') {
				this.audioContext = new AudioContext({ sampleRate: 48000 });
			}

			// Resume if suspended — fire-and-forget, same reason as in startStreaming
			if (this.audioContext.state === 'suspended') {
				this.audioContext.resume().catch(() => {});
			}

			debug.log('webcodecs', `AudioContext initialized (state: ${this.audioContext.state})`);
		} catch (error) {
			debug.error('webcodecs', 'AudioContext init error:', error);
		}
	}

	/**
	 * Handle decoded video frame - render to canvas with timestamp-based optimization
	 */
	private handleDecodedVideoFrame(frame: VideoFrame): void {
		if (this.isCleaningUp || !this.canvas || !this.ctx) {
			frame.close();
			return;
		}

		// During SPA navigation freeze, skip rendering to hold the last frame
		// This prevents brief white flashes during SPA page transitions
		if (this.spaFreezeUntil > 0 && Date.now() < this.spaFreezeUntil) {
			frame.close();
			return;
		}
		// Auto-reset freeze after it expires
		if (this.spaFreezeUntil > 0) {
			this.spaFreezeUntil = 0;
		}

		try {
			// Update stats
			this.stats.videoFramesDecoded++;
			this.stats.frameWidth = frame.displayWidth;
			this.stats.frameHeight = frame.displayHeight;

			// Establish AV sync reference on first video frame
			if (!this.syncEstablished) {
				this.syncEstablished = true;
				this.syncRealTimeOrigin = performance.now();
				this.syncStreamTimestamp = frame.timestamp;
				debug.log('webcodecs', `AV Sync established: realTime=${this.syncRealTimeOrigin.toFixed(0)}ms, streamTs=${this.syncStreamTimestamp}μs`);
			}

			// Track last video timestamp and real time for audio sync
			this.lastVideoTimestamp = frame.timestamp;
			this.lastVideoRealTime = performance.now();

			// Mark first frame rendered
			if (!this.stats.firstFrameRendered) {
				this.stats.firstFrameRendered = true;
				this.startTime = performance.now();
				this.firstFrameTimestamp = frame.timestamp;
				debug.log('webcodecs', 'First video frame rendered');

				// Notify immediately so UI can hide loading overlay without polling delay
				if (this.onFirstFrame) {
					this.onFirstFrame();
				}

				// Reset navigation state - frames are flowing, navigation is complete
				if (this.isNavigating) {
					debug.log('webcodecs', 'Navigation complete - frames received, resetting navigation state');
					this.isNavigating = false;
					if (this.navigationSafetyTimeout) {
						clearTimeout(this.navigationSafetyTimeout);
						this.navigationSafetyTimeout = null;
					}
				}
			}

			// Drop old pending frame if exists (frame skipping for performance)
			if (this.pendingFrame) {
				this.pendingFrame.close();
				this.stats.videoFramesDropped++;
			}

			// Store frame for next render cycle
			this.pendingFrame = frame;

			// Schedule render if not already scheduled
			if (!this.isRenderingFrame) {
				this.scheduleFrameRender();
			}
		} catch (error) {
			debug.error('webcodecs', 'Video frame handle error:', error);
			frame.close();
		}
	}

	/**
	 * Schedule frame rendering using requestAnimationFrame with timestamp awareness
	 * This mimics requestVideoFrameCallback behavior for optimal video rendering
	 */
	private scheduleFrameRender(): void {
		if (this.isRenderingFrame) return;

		this.isRenderingFrame = true;
		this.renderFrameId = requestAnimationFrame((timestamp) => {
			this.renderPendingFrame(timestamp);
		});
	}

	/**
	 * Render pending frame to canvas with timestamp-based scheduling
	 * This approach provides similar benefits to requestVideoFrameCallback
	 */
	private renderPendingFrame(timestamp: DOMHighResTimeStamp): void {
		this.isRenderingFrame = false;

		if (!this.pendingFrame || this.isCleaningUp || !this.canvas || !this.ctx) {
			if (this.pendingFrame) {
				this.pendingFrame.close();
				this.pendingFrame = null;
			}
			return;
		}

		try {
			// Calculate frame timing (similar to requestVideoFrameCallback metadata)
			// Use relative timestamp from first frame to sync with frontend clock
			const frameTimestamp = (this.pendingFrame.timestamp - this.firstFrameTimestamp) / 1000; // convert to ms
			const elapsedTime = timestamp - this.startTime;

			const timeDrift = elapsedTime - frameTimestamp;

			// Auto-reset timing when drift exceeds 2 seconds.
			// This handles stale timing state after reconnects or rapid tab switches
			// where startTime/firstFrameTimestamp were not properly reset.
			if (Math.abs(timeDrift) > 2000 && this.startTime > 0) {
				debug.warn('webcodecs', `Frame timing drift reset (was ${timeDrift.toFixed(0)}ms)`);
				this.startTime = timestamp;
				this.firstFrameTimestamp = this.pendingFrame.timestamp;
			}

			// Match canvas backing store to the frame's native size and draw 1:1.
			// Stretching frames to a differently-sized canvas caused blurry output;
			// display fit-scaling is handled by CSS transform in the container.
			const frameWidth = this.pendingFrame.displayWidth;
			const frameHeight = this.pendingFrame.displayHeight;
			if (this.canvas.width !== frameWidth || this.canvas.height !== frameHeight) {
				this.canvas.width = frameWidth;
				this.canvas.height = frameHeight;
			}
			this.ctx.drawImage(this.pendingFrame, 0, 0);

			this.lastFrameTime = timestamp;
		} catch (error) {
			debug.error('webcodecs', 'Video frame render error:', error);
		} finally {
			// Close frame immediately to free memory
			this.pendingFrame.close();
			this.pendingFrame = null;
		}
	}

	/**
	 * Handle decoded audio frame - play audio
	 */
	private handleDecodedAudioFrame(frame: AudioData): void {
		if (this.isCleaningUp || !this.audioContext) {
			frame.close();
			return;
		}

		try {
			this.stats.audioFramesDecoded++;

			// Simple playback: convert AudioData to AudioBuffer and play
			// For production, use AudioWorklet for better latency
			this.playAudioFrame(frame);
		} catch (error) {
			debug.error('webcodecs', 'Audio frame playback error:', error);
		} finally {
			frame.close();
		}
	}

	/**
	 * Play audio frame using simple back-to-back scheduling.
	 *
	 * Frames are scheduled immediately one after another. When a gap occurs
	 * (e.g. silence was skipped server-side and audio resumes), the schedule
	 * is reset with a 50ms lookahead so playback starts cleanly without
	 * audible pops or stutters from scheduling in the past.
	 */
	private playAudioFrame(audioData: AudioData): void {
		if (!this.audioContext) return;

		// Safety net: resume AudioContext if suspended
		if (this.audioContext.state === 'suspended') {
			this.audioContext.resume().catch(() => {});
		}

		try {
			const buffer = this.audioContext.createBuffer(
				audioData.numberOfChannels,
				audioData.numberOfFrames,
				audioData.sampleRate
			);

			for (let channel = 0; channel < audioData.numberOfChannels; channel++) {
				const options = {
					planeIndex: channel,
					frameOffset: 0,
					frameCount: audioData.numberOfFrames,
					format: 'f32-planar' as AudioSampleFormat
				};
				// allocationSize() returns bytes — wrap in ArrayBuffer so Float32Array length is correct
				const tempFloat32 = new Float32Array(new ArrayBuffer(audioData.allocationSize(options)));
				audioData.copyTo(tempFloat32, options);
				buffer.getChannelData(channel).set(tempFloat32);
			}

			const currentTime = this.audioContext.currentTime;

			// When the scheduler has fallen behind (gap due to silence or decode delay),
			// reset with a 50ms lookahead so the next chunk starts cleanly.
			if (this.nextAudioPlayTime < currentTime) {
				this.nextAudioPlayTime = currentTime + 0.05;
			}

			const source = this.audioContext.createBufferSource();
			source.buffer = buffer;
			source.connect(this.audioContext.destination);
			source.start(this.nextAudioPlayTime);

			// Back-to-back: next chunk plays immediately after this one ends
			this.nextAudioPlayTime += buffer.duration;
		} catch (error) {
			debug.warn('webcodecs', 'Audio playback error:', error);
		}
	}

	/**
	 * Setup WebSocket event listeners
	 */
	private setupEventListeners(): void {
		const cleanupIce = ws.on('preview:browser-stream-ice', async (data) => {
			if (data.sessionId === this.sessionId && data.from === 'headless') {
				await this.addIceCandidate(data.candidate);
			}
		});

		const cleanupState = ws.on('preview:browser-stream-state', (data) => {
			if (data.sessionId === this.sessionId) {
				debug.log('webcodecs', `Server connection state: ${data.state}`);
			}
		});

		const cleanupCursor = ws.on('preview:browser-cursor-change', (data) => {
			if (data.sessionId === this.sessionId && this.onCursorChange) {
				this.onCursorChange(data.cursor);
			}
		});

		// Listen for navigation events DIRECTLY to set isNavigating flag immediately
		// This bypasses Svelte's reactive chain which can be too slow
		debug.log('webcodecs', `🔧 Registering navigation listener for session: ${this.sessionId}`);
		const cleanupNavLoading = ws.on('preview:browser-navigation-loading', (data) => {
			debug.log('webcodecs', `📡 Navigation-loading WS event: eventSessionId=${data.sessionId}, mySessionId=${this.sessionId}`);
			// Set isNavigating regardless of sessionId match to ensure recovery is suppressed
			// Multiple tabs scenario: only suppress for current tab, but log all
			if (data.sessionId === this.sessionId) {
				this.isNavigating = true;
				debug.log('webcodecs', `✅ Navigation started - isNavigating=true for session ${data.sessionId}`);
			}
		});

		const cleanupNavComplete = ws.on('preview:browser-navigation', (data) => {
			if (data.sessionId === this.sessionId) {
				debug.log('webcodecs', `Navigation completed (direct WS) for session ${data.sessionId}`);

				// If isNavigating was NOT set by navigation-loading (SPA-like case where
				// framenavigated fires without a document request), set it now so the
				// subsequent DataChannel close triggers fast reconnect instead of full recovery
				if (!this.isNavigating) {
					this.isNavigating = true;
					debug.log('webcodecs', '✅ Set isNavigating=true on navigation complete (no loading event preceded)');
				}

				// Signal reconnecting state IMMEDIATELY when navigation completes
				// This eliminates the gap between isNavigating=false and DataChannel close
				// ensuring the overlay stays visible continuously
				if (this.onReconnectingStart) {
					debug.log('webcodecs', '🔄 Pre-emptive reconnecting state on navigation complete');
					this.onReconnectingStart();
				}

				// Fast safety timeout: if DataChannel doesn't close within 100ms,
				// force a full recovery (stop + start fresh stream). Sometimes
				// the old WebRTC connection lingers for 10-16s before ICE timeout.
				// Using onConnectionFailed triggers attemptRecovery (full stop+start),
				// which is the same path as tab switching and takes ~100ms to first frame.
				if (this.navigationSafetyTimeout) {
					clearTimeout(this.navigationSafetyTimeout);
				}
				this.navigationSafetyTimeout = setTimeout(() => {
					this.navigationSafetyTimeout = null;
					if (this.isCleaningUp || !this.isNavigating) return;
					debug.warn('webcodecs', '⏰ Navigation safety timeout - forcing full recovery');
					this.isNavigating = false;
					if (this.onConnectionFailed) {
						this.onConnectionFailed();
					}
				}, 100);
			}
		});

		// Listen for SPA navigation events (pushState/replaceState/hash changes)
		// Reset isNavigating if it was set by a preceding navigation-loading event
		// that the SPA router intercepted (cancelled the full navigation)
		const cleanupNavSpa = ws.on('preview:browser-navigation-spa', (data) => {
			if (data.sessionId === this.sessionId && this.isNavigating) {
				debug.log('webcodecs', '🔄 SPA navigation received - resetting isNavigating (no stream restart needed)');
				this.isNavigating = false;
			}
		});

		this.wsCleanupFunctions = [cleanupIce, cleanupState, cleanupCursor, cleanupNavLoading, cleanupNavComplete, cleanupNavSpa];
	}

	/**
	 * Create a loopback (127.0.0.1) copy of a host ICE candidate.
	 * Ensures WebRTC connects via loopback when VPN (e.g. Cloudflare WARP)
	 * interferes with host candidate connectivity between same-machine peers.
	 */
	private createLoopbackCandidate(candidate: RTCIceCandidateInit): RTCIceCandidateInit | null {
		if (!candidate.candidate) return null;
		if (!candidate.candidate.includes('typ host')) return null;

		const parts = candidate.candidate.split(' ');
		if (parts.length < 8) return null;

		// Index 4 is the address field in ICE candidate format
		const address = parts[4];
		if (address === '127.0.0.1' || address === '::1') return null;

		parts[4] = '127.0.0.1';
		return { ...candidate, candidate: parts.join(' ') };
	}

	/**
	 * Add ICE candidate (+ loopback variant for VPN compatibility)
	 */
	private async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
		if (!this.peerConnection) return;

		try {
			await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
		} catch (error) {
			debug.warn('webcodecs', 'Add ICE candidate error:', error);
		}

		// Also try loopback version for VPN compatibility (same-machine peers)
		const loopback = this.createLoopbackCandidate(candidate);
		if (loopback) {
			try {
				await this.peerConnection.addIceCandidate(new RTCIceCandidate(loopback));
			} catch {
				// Expected to fail if loopback is not applicable
			}
		}
	}

	/**
	 * Start stats collection
	 */
	private startStatsCollection(): void {
		if (this.statsIntervalId) return;

		this.statsIntervalId = setInterval(async () => {
			await this.collectStats();
		}, 1000);
	}

	/**
	 * Stop stats collection
	 */
	private stopStatsCollection(): void {
		if (this.statsIntervalId) {
			clearInterval(this.statsIntervalId);
			this.statsIntervalId = null;
		}
	}

	/**
	 * Collect stats
	 */
	private async collectStats(): Promise<void> {
		const now = performance.now();

		// Calculate bandwidth if we have previous measurements
		if (this.lastStatsTime > 0) {
			const timeDelta = (now - this.lastStatsTime) / 1000; // seconds

			// Video bitrate
			const videoBytesReceived = this.stats.videoBytesReceived - this.lastVideoBytesReceived;
			this.stats.videoBitrate = (videoBytesReceived * 8) / timeDelta;

			// Audio bitrate
			const audioBytesReceived = this.stats.audioBytesReceived - this.lastAudioBytesReceived;
			this.stats.audioBitrate = (audioBytesReceived * 8) / timeDelta;

			// Total
			this.stats.totalBitrate = this.stats.videoBitrate + this.stats.audioBitrate;
			this.stats.totalBandwidthMBps = this.stats.totalBitrate / 8 / 1024 / 1024;
		}

		this.lastVideoBytesReceived = this.stats.videoBytesReceived;
		this.lastAudioBytesReceived = this.stats.audioBytesReceived;
		this.lastStatsTime = now;

		if (this.onStats) {
			this.onStats(this.stats);
		}
	}

	/**
	 * Start bandwidth logging
	 */
	private startBandwidthLogging(): void {
		if (this.bandwidthLogIntervalId) return;

		this.bandwidthLogIntervalId = setInterval(() => {
			this.logBandwidthStats();
		}, 1000); // Log every 5 seconds
	}

	/**
	 * Stop bandwidth logging
	 */
	private stopBandwidthLogging(): void {
		if (this.bandwidthLogIntervalId) {
			clearInterval(this.bandwidthLogIntervalId);
			this.bandwidthLogIntervalId = null;
		}
	}

	/**
	 * Log bandwidth statistics to console
	 */
	private logBandwidthStats(): void {
		const videoKbps = (this.stats.videoBitrate / 1000).toFixed(1);
		const audioKbps = (this.stats.audioBitrate / 1000).toFixed(1);
		const totalKbps = (this.stats.totalBitrate / 1000).toFixed(1);
		const totalMBps = this.stats.totalBandwidthMBps.toFixed(3);

		debug.log('webcodecs',
			`📊 Bandwidth Usage:\n` +
			`   Video: ${videoKbps} Kbps (${this.stats.videoCodec}) - ${this.stats.frameWidth}x${this.stats.frameHeight}\n` +
			`   Audio: ${audioKbps} Kbps (${this.stats.audioCodec})\n` +
			`   Total: ${totalKbps} Kbps (${totalMBps} MB/s)\n` +
			`   Frames: Video ${this.stats.videoFramesDecoded} (dropped: ${this.stats.videoFramesDropped}), ` +
			`Audio ${this.stats.audioFramesDecoded} (dropped: ${this.stats.audioFramesDropped})`
		);
	}

	/**
	 * Stop streaming
	 */
	async stopStreaming(): Promise<void> {
		debug.log('webcodecs', 'Stopping streaming');
		await this.cleanup();
	}

	/**
	 * Reconnect to existing backend stream (after navigation)
	 * This does NOT tell backend to stop - just reconnects WebRTC locally
	 */
	async reconnectToExistingStream(sessionId: string, canvas: HTMLCanvasElement): Promise<boolean> {
		debug.log('webcodecs', `🔄 Reconnecting to existing stream for session: ${sessionId}`);

		// Cleanup local WebRTC state WITHOUT notifying backend
		await this.cleanupLocalConnection();

		this.isCleaningUp = false;
		this.stats.firstFrameRendered = false;
		this.isNavigating = false;

		this.sessionId = sessionId;
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d', {
			alpha: false,
			desynchronized: true,
			willReadFrequently: false
		});

		if (this.ctx) {
			this.ctx.imageSmoothingEnabled = true;
			this.ctx.imageSmoothingQuality = 'medium';
		}

		try {
			// Setup WebSocket listeners
			this.setupEventListeners();

			// Create peer connection
			await this.createPeerConnection();

			// Get offer from backend's existing peer (don't start new streaming)
			const offerResponse = await ws.http('preview:browser-stream-offer', { tabId: sessionId }, 10000);
			if (offerResponse.offer) {
				await this.handleOffer({
					type: offerResponse.offer.type as RTCSdpType,
					sdp: offerResponse.offer.sdp
				});
			} else {
				throw new Error('No offer received from backend');
			}

			debug.log('webcodecs', 'Reconnection setup complete');
			return true;
		} catch (error) {
			debug.error('webcodecs', 'Failed to reconnect:', error);
			if (this.onError) {
				this.onError(error instanceof Error ? error : new Error(String(error)));
			}
			return false;
		}
	}

	/**
	 * Cleanup local WebRTC connection WITHOUT notifying backend
	 */
	private async cleanupLocalConnection(): Promise<void> {
		this.isCleaningUp = true;

		this.clearDisconnectGrace();
		this.stopStatsCollection();
		this.stopBandwidthLogging();

		// Cancel pending frame render
		if (this.renderFrameId !== null) {
			cancelAnimationFrame(this.renderFrameId);
			this.renderFrameId = null;
		}

		// Close pending frame
		if (this.pendingFrame) {
			this.pendingFrame.close();
			this.pendingFrame = null;
		}

		// Cleanup WebSocket listeners
		try {
			this.wsCleanupFunctions.forEach((cleanup) => cleanup());
		} catch (e) {
			debug.warn('webcodecs', 'Error in ws cleanup:', e);
		}
		this.wsCleanupFunctions = [];

		// Close decoders immediately (reset + close, no flush).
		// Flushing processes all queued frames which is slow and can fire
		// stale callbacks during rapid tab switching.
		if (this.videoDecoder) {
			try {
				this.videoDecoder.reset();
				this.videoDecoder.close();
			} catch (e) {}
			this.videoDecoder = null;
		}

		if (this.audioDecoder) {
			try {
				this.audioDecoder.reset();
				this.audioDecoder.close();
			} catch (e) {}
			this.audioDecoder = null;
		}

		// Keep AudioContext alive across reconnections — it was created during
		// user gesture in startStreaming() and closing it means we can't resume
		// without another user gesture. Just reset playback state below.

		// Close data channel
		if (this.dataChannel) {
			this.dataChannel.close();
			this.dataChannel = null;
		}

		// Close peer connection
		if (this.peerConnection) {
			this.peerConnection.close();
			this.peerConnection = null;
		}

		this.isConnected = false;
		// NOTE: Don't clear sessionId - we're reconnecting to same session

		// Reset playback state
		this.nextAudioPlayTime = 0;
		this.audioBufferQueue = [];
		this.audioSyncInitialized = false;
		this.audioCalibrationSamples = 0;
		this.audioOffsetAccumulator = 0;
		this.calibratedAudioOffset = 0;

		this.isRenderingFrame = false;
		this.lastFrameTime = 0;
		this.startTime = 0;
		this.firstFrameTimestamp = 0;
		this.fragmentBuffer = null;
		this.fragmentTimestamp = 0;

		this.syncEstablished = false;
		this.syncRealTimeOrigin = 0;
		this.syncStreamTimestamp = 0;
		this.lastVideoTimestamp = 0;
		this.lastVideoRealTime = 0;

		if (this.onConnectionChange) {
			this.onConnectionChange(false);
		}

		this.isCleaningUp = false;
	}

	/**
	 * Cleanup resources
	 */
	private async cleanup(): Promise<void> {
		this.isCleaningUp = true;

		this.clearDisconnectGrace();
		this.stopStatsCollection();
		this.stopBandwidthLogging();

		// Cancel pending frame render
		if (this.renderFrameId !== null) {
			cancelAnimationFrame(this.renderFrameId);
			this.renderFrameId = null;
		}

		// Close pending frame
		if (this.pendingFrame) {
			this.pendingFrame.close();
			this.pendingFrame = null;
		}

		// Cleanup WebSocket listeners
		try {
			this.wsCleanupFunctions.forEach((cleanup) => cleanup());
		} catch (e) {
			debug.warn('webcodecs', 'Error in ws cleanup:', e);
		}
		this.wsCleanupFunctions = [];

		// Notify server with explicit tabId (fire-and-forget for speed during rapid switching)
		if (this.sessionId) {
			ws.http('preview:browser-stream-stop', { tabId: this.sessionId }).catch(() => {});
		}

		// Close decoders immediately (reset + close, no flush for speed)
		if (this.videoDecoder) {
			try {
				this.videoDecoder.reset();
				this.videoDecoder.close();
			} catch (e) {}
			this.videoDecoder = null;
		}

		if (this.audioDecoder) {
			try {
				this.audioDecoder.reset();
				this.audioDecoder.close();
			} catch (e) {}
			this.audioDecoder = null;
		}

		// Keep AudioContext alive across stop/start cycles — it was created during
		// a user gesture in startStreaming() and closing it means we can't resume
		// without another user gesture. Only destroy() should close it.
		// Just reset audio playback scheduling state below.

		// Close data channel
		if (this.dataChannel) {
			this.dataChannel.close();
			this.dataChannel = null;
		}

		// Close peer connection
		if (this.peerConnection) {
			this.peerConnection.close();
			this.peerConnection = null;
		}

		this.isConnected = false;
		this.sessionId = null;
		this.canvas = null;
		this.ctx = null;

		// Reset stats
		this.stats = {
			isConnected: false,
			connectionState: 'closed',
			iceConnectionState: 'closed',
			videoBytesReceived: 0,
			audioBytesReceived: 0,
			videoFramesReceived: 0,
			audioFramesReceived: 0,
			videoFramesDecoded: 0,
			audioFramesDecoded: 0,
			videoFramesDropped: 0,
			audioFramesDropped: 0,
			frameWidth: 0,
			frameHeight: 0,
			videoBitrate: 0,
			audioBitrate: 0,
			totalBitrate: 0,
			totalBandwidthMBps: 0,
			videoCodec: 'unknown',
			audioCodec: 'unknown',
			firstFrameRendered: false
		};

		this.lastVideoBytesReceived = 0;
		this.lastAudioBytesReceived = 0;
		this.lastStatsTime = 0;

		// Reset audio playback state
		this.nextAudioPlayTime = 0;
		this.audioBufferQueue = [];
		this.audioSyncInitialized = false;
		this.audioCalibrationSamples = 0;
		this.audioOffsetAccumulator = 0;
		this.calibratedAudioOffset = 0;

		// Reset frame rendering state
		this.isRenderingFrame = false;
		this.lastFrameTime = 0;
		this.startTime = 0;
		this.firstFrameTimestamp = 0;
		this.fragmentBuffer = null;
		this.fragmentTimestamp = 0;

		// Reset AV sync state
		this.syncEstablished = false;
		this.syncRealTimeOrigin = 0;
		this.syncStreamTimestamp = 0;
		this.lastVideoTimestamp = 0;
		this.lastVideoRealTime = 0;

		// Reset navigation state
		this.isNavigating = false;
		if (this.navigationSafetyTimeout) {
			clearTimeout(this.navigationSafetyTimeout);
			this.navigationSafetyTimeout = null;
		}

		if (this.onConnectionChange) {
			this.onConnectionChange(false);
		}

		this.isCleaningUp = false;
	}

	/**
	 * Cleanup connection (internal)
	 */
	private async cleanupConnection(): Promise<void> {
		this.isCleaningUp = true;

		this.clearDisconnectGrace();
		this.stopStatsCollection();
		this.stopBandwidthLogging();

		// Cancel pending frame render
		if (this.renderFrameId !== null) {
			cancelAnimationFrame(this.renderFrameId);
			this.renderFrameId = null;
		}

		// Close pending frame
		if (this.pendingFrame) {
			this.pendingFrame.close();
			this.pendingFrame = null;
		}

		try {
			this.wsCleanupFunctions.forEach((cleanup) => cleanup());
		} catch (e) {
			debug.warn('webcodecs', 'Error in ws cleanup:', e);
		}
		this.wsCleanupFunctions = [];

		if (this.videoDecoder) {
			try {
				this.videoDecoder.reset();
				this.videoDecoder.close();
			} catch (e) {}
			this.videoDecoder = null;
		}

		if (this.audioDecoder) {
			try {
				this.audioDecoder.reset();
				this.audioDecoder.close();
			} catch (e) {}
			this.audioDecoder = null;
		}

		// Keep AudioContext alive — same rationale as cleanup()

		if (this.dataChannel) {
			this.dataChannel.close();
			this.dataChannel = null;
		}

		if (this.peerConnection) {
			this.peerConnection.close();
			this.peerConnection = null;
		}

		this.isConnected = false;
		this.sessionId = null;

		// Reset stats (prevent stale firstFrameRendered from skipping timing reset)
		this.stats.firstFrameRendered = false;
		this.stats.isConnected = false;

		// Reset audio playback state
		this.nextAudioPlayTime = 0;
		this.audioBufferQueue = [];
		this.audioSyncInitialized = false;
		this.audioCalibrationSamples = 0;
		this.audioOffsetAccumulator = 0;
		this.calibratedAudioOffset = 0;

		// Reset frame rendering state
		this.isRenderingFrame = false;
		this.lastFrameTime = 0;
		this.startTime = 0;
		this.firstFrameTimestamp = 0;
		this.fragmentBuffer = null;
		this.fragmentTimestamp = 0;

		// Reset AV sync state
		this.syncEstablished = false;
		this.syncRealTimeOrigin = 0;
		this.syncStreamTimestamp = 0;
		this.lastVideoTimestamp = 0;
		this.lastVideoRealTime = 0;

		// Clear navigation safety timeout
		if (this.navigationSafetyTimeout) {
			clearTimeout(this.navigationSafetyTimeout);
			this.navigationSafetyTimeout = null;
		}

		this.isCleaningUp = false;
	}

	/**
	 * Clear canvas
	 */
	private clearCanvas(): void {
		if (this.canvas && this.ctx) {
			this.ctx.fillStyle = '#f1f5f9';
			this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
		}
	}

	/**
	 * Get stats
	 */
	getStats(): BrowserWebCodecsStreamStats {
		return { ...this.stats };
	}

	/**
	 * Get connection status
	 */
	getConnectionStatus(): boolean {
		return this.isConnected;
	}

	/**
	 * Immediately block frame rendering without closing the WebRTC connection.
	 * Call this as soon as a tab switch is detected to prevent the old session's
	 * frames from painting onto the canvas after it has been cleared/snapshot-restored.
	 * The cleanup + new connection will complete asynchronously via stopStreaming/startStreaming.
	 */
	pauseRendering(): void {
		this.isCleaningUp = true;
		if (this.renderFrameId !== null) {
			cancelAnimationFrame(this.renderFrameId);
			this.renderFrameId = null;
		}
		if (this.pendingFrame) {
			this.pendingFrame.close();
			this.pendingFrame = null;
		}
	}

	// Event handlers
	setConnectionChangeHandler(handler: (connected: boolean) => void): void {
		this.onConnectionChange = handler;
	}

	setConnectionFailedHandler(handler: () => void): void {
		this.onConnectionFailed = handler;
	}

	setNavigationReconnectHandler(handler: () => void): void {
		this.onNavigationReconnect = handler;
	}

	setReconnectingStartHandler(handler: () => void): void {
		this.onReconnectingStart = handler;
	}

	setFirstFrameHandler(handler: () => void): void {
		this.onFirstFrame = handler;
	}

	/**
	 * Freeze frame rendering briefly during SPA navigation.
	 * Holds the current canvas content to prevent white flash during
	 * SPA page transitions (pushState/replaceState).
	 */
	freezeForSpaNavigation(durationMs = 150): void {
		this.spaFreezeUntil = Date.now() + durationMs;
	}

	setErrorHandler(handler: (error: Error) => void): void {
		this.onError = handler;
	}

	setStatsHandler(handler: (stats: BrowserWebCodecsStreamStats) => void): void {
		this.onStats = handler;
	}

	setOnCursorChange(handler: (cursor: string) => void): void {
		this.onCursorChange = handler;
	}

	/**
	 * Set navigation state
	 * When navigating, DataChannel close/error won't trigger recovery
	 * Backend will restart streaming after navigation completes
	 */
	setNavigating(navigating: boolean): void {
		this.isNavigating = navigating;
		// Clear safety timeout when navigation state is externally reset
		if (!navigating && this.navigationSafetyTimeout) {
			clearTimeout(this.navigationSafetyTimeout);
			this.navigationSafetyTimeout = null;
		}
		debug.log('webcodecs', `Navigation state set: ${navigating}`);
	}

	/**
	 * Check if currently navigating
	 */
	getNavigating(): boolean {
		return this.isNavigating;
	}

	/**
	 * Destroy service
	 */
	destroy(): void {
		this.cleanup();

		// Close AudioContext only on full destroy (not reused after this)
		if (this.audioContext && this.audioContext.state !== 'closed') {
			this.audioContext.close().catch(() => {});
			this.audioContext = null;
		}

		this.onConnectionChange = null;
		this.onConnectionFailed = null;
		this.onNavigationReconnect = null;
		this.onReconnectingStart = null;
		this.onError = null;
		this.onStats = null;
		this.onCursorChange = null;

		// Remove user gesture listener
		if (this.userGestureHandler) {
			document.removeEventListener('click', this.userGestureHandler);
			document.removeEventListener('keydown', this.userGestureHandler);
			this.userGestureHandler = null;
		}
	}
}
