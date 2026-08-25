/**
 * Preview Video Decode Worker
 *
 * Packet parsing, fragment reassembly and VideoDecoder all run here instead of
 * on the page's main thread.
 *
 * On a capable machine this is invisible. On a low-end device it is the
 * difference between a smooth preview and a stuttering one: software VP9/H.264
 * decode at 20+ fps competes directly with Svelte reactivity, the terminal and
 * the chat view for the same thread, so whichever runs first starves the
 * other. Off-thread, the main thread's only remaining job is `drawImage`.
 *
 * Decoded frames go back as transferred `VideoFrame` objects (zero copy). Some
 * engines don't allow transferring them, so the first failure permanently
 * switches this worker to transferring `ImageBitmap` instead — one extra GPU
 * copy, still off the main thread.
 */

/** Wire codec ids — must match VIDEO_CODEC_ID in backend/preview/browser/types.ts. */
const CODEC_STRINGS: Record<number, string> = {
	0: 'vp8',
	1: 'vp09.00.10.08',
	2: 'avc1.42E033'
};

interface DecoderState {
	decoder: VideoDecoder | null;
	codecId: number;
	preferHardware: boolean;
}

const state: DecoderState = {
	decoder: null,
	codecId: -1,
	preferHardware: true
};

let fragmentBuffer: Uint8Array[] | null = null;
let fragmentTimestamp = 0;
let fragmentExpected = 0;

/** Set once a VideoFrame transfer is rejected — falls back to ImageBitmap. */
let canTransferFrames = true;

// Rolling decode-health counters, drained by the service every report window.
let framesReceived = 0;
let framesDecoded = 0;
let decodeLatencyTotal = 0;
let decodeLatencySamples = 0;
const pendingTimestamps = new Map<number, number>();

function post(message: unknown, transfer?: Transferable[]) {
	if (transfer && transfer.length > 0) {
		(self as unknown as Worker).postMessage(message, transfer);
	} else {
		(self as unknown as Worker).postMessage(message);
	}
}

function closeDecoder() {
	if (state.decoder) {
		try {
			state.decoder.reset();
			state.decoder.close();
		} catch {}
	}
	state.decoder = null;
	state.codecId = -1;
	pendingTimestamps.clear();
}

async function emitFrame(frame: VideoFrame) {
	const started = pendingTimestamps.get(frame.timestamp);
	if (started !== undefined) {
		pendingTimestamps.delete(frame.timestamp);
		decodeLatencyTotal += performance.now() - started;
		decodeLatencySamples++;
	}
	framesDecoded++;

	// Geometry and timestamp travel alongside the frame: an ImageBitmap
	// carries neither, and the renderer needs both for 1:1 drawing and A/V sync.
	const meta = {
		t: 'frame' as const,
		timestamp: frame.timestamp,
		width: frame.displayWidth,
		height: frame.displayHeight
	};

	if (canTransferFrames) {
		try {
			post({ ...meta, frame, kind: 'videoframe' }, [frame as unknown as Transferable]);
			return;
		} catch {
			// Engine refuses to transfer VideoFrame — stop trying.
			canTransferFrames = false;
		}
	}

	try {
		const bitmap = await createImageBitmap(frame);
		post({ ...meta, frame: bitmap, kind: 'imagebitmap' }, [bitmap]);
	} catch {
		// Nothing renderable — drop it rather than leaking the frame.
	} finally {
		try {
			frame.close();
		} catch {}
	}
}

async function ensureDecoder(codecId: number): Promise<boolean> {
	if (state.decoder && state.codecId === codecId) return true;

	closeDecoder();

	const codec = CODEC_STRINGS[codecId];
	if (!codec) return false;

	const config: VideoDecoderConfig = {
		codec,
		optimizeForLatency: true,
		// A hint, not a guarantee — but on phones and low-end laptops it is
		// what routes H.264 to the dedicated decoder instead of the CPU.
		hardwareAcceleration: state.preferHardware ? 'prefer-hardware' : 'no-preference'
	};

	try {
		let support = await VideoDecoder.isConfigSupported(config);
		if (!support.supported && state.preferHardware) {
			config.hardwareAcceleration = 'no-preference';
			support = await VideoDecoder.isConfigSupported(config);
		}
		if (!support.supported) return false;

		state.decoder = new VideoDecoder({
			output: (frame) => {
				void emitFrame(frame);
			},
			error: () => {
				// Null out so the next keyframe reinitialises. Leaving a closed
				// decoder in place would silently drop every later frame.
				closeDecoder();
				post({ t: 'keyframe-request' });
			}
		});

		state.decoder.configure(config);
		state.codecId = codecId;
		post({ t: 'codec', codecId, codec });
		return true;
	} catch {
		closeDecoder();
		return false;
	}
}

