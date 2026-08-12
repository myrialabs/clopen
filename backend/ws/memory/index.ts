/**
 * Memory Router — the Memory Graph panel and Settings → Infrastructure → Memory.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { memoryCrudHandler } from './crud';

export const memoryRouter = createRouter()
	/**
	 * The graph changed. Broadcast globally rather than per session, because the
	 * memory graph is instance-wide: a memory written by one member's chat is
	 * immediately part of what every other member's Memory view is showing.
	 *
	 * The payload deliberately carries no data, only a reason. Diffing the graph
	 * over the wire would mean a second serialization format to keep in step with
	 * `memory:graph`, and the view refetches in a few milliseconds anyway — this
	 * is a doorbell, not a delivery.
	 */
	.emit('memory:changed', t.Object({
		reason: t.String(),
		projectId: t.Union([t.String(), t.Null()])
	}))
	/**
	 * The extraction queue moved: something was enqueued, retried, or gave up.
	 *
	 * Separate from `memory:changed` because a queue event frequently means NOTHING
	 * was written — a model failed, or none is configured — which is precisely the
	 * situation where a silent UI is worst.
	 */
	.emit('memory:status-changed', t.Object({}))
	/**
	 * Setup progressed: the embedding artifact started downloading, landed or
	 * failed, or an extraction model was chosen.
	 *
	 * Distinct from the queue event because it answers "is memory usable at all"
	 * rather than "is there work outstanding". The setup banner listens to this one
	 * and to nothing else, so a busy extraction queue cannot make it flicker.
	 */
	.emit('memory:readiness-changed', t.Object({}))
	.merge(memoryCrudHandler);
