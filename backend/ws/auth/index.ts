import { createRouter } from '$shared/utils/ws-server';
import { t } from 'elysia';
import { statusHandler } from './status';
import { loginHandler } from './login';
import { inviteHandler } from './invites';
import { usersHandler } from './users';

export const authRouter = createRouter()
	.merge(statusHandler)
	.merge(loginHandler)
	.merge(inviteHandler)
	.merge(usersHandler)
	// Declare auth:error event (emitted by auth gate in WSRouter)
	.emit('auth:error', t.Object({
		error: t.String(),
		blockedAction: t.String()
	}))
	// Declare auth:force-logout event (emitted when auth mode switches to required)
	.emit('auth:force-logout', t.Object({
		reason: t.String()
	}))
	// Declare auth:user-projects-changed event (broadcast on every assignment
	// change so the target user's navigator and any admin viewing the
	// per-user projects modal can both refresh in realtime).
	.emit('auth:user-projects-changed', t.Object({
		type: t.Union([t.Literal('assigned'), t.Literal('unassigned')]),
		userId: t.String(),
		projectId: t.String()
	}))
	// Declare auth:users-changed event (broadcast when a user is created or
	// removed, so any admin viewing the user list refreshes in realtime).
	.emit('auth:users-changed', t.Object({
		type: t.Union([t.Literal('added'), t.Literal('removed')]),
		userId: t.String()
	}));
