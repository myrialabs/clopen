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

import ws from '$frontend/lib/utils/ws';
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

	// ICE servers
	private readonly iceServers: RTCIceServer[] = [
		{ urls: 'stun:stun.l.google.com:19302' },
		{ urls: 'stun:stun1.l.google.com:19302' }
	];

	// Callbacks
	private onConnectionChange: ((connected: boolean) => void) | null = null;
	private onConnectionFailed: (() => void) | null = null;
	private onNavigationReconnect: (() => void) | null = null; // Fast reconnection after navigation
	private onReconnectingStart: (() => void) | null = null; // Signals reconnecting state started (for UI)
	private onError: ((error: Error) => void) | null = null;
	private onStats: ((stats: BrowserWebCodecsStreamStats) => void) | null = null;
	private onCursorChange: ((cursor: string) => void) | null = null;

	// Navigation state - when true, DataChannel close is expected and recovery is suppressed
	private isNavigating = false;
	private navigationCleanupFn: (() => void) | null = null;

	// WebSocket cleanup
	private wsCleanupFunctions: Array<() => void> = [];

	// Stats interval
	private statsIntervalId: ReturnType<typeof setInterval> | null = null;

	// Bandwidth logging interval
	private bandwidthLogIntervalId: ReturnType<typeof setInterval> | null = null;

	constructor(projectId: string) {
		if (!projectId) {
			throw new Error('projectId is required for BrowserWebCodecsService');
		}
		this.projectId = projectId;
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
		debug.log('webcodecs', `Starting streaming for session: ${sessionId}`);

		if (!BrowserWebCodecsService.isSupported()) {
			debug.error('webcodecs', 'Not supported in this browser');
			if (this.onError) {
				this.onError(new Error('WebCodecs not supported'));
			}
			return false;
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
			this.ctx.imageSmoothingQuality = 'low';
		}

		this.clearCanvas();

		try {
			// Setup WebSocket listeners
			this.setupEventListeners();

			// Request server to start streaming and get offer
			const response = await ws.http('preview:browser-stream-start', {}, 30000);

			if (!response.success) {
				throw new Error(response.message || 'Failed to start streaming');
			}

			// Create peer connection
			await this.createPeerConnection();

			// Set remote description (offer)
			if (response.offer) {
				await this.handleOffer({
					type: response.offer.type as RTCSdpType,
					sdp: response.offer.sdp
				});
			} else {
				const offerResponse = await ws.http('preview:browser-stream-offer', {}, 10000);
				if (offerResponse.offer) {
					await this.handleOffer({
						type: offerResponse.offer.type as RTCSdpType,
						sdp: offerResponse.offer.sdp
					});
				} else {
					throw new Error('No offer received from server');
				}
			}

			debug.log('webcodecs', 'Streaming setup complete');
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
					// Backend needs ~500ms to restart streaming with new peer
					// Wait for backend to be ready, then trigger FAST reconnection (no delay)
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
					}, 700); // Wait 700ms for backend to restart (usually takes ~500ms)
				}
			};

			this.dataChannel.onerror = (error) => {
				debug.error('webcodecs', 'DataChannel error:', error);
				debug.log('webcodecs', `DataChannel error state: isConnected=${this.isConnected}, isCleaningUp=${this.isCleaningUp}, isNavigating=${this.isNavigating}`);
				// Trigger recovery on DataChannel error
				// BUT skip recovery if we're navigating (expected behavior during page navigation)
				if (this.isConnected && !this.isCleaningUp && !this.isNavigating && this.onConnectionFailed) {
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
				// Backend uses active tab automatically
				ws.http('preview:browser-stream-ice', {
					candidate: {
						candidate: event.candidate.candidate,
						sdpMid: event.candidate.sdpMid,
						sdpMLineIndex: event.candidate.sdpMLineIndex
					}
				}).catch((error) => {
					debug.warn('webcodecs', 'Failed to send ICE candidate:', error);
				});
			}
		};

		// Handle connection state
		this.peerConnection.onconnectionstatechange = () => {
			const state = this.peerConnection?.connectionState || 'closed';
			debug.log('webcodecs', `Connection state: ${state}`);

			this.stats.connectionState = state as RTCPeerConnectionState;

			if (state === 'connected') {
				this.isConnected = true;
				this.stats.isConnected = true;
				this.startStatsCollection();
				// this.startBandwidthLogging();
				if (this.onConnectionChange) {
					this.onConnectionChange(true);
				}
			} else if (state === 'failed') {
				debug.error('webcodecs', 'Connection FAILED');
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
			} else if (state === 'disconnected' || state === 'closed') {
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
			// Backend uses active tab automatically
			await ws.http('preview:browser-stream-answer', {
				answer: {
					type: answer.type,
					sdp: answer.sdp
				}
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
				// Format: [type(1)][timestamp(8)][keyframe(1)][size(4)][data]
				const timestamp = Number(view.getBigUint64(1, true));
				const isKeyframe = view.getUint8(9) === 1;
				const size = view.getUint32(10, true);
				const chunkData = new Uint8Array(data, 14, size);

				this.stats.videoBytesReceived += size;
				this.stats.videoFramesReceived++;

				this.handleVideoChunk(chunkData, timestamp, isKeyframe);
			} else if (type === 1) {
				// Audio packet
				// Format: [type(1)][timestamp(8)][size(4)][data]
				const timestamp = Number(view.getBigUint64(1, true));
				const size = view.getUint32(9, true);
				const chunkData = new Uint8Array(data, 13, size);

				this.stats.audioBytesReceived += size;
				this.stats.audioFramesReceived++;

				this.handleAudioChunk(chunkData, timestamp);
			}
		} catch (error) {
			debug.error('webcodecs', 'DataChannel message parse error:', error);
		}
	}

	/**
	 * Handle video chunk - decode and render
	 */
	private async handleVideoChunk(data: Uint8Array, timestamp: number, isKeyframe: boolean): Promise<void> {
		// Initialize decoder on first keyframe
		if (!this.videoDecoder && isKeyframe) {
			await this.initVideoDecoder(data);
		}

		if (!this.videoDecoder) {
			this.stats.videoFramesDropped++;
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
	 * Initialize VideoDecoder
	 */
	private async initVideoDecoder(firstChunkData: Uint8Array): Promise<void> {
		// Use VP8 codec
		const codec = 'vp8';
		this.stats.videoCodec = 'vp8';

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
				}
			});

			this.videoDecoder.configure(this.videoCodecConfig);
			debug.log('webcodecs', 'VideoDecoder initialized:', codec);
		} catch (error) {
			debug.error('webcodecs', 'VideoDecoder init error:', error);
			throw error;
		}
	}

	/**
	 * Initialize AudioDecoder
	 */
	private async initAudioDecoder(): Promise<void> {
		this.audioCodecConfig = {
			codec: 'opus',
			sampleRate: 44100,
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
			this.audioContext = new AudioContext({ sampleRate: 44100 });
			debug.log('webcodecs', 'AudioContext initialized');
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

				// Reset navigation state - frames are flowing, navigation is complete
				if (this.isNavigating) {
					debug.log('webcodecs', 'Navigation complete - frames received, resetting navigation state');
					this.isNavigating = false;
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
			return;
		}

		try {
			// Calculate frame timing (similar to requestVideoFrameCallback metadata)
			// Use relative timestamp from first frame to sync with frontend clock
			const frameTimestamp = (this.pendingFrame.timestamp - this.firstFrameTimestamp) / 1000; // convert to ms
			const elapsedTime = timestamp - this.startTime;

			// Check if we're ahead of schedule (frame came too early)
			// If so, we might want to delay rendering, but for low-latency
			// we render immediately to minimize lag
			const timeDrift = elapsedTime - frameTimestamp;

			// Only log significant drift (for debugging)
			if (Math.abs(timeDrift) > 100) {
				// Drift more than 100ms is significant
				debug.warn('webcodecs', `Frame timing drift: ${timeDrift.toFixed(0)}ms`);
			}

			// Render to canvas with optimal settings
			this.ctx.drawImage(this.pendingFrame, 0, 0, this.canvas.width, this.canvas.height);

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
	 * Play audio frame with proper AV synchronization
	 *
	 * The key insight: Audio and video timestamps from the server use the same
	 * performance.now() origin. However, audio may start LATER than video if the
	 * page has no audio initially (silence is skipped).
	 *
	 * Solution: Use lastVideoTimestamp (currently rendered video) as the reference
	 * point, not the first video frame timestamp. This ensures we synchronize
	 * audio to the CURRENT video position, not the initial position.
	 */
	private playAudioFrame(audioData: AudioData): void {
		if (!this.audioContext) return;

		try {
			// Create AudioBuffer
			const buffer = this.audioContext.createBuffer(
				audioData.numberOfChannels,
				audioData.numberOfFrames,
				audioData.sampleRate
			);

			// Copy audio data to buffer
			for (let channel = 0; channel < audioData.numberOfChannels; channel++) {
				const options = {
					planeIndex: channel,
					frameOffset: 0,
					frameCount: audioData.numberOfFrames,
					format: 'f32-planar' as AudioSampleFormat
				};

				const requiredSize = audioData.allocationSize(options);
				const tempBuffer = new ArrayBuffer(requiredSize);
				const tempFloat32 = new Float32Array(tempBuffer);
				audioData.copyTo(tempFloat32, options);

				const channelData = buffer.getChannelData(channel);
				channelData.set(tempFloat32);
			}

			const currentTime = this.audioContext.currentTime;
			const audioTimestamp = audioData.timestamp; // microseconds
			const bufferDuration = buffer.duration;
			const now = performance.now();

			// Wait for video to establish sync before playing audio
			if (!this.syncEstablished || this.lastVideoTimestamp === 0) {
				// No video yet - skip this audio frame to prevent desync
				return;
			}

			// Phase 1: Calibration - collect samples to determine stable offset
			if (this.audioCalibrationSamples < this.CALIBRATION_SAMPLES) {
				// Calculate the offset between audio timestamp and video timeline
				// audioVideoOffset > 0 means audio is AHEAD of video in stream time
				// audioVideoOffset < 0 means audio is BEHIND video in stream time
				const audioVideoOffset = (audioTimestamp - this.lastVideoTimestamp) / 1000000; // seconds

				// Also account for the time elapsed since video was rendered
				const timeSinceVideoRender = (now - this.lastVideoRealTime) / 1000; // seconds

				// Expected audio position relative to current video position
				// If audio and video are in sync, audio should play at:
				// currentTime + audioVideoOffset - timeSinceVideoRender
				const expectedOffset = audioVideoOffset - timeSinceVideoRender;

				this.audioOffsetAccumulator += expectedOffset;
				this.audioCalibrationSamples++;

				if (this.audioCalibrationSamples === this.CALIBRATION_SAMPLES) {
					// Calibration complete - calculate average offset
					this.calibratedAudioOffset = this.audioOffsetAccumulator / this.CALIBRATION_SAMPLES;

					// Clamp the offset to reasonable bounds (-500ms to +500ms)
					// Beyond this, something is wrong and we should just play immediately
					if (this.calibratedAudioOffset < -0.5) {
						debug.warn('webcodecs', `Audio calibration: offset ${(this.calibratedAudioOffset * 1000).toFixed(0)}ms too negative, clamping to -500ms`);
						this.calibratedAudioOffset = -0.5;
					} else if (this.calibratedAudioOffset > 0.5) {
						debug.warn('webcodecs', `Audio calibration: offset ${(this.calibratedAudioOffset * 1000).toFixed(0)}ms too positive, clamping to +500ms`);
						this.calibratedAudioOffset = 0.5;
					}

					// Initialize nextAudioPlayTime based on calibrated offset
					// Add small buffer (30ms) for smooth playback
					this.nextAudioPlayTime = currentTime + Math.max(0.03, this.calibratedAudioOffset + 0.03);
					this.audioSyncInitialized = true;

					debug.log('webcodecs', `Audio calibration complete: offset=${(this.calibratedAudioOffset * 1000).toFixed(1)}ms, startTime=${(this.nextAudioPlayTime - currentTime).toFixed(3)}s from now`);
				} else {
					// Still calibrating - skip this audio frame
					return;
				}
			}

			// Phase 2: Synchronized playback with drift correction
			let targetPlayTime = this.nextAudioPlayTime;

			// If we've fallen too far behind (buffer underrun), reset
			if (targetPlayTime < currentTime - 0.01) {
				// We're behind by more than 10ms, need to catch up
				targetPlayTime = currentTime + 0.02; // Small buffer to recover
				debug.warn('webcodecs', 'Audio buffer underrun, resetting playback');
			}

			// Periodic drift check (every ~500ms worth of audio, ~25 frames)
			if (this.stats.audioFramesDecoded % 25 === 0) {
				// Recalculate where audio SHOULD be based on current video position
				const audioVideoOffset = (audioTimestamp - this.lastVideoTimestamp) / 1000000;
				const timeSinceVideoRender = (now - this.lastVideoRealTime) / 1000;
				const expectedOffset = audioVideoOffset - timeSinceVideoRender;

				// Where audio should play relative to currentTime
				const idealTime = currentTime + expectedOffset + 0.03; // +30ms buffer

				const drift = targetPlayTime - idealTime;

				// Apply correction based on drift magnitude
				if (Math.abs(drift) > 0.2) {
					// Large drift (>200ms) - aggressive correction (80%)
					targetPlayTime -= drift * 0.8;
					debug.warn('webcodecs', `Large audio drift: ${(drift * 1000).toFixed(0)}ms, aggressive correction`);
				} else if (Math.abs(drift) > 0.05) {
					// Medium drift (50-200ms) - moderate correction (40%)
					targetPlayTime -= drift * 0.4;
				}
				// Small drift (<50ms) - no correction, continuous playback handles it
			}

			// Ensure we don't schedule in the past
			if (targetPlayTime < currentTime + 0.005) {
				targetPlayTime = currentTime + 0.005;
			}

			// Schedule this buffer
			const source = this.audioContext.createBufferSource();
			source.buffer = buffer;
			source.connect(this.audioContext.destination);
			source.start(targetPlayTime);

			// Track scheduled buffer
			this.audioBufferQueue.push({ buffer, scheduledTime: targetPlayTime });

			// Update next play time for continuous scheduling (back-to-back)
			this.nextAudioPlayTime = targetPlayTime + bufferDuration;

			// Limit queue size to prevent memory buildup
			if (this.audioBufferQueue.length > this.maxAudioQueueSize) {
				this.audioBufferQueue.shift();
			}

			// Cleanup old scheduled buffers
			source.onended = () => {
				const index = this.audioBufferQueue.findIndex(item => item.buffer === buffer);
				if (index !== -1) {
					this.audioBufferQueue.splice(index, 1);
				}
			};
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
				// Keep isNavigating true for a short period to allow reconnection
				// Will be reset when new frames arrive or reconnection completes
				debug.log('webcodecs', `Navigation completed (direct WS) for session ${data.sessionId}`);
				// Signal reconnecting state IMMEDIATELY when navigation completes
				// This eliminates the gap between isNavigating=false and DataChannel close
				// ensuring the overlay stays visible continuously
				if (this.onReconnectingStart) {
					debug.log('webcodecs', '🔄 Pre-emptive reconnecting state on navigation complete');
					this.onReconnectingStart();
				}
			}
		});

		this.wsCleanupFunctions = [cleanupIce, cleanupState, cleanupCursor, cleanupNavLoading, cleanupNavComplete];
	}

	/**
	 * Add ICE candidate
	 */
	private async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
		if (!this.peerConnection) return;

		try {
			await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
		} catch (error) {
			debug.warn('webcodecs', 'Add ICE candidate error:', error);
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
			this.ctx.imageSmoothingQuality = 'low';
		}

		try {
			// Setup WebSocket listeners
			this.setupEventListeners();

			// Create peer connection
			await this.createPeerConnection();

			// Get offer from backend's existing peer (don't start new streaming)
			const offerResponse = await ws.http('preview:browser-stream-offer', {}, 10000);
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
		this.wsCleanupFunctions.forEach((cleanup) => cleanup());
		this.wsCleanupFunctions = [];

		// Close decoders
		if (this.videoDecoder) {
			try {
				await this.videoDecoder.flush();
				this.videoDecoder.close();
			} catch (e) {}
			this.videoDecoder = null;
		}

		if (this.audioDecoder) {
			try {
				await this.audioDecoder.flush();
				this.audioDecoder.close();
			} catch (e) {}
			this.audioDecoder = null;
		}

		// Close audio context
		if (this.audioContext && this.audioContext.state !== 'closed') {
			await this.audioContext.close().catch(() => {});
			this.audioContext = null;
		}

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
		this.wsCleanupFunctions.forEach((cleanup) => cleanup());
		this.wsCleanupFunctions = [];

		// Notify server
		if (this.sessionId) {
			try {
				await ws.http('preview:browser-stream-stop', {});
			} catch (error) {
				debug.warn('webcodecs', 'Failed to notify server:', error);
			}
		}

		// Close decoders
		if (this.videoDecoder) {
			try {
				await this.videoDecoder.flush();
				this.videoDecoder.close();
			} catch (e) {}
			this.videoDecoder = null;
		}

		if (this.audioDecoder) {
			try {
				await this.audioDecoder.flush();
				this.audioDecoder.close();
			} catch (e) {}
			this.audioDecoder = null;
		}

		// Close audio context
		if (this.audioContext && this.audioContext.state !== 'closed') {
			await this.audioContext.close().catch(() => {});
			this.audioContext = null;
		}

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

		// Reset AV sync state
		this.syncEstablished = false;
		this.syncRealTimeOrigin = 0;
		this.syncStreamTimestamp = 0;
		this.lastVideoTimestamp = 0;
		this.lastVideoRealTime = 0;

		// Reset navigation state
		this.isNavigating = false;

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

		this.wsCleanupFunctions.forEach((cleanup) => cleanup());
		this.wsCleanupFunctions = [];

		if (this.videoDecoder) {
			try {
				await this.videoDecoder.flush();
				this.videoDecoder.close();
			} catch (e) {}
			this.videoDecoder = null;
		}

		if (this.audioDecoder) {
			try {
				await this.audioDecoder.flush();
				this.audioDecoder.close();
			} catch (e) {}
			this.audioDecoder = null;
		}

		if (this.audioContext && this.audioContext.state !== 'closed') {
			await this.audioContext.close().catch(() => {});
			this.audioContext = null;
		}

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

		// Reset AV sync state
		this.syncEstablished = false;
		this.syncRealTimeOrigin = 0;
		this.syncStreamTimestamp = 0;
		this.lastVideoTimestamp = 0;
		this.lastVideoRealTime = 0;

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
		this.onConnectionChange = null;
		this.onConnectionFailed = null;
		this.onNavigationReconnect = null;
		this.onReconnectingStart = null;
		this.onError = null;
		this.onStats = null;
		this.onCursorChange = null;
	}
}
