/**
 * Git identity handlers — CRUD for Settings, binding for a project, and the
 * "who will this be committed as" read the Git panel shows.
 *
 * Every response is a DTO from `backend/git/identity/service`, so no private
 * key, passphrase or token can reach a client from here. The public key is the
 * one piece of key material that crosses, and it is public by definition.
 *
 * Identities are owned per user, and every handler resolves the owner from the
 * connection rather than from the payload. A client cannot name whose
 * identities it wants to read or change.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { gitIdentityService, describeIdentity } from '$backend/git/identity';
import { requireProjectWorkspace } from '../access';
import { ws } from '$backend/utils/ws';
import { gitService } from '$backend/git/git-service';
import { debug } from '$shared/utils/logger';
import type { GitIdentityAuthMethod } from '$shared/types/git-identity';

const AUTH_METHOD = t.Union([
	t.Literal('none'),
	t.Literal('ssh-key'),
	t.Literal('https-token'),
	t.Literal('https-account')
]);

/** The DTO shape, mirrored for the wire schema. */
const IDENTITY = t.Object({
	id: t.String(),
	label: t.String(),
	name: t.String(),
	email: t.String(),
	authMethod: AUTH_METHOD,
	hosts: t.Array(t.String()),
	sshPublicKey: t.Union([t.String(), t.Null()]),
	hasSshKey: t.Boolean(),
	hasSshPassphrase: t.Boolean(),
	hasHttpsToken: t.Boolean(),
	httpsUsername: t.Union([t.String(), t.Null()]),
	integrationAccountId: t.Union([t.String(), t.Null()]),
	isDefault: t.Boolean(),
	source: t.Union([t.Literal('manual'), t.Literal('local-machine')]),
	canDelete: t.Boolean(),
	createdAt: t.String(),
	updatedAt: t.String()
});

/**
 * Write fields.
 *
 * Secrets are `Optional` AND nullable on purpose, and the distinction is
 * load-bearing: absent means "keep what is stored", explicit `null` means
 * "clear it". Anything else would force the browser to hold a private key just
 * to rename an identity.
 */
const INPUT = t.Object({
	label: t.String({ minLength: 1 }),
	name: t.String({ minLength: 1 }),
	email: t.String({ minLength: 1 }),
	authMethod: AUTH_METHOD,
	hosts: t.Array(t.String()),
	sshPrivateKey: t.Optional(t.Union([t.String(), t.Null()])),
	sshPublicKey: t.Optional(t.Union([t.String(), t.Null()])),
	sshPassphrase: t.Optional(t.Union([t.String(), t.Null()])),
	httpsUsername: t.Optional(t.Union([t.String(), t.Null()])),
	httpsToken: t.Optional(t.Union([t.String(), t.Null()])),
	integrationAccountId: t.Optional(t.Union([t.String(), t.Null()])),
	isDefault: t.Optional(t.Boolean())
});

/** The owner of this connection. Throws when unauthenticated. */
function requireUserId(conn: Parameters<typeof ws.getUserId>[0]): string {
	const userId = ws.getUserId(conn);
	if (!userId) throw new Error('Authentication required');
	return userId;
}

export const gitIdentityHandler = createRouter()
	.http('git:identities', {
		data: t.Object({}),
		response: t.Object({ identities: t.Array(IDENTITY) })
	}, async ({ conn }) => {
		return { identities: await gitIdentityService.list(requireUserId(conn)) };
	})

	.http('git:identity-create', {
		data: INPUT,
		response: t.Object({ identity: IDENTITY })
	}, async ({ data, conn }) => {
		const identity = await gitIdentityService.create(requireUserId(conn), {
			...data,
			authMethod: data.authMethod as GitIdentityAuthMethod
		});
		return { identity };
	})

	.http('git:identity-update', {
		data: t.Intersect([INPUT, t.Object({ id: t.String() })]),
		response: t.Object({ identity: IDENTITY })
	}, async ({ data, conn }) => {
		const { id, ...input } = data;
		const identity = await gitIdentityService.update(requireUserId(conn), id, {
			...input,
			authMethod: input.authMethod as GitIdentityAuthMethod
		});
		return { identity };
	})

	.http('git:identity-delete', {
		data: t.Object({ id: t.String() }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		await gitIdentityService.remove(requireUserId(conn), data.id);
		return { ok: true };
	})

	.http('git:identity-set-default', {
		data: t.Object({ id: t.String() }),
		response: t.Object({ identity: IDENTITY })
	}, async ({ data, conn }) => {
		return { identity: await gitIdentityService.setDefault(requireUserId(conn), data.id) };
	})

	/**
	 * Generate a keypair for an identity.
	 *
	 * Returns the public half and its fingerprint. The private key never leaves
	 * the server — it goes straight into the sealed column and the 0600 file.
	 */
	.http('git:identity-generate-key', {
		data: t.Object({ id: t.String() }),
		response: t.Object({ publicKey: t.String(), fingerprint: t.String() })
	}, async ({ data, conn }) => {
		return await gitIdentityService.generateKey(requireUserId(conn), data.id);
	})

	/** How many projects would lose their binding if this identity went away. */
	.http('git:identity-usage', {
		data: t.Object({ id: t.String() }),
		response: t.Object({ projectCount: t.Number() })
	}, async ({ data, conn }) => {
		requireUserId(conn);
		return { projectCount: gitIdentityService.bindingCount(data.id) };
	})

	/** Bind this project to an identity, or clear the binding with `null`. */
	.http('git:identity-bind', {
		data: t.Object({
			projectId: t.String(),
			identityId: t.Union([t.String(), t.Null()])
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		// Access is the project's call, exactly as for every other git operation.
		requireProjectWorkspace(conn, data.projectId);
		await gitIdentityService.bind(requireUserId(conn), data.projectId, data.identityId);
		return { ok: true };
	})

	/**
	 * Who the next commit in this project will be attributed to.
	 *
	 * Drives the line above the commit box. `source` distinguishes an identity
	 * chosen for this project from one inherited as the user's default, which is
	 * the difference between "this is right" and "check this before you push".
	 */
	.http('git:identity-resolved', {
		data: t.Object({
			projectId: t.String(),
			/** Remote to resolve the credential against. Defaults to origin. */
			remote: t.Optional(t.String())
		}),
		response: t.Object({
			identity: t.Union([IDENTITY, t.Null()]),
			source: t.Union([t.Literal('project'), t.Literal('user-default'), t.Literal('none')]),
			credentialIdentity: t.Union([IDENTITY, t.Null()])
		})
	}, async ({ data, conn }) => {
		const { root } = requireProjectWorkspace(conn, data.projectId);
		const userId = requireUserId(conn);

		// The remote URL decides which identity's credential answers, so it is
		// resolved here too — a fork whose origin and upstream sit on different
		// accounts is exactly what the panel needs to be able to show.
		let remoteUrl: string | null = null;
		try {
			const remotes = await gitService.getRemotes(root);
			const wanted = data.remote ?? 'origin';
			const match = remotes.find((r) => r.name === wanted) ?? (remotes.length === 1 ? remotes[0] : undefined);
			remoteUrl = match ? match.pushUrl || match.fetchUrl : null;
		} catch (error) {
			// A project that is not a repo yet still has an identity to report.
			debug.log('git', 'No remotes to resolve an identity credential against:', error);
		}

		return describeIdentity(data.projectId, userId, remoteUrl);
	});
