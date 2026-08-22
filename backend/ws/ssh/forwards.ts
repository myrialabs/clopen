/**
 * ssh-client — port forwarding WS handlers.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { sshPortForwardQueries } from '../../database/queries';
import { sshForwardManager } from '../../ssh/forwards';
import type { SshForwardInput } from '$shared/types/ssh';
import { requireSshConnection, requireSshForward } from './access';

const forwardTypeSchema = t.Union([t.Literal('local'), t.Literal('remote'), t.Literal('dynamic')]);

const forwardInputSchema = t.Object({
	name: t.String({ minLength: 1 }),
	type: forwardTypeSchema,
	listenHost: t.Optional(t.String()),
	listenPort: t.Number({ minimum: 0, maximum: 65535 }),
	destHost: t.Optional(t.String()),
	destPort: t.Optional(t.Number({ minimum: 0, maximum: 65535 })),
	autoStart: t.Optional(t.Boolean())
});

const forwardPatchSchema = t.Object({
	name: t.Optional(t.String({ minLength: 1 })),
	type: t.Optional(forwardTypeSchema),
	listenHost: t.Optional(t.String()),
	listenPort: t.Optional(t.Number({ minimum: 0, maximum: 65535 })),
	destHost: t.Optional(t.String()),
	destPort: t.Optional(t.Number({ minimum: 0, maximum: 65535 })),
	autoStart: t.Optional(t.Boolean())
});

/** A non-dynamic forward is meaningless without somewhere to forward to. */
function requireDestination(type: string, destHost?: string, destPort?: number): void {
	if (type === 'dynamic') return;
	if (!destHost || !destPort) {
		throw new Error('Local and remote forwards need a destination host and port');
	}
}

export const sshForwardsHandler = createRouter()
	.http('ssh:forward-list', {
		data: t.Object({ connectionId: t.String({ minLength: 1 }) }),
		response: t.Any()
	}, async ({ data, conn }) => {
		requireSshConnection(conn, data.connectionId);
		return {
			forwards: sshPortForwardQueries.listForConnection(data.connectionId),
			statuses: sshForwardManager.statusesForConnection(data.connectionId)
		};
	})

	.http('ssh:forward-create', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			input: forwardInputSchema
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		requireSshConnection(conn, data.connectionId);
		const input = data.input as SshForwardInput;
		requireDestination(input.type, input.destHost, input.destPort);
		return sshPortForwardQueries.create(data.connectionId, input);
	})

	.http('ssh:forward-update', {
		data: t.Object({ id: t.String({ minLength: 1 }), patch: forwardPatchSchema }),
		response: t.Any()
	}, async ({ data, conn }) => {
		const existing = requireSshForward(conn, data.id);
		const patch = data.patch as Partial<SshForwardInput>;
		requireDestination(
			patch.type ?? existing.type,
			patch.destHost ?? existing.destHost ?? undefined,
			patch.destPort ?? existing.destPort ?? undefined
		);
		// Settings only take effect on a fresh listener, so restart-on-edit is the
		// honest behaviour: stop now, and let the user start it again.
		await sshForwardManager.stop(data.id);
		return sshPortForwardQueries.update(data.id, patch);
	})

	.http('ssh:forward-delete', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		requireSshForward(conn, data.id);
		await sshForwardManager.stop(data.id);
		sshPortForwardQueries.delete(data.id);
		return { ok: true };
	})

	.http('ssh:forward-start', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Any()
	}, async ({ data, conn }) => {
		const forward = requireSshForward(conn, data.id);
		return sshForwardManager.start(forward);
	})

	.http('ssh:forward-stop', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Any()
	}, async ({ data, conn }) => {
		const forward = requireSshForward(conn, data.id);
		await sshForwardManager.stop(data.id);
		return sshForwardManager.status(forward);
	});
