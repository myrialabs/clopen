import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { needsSetup, getUserById, isOnboardingComplete, markOnboardingComplete } from '$backend/auth/auth-service';
import { getAuthMode } from '$backend/settings/system-settings';
import { ws } from '$backend/utils/ws';

export const statusHandler = createRouter()
	.http('auth:status', {
		data: t.Object({}),
		response: t.Object({
			needsSetup: t.Boolean(),
			onboardingComplete: t.Boolean(),
			authenticated: t.Boolean(),
			authMode: t.Union([t.Literal('none'), t.Literal('required')]),
			user: t.Optional(t.Object({
				id: t.String(),
				name: t.String(),
				role: t.Union([t.Literal('admin'), t.Literal('member')]),
				color: t.String(),
				avatar: t.String(),
				createdAt: t.String()
			}))
		})
	}, async ({ conn }) => {
		const setup = needsSetup();
		// Deliberately NOT wrapped in a try/catch: if onboarding state cannot be
		// read, this request must fail so the client keeps its current screen.
		// Reporting "not onboarded" on a read error is what used to drop working
		// installs into the setup wizard.
		const onboardingDone = isOnboardingComplete();
		const authMode = getAuthMode();
		const authenticated = ws.isAuthenticated(conn);

		let user = undefined;
		if (authenticated) {
			const state = ws.getConnectionState(conn);
			if (state?.userId) {
				const dbUser = getUserById(state.userId);
				if (dbUser) {
					user = dbUser;
				}
			}
		}

		return { needsSetup: setup, onboardingComplete: onboardingDone, authenticated, authMode, user };
	})

	// Mark the setup wizard as finished.
	//
	// The server owns this marker rather than letting the client write the raw
	// settings key: the wizard may only be dismissed once persistence is
	// confirmed, otherwise a failed write drops the user straight back into it on
	// the next refresh — silently, because the old client-side write was
	// fire-and-forget. The response echoes the stored state so the client can
	// verify instead of assume.
	.http('auth:complete-onboarding', {
		data: t.Object({}),
		response: t.Object({
			onboardingComplete: t.Boolean()
		})
	}, async () => {
		markOnboardingComplete();
		return { onboardingComplete: isOnboardingComplete() };
	});
