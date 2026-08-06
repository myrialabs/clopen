import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { createInvite, listInvites, revokeInvite } from '$backend/auth/auth-service';
import { ws } from '$backend/utils/ws';

export const inviteHandler = createRouter()
	// Create invite token (admin only — enforced by auth gate)
	.http('auth:create-invite', {
		data: t.Object({
			label: t.Optional(t.String()),
			maxUses: t.Optional(t.Number({ minimum: 0 })),
			expiresInMinutes: t.Optional(t.Number({ minimum: 1 })),
			projectIds: t.Optional(t.Array(t.String()))
		}),
		response: t.Object({
			inviteToken: t.String(),
			invite: t.Object({
				id: t.String(),
				role: t.String(),
				label: t.Union([t.String(), t.Null()]),
				max_uses: t.Number(),
				use_count: t.Number(),
				expires_at: t.Union([t.String(), t.Null()]),
				created_at: t.String(),
				project_ids: t.Union([t.String(), t.Null()])
			})
		})
	}, async ({ data, conn }) => {
		const userId = ws.getUserId(conn);
		const result = createInvite(userId, {
			label: data.label,
			maxUses: data.maxUses,
			expiresInMinutes: data.expiresInMinutes,
			projectIds: data.projectIds
		});

		// Broadcast so every admin's invite list (Team) stays in sync.
		ws.emit.global('remote-access:changed', { kind: 'invite-created' });

		return {
			inviteToken: result.inviteToken,
			invite: {
				id: result.invite!.id,
				role: result.invite!.role,
				label: result.invite!.label,
				max_uses: result.invite!.max_uses,
				use_count: result.invite!.use_count,
				expires_at: result.invite!.expires_at,
				created_at: result.invite!.created_at,
				project_ids: result.invite!.project_ids
			}
		};
	})

	// List all invites (admin only)
	.http('auth:list-invites', {
		data: t.Object({}),
		response: t.Array(t.Object({
			id: t.String(),
			role: t.String(),
			label: t.Union([t.String(), t.Null()]),
			max_uses: t.Number(),
			use_count: t.Number(),
			expires_at: t.Union([t.String(), t.Null()]),
			created_at: t.String(),
			project_ids: t.Union([t.String(), t.Null()])
		}))
	}, async () => {
		const invites = listInvites();
		return invites.map(inv => ({
			id: inv.id,
			role: inv.role,
			label: inv.label,
			max_uses: inv.max_uses,
			use_count: inv.use_count,
			expires_at: inv.expires_at,
			created_at: inv.created_at,
			project_ids: inv.project_ids
		}));
	})

	// Revoke invite (admin only)
	.http('auth:revoke-invite', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Object({
			success: t.Boolean()
		})
	}, async ({ data }) => {
		revokeInvite(data.id);
		ws.emit.global('remote-access:changed', { kind: 'invite-revoked' });
		return { success: true };
	});