async function decodeChunk(data: Uint8Array, timestamp: number, isKeyframe: boolean, codecId: number) {
	// Codec changed mid-stream (navigation re-injected the encoder, or the
	// adaptation loop switched codecs) — swap on the keyframe.
	if (state.decoder && isKeyframe && codecId !== state.codecId) {
		closeDecoder();
	}

	if (!state.decoder && isKeyframe) {
		await ensureDecoder(codecId);
	}

	if (!state.decoder) {
		// Delta frame with no decoder (joined mid-stream, or the decoder just
		// errored) — ask for a sync point instead of waiting one out.
		post({ t: 'keyframe-request' });
		return;
	}

	try {
		pendingTimestamps.set(timestamp, performance.now());
		state.decoder.decode(
			new EncodedVideoChunk({
				type: isKeyframe ? 'key' : 'delta',
				timestamp,
				data
			})
		);
	} catch {
		pendingTimestamps.delete(timestamp);
		closeDecoder();
		post({ t: 'keyframe-request' });
	}
}

function handlePacket(buffer: ArrayBuffer) {
	const view = new DataView(buffer);
	const type = view.getUint8(0);

	if (type === 0) {
		// [type(1)][timestamp(8)][keyframe(1)][codec(1)][size(4)][data]
		const timestamp = Number(view.getBigUint64(1, true));
		const isKeyframe = view.getUint8(9) === 1;
		const codecId = view.getUint8(10);
		const size = view.getUint32(11, true);
		framesReceived++;
		void decodeChunk(new Uint8Array(buffer, 15, size), timestamp, isKeyframe, codecId);
		return;
	}

	if (type === 2) {
		// [type(1)][timestamp(8)][keyframe(1)][codec(1)][fragIndex(2)][fragCount(2)][size(4)][data]
		const timestamp = Number(view.getBigUint64(1, true));
		const isKeyframe = view.getUint8(9) === 1;
		const codecId = view.getUint8(10);
		const fragIndex = view.getUint16(11, true);
		const fragCount = view.getUint16(13, true);
		const size = view.getUint32(15, true);
		const fragData = new Uint8Array(buffer, 19, size);

		// A new timestamp invalidates any incomplete set. The channel is
		// reliable and ordered so this shouldn't happen — it's a safety net
		// against desync after a reconnect.
		if (!fragmentBuffer || fragmentTimestamp !== timestamp) {
			fragmentBuffer = [];
			fragmentTimestamp = timestamp;
			fragmentExpected = fragCount;
		}
		fragmentBuffer[fragIndex] = fragData;

		let received = 0;
		for (const frag of fragmentBuffer) if (frag) received++;
		if (received !== fragmentExpected) return;

		let total = 0;
		for (const frag of fragmentBuffer) total += frag.byteLength;
		const full = new Uint8Array(total);
		let offset = 0;
		for (const frag of fragmentBuffer) {
			full.set(frag, offset);
			offset += frag.byteLength;
		}
		fragmentBuffer = null;

		framesReceived++;
		void decodeChunk(full, timestamp, isKeyframe, codecId);
	}
}

function drainStats() {
	const stats = {
		t: 'stats' as const,
		decodeQueueSize: state.decoder?.decodeQueueSize ?? 0,
		decodeLatencyMs: decodeLatencySamples > 0 ? decodeLatencyTotal / decodeLatencySamples : 0,
		framesReceived,
		framesDecoded
	};

	framesReceived = 0;
	framesDecoded = 0;
	decodeLatencyTotal = 0;
	decodeLatencySamples = 0;

	post(stats);
}

self.onmessage = (event: MessageEvent) => {
	const data = event.data;

	switch (data?.t) {
		case 'packet':
			try {
				handlePacket(data.buffer as ArrayBuffer);
			} catch {
				// Malformed packet — drop it, the next keyframe resyncs.
			}
			break;

		case 'stats':
			drainStats();
			break;

		case 'reset':
			closeDecoder();
			fragmentBuffer = null;
			fragmentTimestamp = 0;
			break;

		case 'init':
			state.preferHardware = data.preferHardware !== false;
			// WebCodecs is not exposed to workers everywhere. Say so up front
			// rather than accepting packets and silently decoding nothing.
			post({ t: 'ready', ok: typeof VideoDecoder !== 'undefined' });
			break;

		case 'close':
			closeDecoder();
			self.close();
			break;
	}
};
