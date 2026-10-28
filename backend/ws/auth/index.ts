import { createRouter } from '$shared/utils/ws-server';
import { t } from 'elysia';
import { statusHandler } from './status';
import { loginHandler } from './login';
import { deviceHandler } from './device';

export const authRouter = createRouter()
	.merge(statusHandler)
	.merge(loginHandler)
	.merge(deviceHandler)
	// Declare auth:error event (emitted by auth gate in WSRouter)
	.emit('auth:error', t.Object({
		error: t.String(),
		blockedAction: t.String()
	}))
	// Declare auth:force-logout event (emitted when auth mode switches to required)
	.emit('auth:force-logout', t.Object({
		reason: t.String()
	}))
	// Declare auth:force-logout-user event (emitted to one device whose session ended)
	.emit('auth:force-logout-user', t.Object({
		reason: t.String()
	}))
	// Declare remote-access:changed event (emitted when Remote Access devices
	// change — device code created/claimed/revoked, session revoked, a device
	// came online — so the sidebar count and panel lists refresh in realtime).
	.emit('remote-access:changed', t.Object({
		kind: t.String()
	}));
