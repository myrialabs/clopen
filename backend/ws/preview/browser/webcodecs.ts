/**
 * Preview Streaming Handlers
 *
 * Handles video/audio streaming for ultra low-latency, low-bandwidth preview.
 * Currently implemented using WebCodecs with DataChannel delivery.
 * **PROJECT ISOLATION**: Uses project-specific BrowserPreviewService instances
 */

import { createRouter } from '$shared/utils/ws-server';
import { t } from 'elysia';
import { ws } from '$backend/utils/ws';
import { requireBrowserTabAccess } from '../access';

/**
 * Viewer/tab pairs that already have a disconnect cleanup registered.
 * Keyed by project + tab + viewer; the entry is dropped when the cleanup runs,
 * so a reconnecting viewer registers again.
 */
const registeredViewerCleanups = new Set<string>();

export const streamPreviewHandler = createRouter()
	// Start streaming
	.http(
		'preview:browser-stream-start',
		{
			data: t.Object({
				tabId: t.Optional(t.String()),
				// Identifies this viewer for the whole session. A tab can be
				// watched from several devices (and several panels) at once, so
				// every signalling message has to say which peer it belongs to.
				viewerId: t.String(),
				// Legacy VP9-only capability flag — superseded by `codecs`,
				// kept so an older client can still negotiate.
				vp9: t.Optional(t.Boolean()),
				// Full viewer decode capability. Which codecs the viewer can
				// decode *in hardware* decides the encoder choice: software VP9
				// decode is the main reason phones and low-end laptops drop
				// frames no server-side tuning can recover.
				codecs: t.Optional(
					t.Object({
						vp8: t.Boolean(),
						vp9: t.Boolean(),
						avc: t.Boolean(),
						hardware: t.Array(t.String())
					})
				),
				// Viewer display metrics — capture resolution is derived from
				// these so we never encode pixels the screen cannot show.
				display: t.Optional(
					t.Object({
						scale: t.Optional(t.Number()),
						dpr: t.Optional(t.Number())
					})
				)
			}),
			response: t.Object({
				success: t.Boolean(),
				message: t.Optional(t.String()),
				offer: t.Optional(
					t.Object({
						type: t.String(),
						sdp: t.Optional(t.String())
					})
				)
			})
		},
		async ({ data, conn }) => {
			const { previewService, projectId, tab } = requireBrowserTabAccess(conn, data.tabId);

			const sessionId = tab.id;

			// Verify session exists
			if (!previewService.isValidTab(sessionId)) {
				throw new Error('Preview session not found or invalid');
			}

			const codecSupport = data.codecs
				? {
						vp8: data.codecs.vp8,
						vp9: data.codecs.vp9,
						avc: data.codecs.avc,
						hardware: data.codecs.hardware as ('vp8' | 'vp9' | 'avc')[]
					}
				: { vp8: true, vp9: data.vp9 !== false, avc: false, hardware: [] };

			// Start WebCodecs streaming
			const started = await previewService.startWebCodecsStreaming(sessionId, {
				viewerId: data.viewerId,
				codecSupport,
				display: data.display
			});

			if (!started) {
				throw new Error('Failed to start WebCodecs streaming');
			}

			// A viewer that goes away without a stop — the tab is closed, the
			// laptop sleeps, the tunnel drops — must not keep the capture alive
			// for an audience of nobody.
			//
			// Registered once per viewer and tab: switching tabs back and forth
			// re-runs this handler, and a fresh closure each time would pile up
			// on a connection that can live for hours.
			const viewerId = data.viewerId;
			const cleanupKey = `${projectId}:${sessionId}:${viewerId}`;
			if (!registeredViewerCleanups.has(cleanupKey)) {
				registeredViewerCleanups.add(cleanupKey);
				ws.addCleanup(conn, () => {
					registeredViewerCleanups.delete(cleanupKey);
					void previewService.stopWebCodecsStreaming(sessionId, viewerId);
				});
			}

			// Get offer from headless browser
			const offer = await previewService.getWebCodecsOffer(sessionId, data.viewerId);

			return {
				success: true,
				message: 'WebCodecs streaming started',
				offer: offer
					? {
							type: offer.type as string,
							sdp: offer.sdp
						}
					: undefined
			};
		}
	)

	// Get SDP offer from headless browser
	.http(
		'preview:browser-stream-offer',
		{
			data: t.Object({
				tabId: t.Optional(t.String()),
				viewerId: t.String()
			}),
			response: t.Object({
				success: t.Boolean(),
				offer: t.Optional(
					t.Object({
						type: t.String(),
						sdp: t.Optional(t.String())
					})
				)
			})
		},
		async ({ data, conn }) => {
			const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);

			const offer = await previewService.getWebCodecsOffer(tab.id, data.viewerId);

			return {
				success: !!offer,
				offer: offer
					? {
							type: offer.type as string,
							sdp: offer.sdp
						}
					: undefined
			};
		}
	)

	// Handle SDP answer from client
	.http(
		'preview:browser-stream-answer',
		{
			data: t.Object({
				answer: t.Object({
					type: t.String(),
					sdp: t.Optional(t.String())
				}),
				tabId: t.Optional(t.String()),
				viewerId: t.String()
			}),
			response: t.Object({
				success: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);

			const { answer } = data;
			const success = await previewService.handleWebCodecsAnswer(
				tab.id,
				data.viewerId,
				answer as RTCSessionDescriptionInit
			);

			return { success };
		}
	)

	// Exchange ICE candidates
	.http(
		'preview:browser-stream-ice',
		{
			data: t.Object({
				candidate: t.Object({
					candidate: t.Optional(t.String()),
					sdpMid: t.Optional(t.Union([t.String(), t.Null()])),
					sdpMLineIndex: t.Optional(t.Union([t.Number(), t.Null()]))
				}),
				tabId: t.Optional(t.String()),
				viewerId: t.String()
			}),
			response: t.Object({
				success: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);

			const { candidate } = data;
			const success = await previewService.addWebCodecsIceCandidate(
				tab.id,
				data.viewerId,
				candidate as RTCIceCandidateInit
			);

			return { success };
		}
	)

	// Client-driven keyframe request (PLI equivalent) — sent when the client
	// decoder errors or joins mid-stream and needs a sync point
	.http(
		'preview:browser-stream-keyframe',
		{
			data: t.Object({
				tabId: t.Optional(t.String())
			}),
			response: t.Object({
				success: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);

			const success = await previewService.requestWebCodecsKeyframe(tab.id);

			return { success };
		}
	)

	// Viewer decoder health, reported periodically while connected.
	//
	// Backpressure used to be network-only: the source watched its own send
	// buffer and nothing else. A viewer that cannot decode fast enough stutters
	// identically with an empty buffer, so its decode queue has to travel back
	// to the source for the adaptation loop to be closed.
	.http(
		'preview:browser-stream-feedback',
		{
			data: t.Object({
				tabId: t.Optional(t.String()),
				viewerId: t.String(),
				decodeQueueSize: t.Number(),
				decodeLatencyMs: t.Number(),
				dropRatio: t.Number()
			}),
			response: t.Object({
				success: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);

			previewService.applyWebCodecsClientFeedback(tab.id, data.viewerId, {
				decodeQueueSize: data.decodeQueueSize,
				decodeLatencyMs: data.decodeLatencyMs,
				dropRatio: data.dropRatio
			});

			return { success: true };
		}
	)

	// Viewer display metrics changed (panel resize, device swap, moved to a
	// different-density screen). Capture resolution follows this.
	.http(
		'preview:browser-stream-display',
		{
			data: t.Object({
				tabId: t.Optional(t.String()),
				viewerId: t.String(),
				scale: t.Optional(t.Number()),
				dpr: t.Optional(t.Number())
			}),
			response: t.Object({
				success: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);

			const success = previewService.applyWebCodecsDisplayMetrics(tab.id, data.viewerId, {
				scale: data.scale,
				dpr: data.dpr
			});

			return { success };
		}
	)

	// Suspend/resume capture when the preview leaves or re-enters view.
	// An unwatched preview otherwise keeps a headless renderer and an encoder
	// busy indefinitely — the dominant idle cost on a shared host.
	.http(
		'preview:browser-stream-visibility',
		{
			data: t.Object({
				tabId: t.Optional(t.String()),
				viewerId: t.String(),
				visible: t.Boolean()
			}),
			response: t.Object({
				success: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);

			const success = await previewService.setWebCodecsPaused(tab.id, data.viewerId, !data.visible);

			return { success };
		}
	)

	// Stop streaming for one viewer. The capture itself only stops when the
	// last viewer detaches.
	.http(
		'preview:browser-stream-stop',
		{
			data: t.Object({
				tabId: t.Optional(t.String()),
				viewerId: t.String()
			}),
			response: t.Object({
				success: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);

			await previewService.stopWebCodecsStreaming(tab.id, data.viewerId);

			return { success: true };
		}
	)

	// Server → Client: ICE candidate from headless browser.
	// Broadcast to the project room, so `viewerId` is what tells each viewer
	// which candidates belong to its own peer.
	.emit(
		'preview:browser-stream-ice',
		t.Object({
			sessionId: t.String(), // Internal session ID (kept for routing)
			viewerId: t.String(),
			candidate: t.Object({
				candidate: t.Optional(t.String()),
				sdpMid: t.Optional(t.Union([t.String(), t.Null()])),
				sdpMLineIndex: t.Optional(t.Union([t.Number(), t.Null()]))
			}),
			from: t.String() // 'headless' or 'client'
		})
	)

	// Server → Client: Connection state update
	.emit(
		'preview:browser-stream-state',
		t.Object({
			sessionId: t.String(), // Internal session ID (kept for routing)
			viewerId: t.String(),
			state: t.String()
		})
	)

	// Server → Client: Cursor style update
	.emit(
		'preview:browser-cursor-change',
		t.Object({
			sessionId: t.String(), // Internal session ID (kept for routing)
			cursor: t.String()
		})
	)

	// Server → Client: Navigation started (loading)
	.emit(
		'preview:browser-navigation-loading',
		t.Object({
			sessionId: t.String(),
			type: t.String(),
			url: t.String(),
			timestamp: t.Number()
		})
	)

	// Server → Client: Navigation completed
	.emit(
		'preview:browser-navigation',
		t.Object({
			sessionId: t.String(),
			type: t.String(),
			url: t.String(),
			timestamp: t.Number()
		})
	)

	// Server → Client: SPA navigation (pushState/replaceState — URL-only update, no page reload)
	.emit(
		'preview:browser-navigation-spa',
		t.Object({
			sessionId: t.String(),
			type: t.String(),
			url: t.String(),
			timestamp: t.Number()
		})
	);

// Event forwarding lives in BrowserPreviewServiceManager, which owns the
// per-project service instances and can name the project each event belongs to.
