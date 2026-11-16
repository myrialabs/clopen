/**
 * POST /api/hooks/tasks/:token — run a repeating task now, from outside.
 * The token is the credential (see `backend/jobs/hooks.ts`); the request body
 * (text or JSON, up to 8 KB used) becomes the run's context, untrusted.
 */

import { Elysia } from 'elysia';
import { debug } from '$shared/utils/logger';
import { allowHookCall, flowForToken } from '../jobs/hooks';

const MAX_CONTEXT = 8_000;

export const taskHooksRoute = new Elysia().post('/api/hooks/tasks/:token', async ({ request, params }) => {
	const jobId = flowForToken((params as { token: string }).token);
	if (!jobId) return new Response('Not found', { status: 404 });
	if (!allowHookCall(jobId)) return new Response('Too many requests', { status: 429 });
	const body = (await request.text().catch(() => '')).slice(0, MAX_CONTEXT);
	try {
		const { runJob } = await import('../jobs/runner');
		const result = await runJob(jobId, 'webhook', body ? `Sent to this task's webhook:\n${body}` : undefined);
		return Response.json({ ok: true, runId: result.runId, ...(result.skipped ? { skipped: result.skipped } : {}) });
	} catch (error) {
		debug.warn('jobs', 'A task webhook failed:', error);
		return new Response('That task cannot run', { status: 409 });
	}
});
