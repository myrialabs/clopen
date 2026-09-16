/**
 * Neon as a worktree-branching provider.
 *
 * The Neon API client and everything that knows how Neon answers live with the
 * DATABASE adapter, in `backend/db-client/providers/neon/` — one credential,
 * one client, one place a 403 is explained. This file is the thin part: the
 * shape the worktree manager asks for, expressed in calls that module already
 * makes. The alternative, a second Neon client under `worktrees/`, would give
 * one account two independent views of its own rate budget and two places to
 * fix the same error message.
 *
 * Two facts from the OpenAPI document decide the create call below:
 *
 *  - `endpoints: [{ type: 'read_write' }]` is MANDATORY. A branch created
 *    without it has no compute at all — it exists, it costs storage, and it
 *    refuses every connection.
 *  - `connection_uris` in the response is OPTIONAL. The document says a branch
 *    cut from a parent with more than one role or database comes back without
 *    one, so the fallback is a correctness requirement rather than an
 *    optimisation: it is the established projects, the ones this feature is
 *    most useful for, that take that path.
 *
 * `expires_at` is NOT sent even though it would be the perfect leak guard. It
 * is Early Access only, so sending it would fail for most accounts — orphan
 * detection is Clopen's own job instead.
 */

import type {
	BranchParent,
	BranchProviderInfo,
	CreatedBranch,
	RemoteBranch
} from '$shared/types/worktree-branching';
import type { IntegrationStatus } from '$shared/types/integrations';
import type { BranchProviderAdapter, BranchProviderContext } from '../types';
import {
	NEON_PROVIDER_ID,
	listNeonProjects,
	neonCredentialsOf
} from '$backend/db-client/providers/neon/adapter';
import {
	NeonError,
	neonRequest,
	type NeonCredentials
} from '$backend/db-client/providers/neon/client';
import {
	connectionFromCreateResponse,
	listBranches,
	resolveBranchConnection
} from '$backend/db-client/providers/neon/endpoints';
import type { NeonApiCreatedBranch } from '$backend/db-client/providers/neon/api-types';
import { debug } from '$shared/utils/logger';

/**
 * The db-client adapter's context and this one's are structurally identical —
 * an account id and its decoded credentials. Reusing its credential reader
 * keeps the "reconnect it in Settings" message written once.
 */
function credentialsOf(context: BranchProviderContext): NeonCredentials {
	return neonCredentialsOf({ accountId: context.accountId, credentials: context.credentials });
}

export const neonBranchAdapter: BranchProviderAdapter = {
	provider: NEON_PROVIDER_ID,

	info(): BranchProviderInfo {
		return {
			id: NEON_PROVIDER_ID,
			name: 'Neon',
			noun: 'branch',
			parentLabel: 'Neon project',
			description:
				'Every new worktree gets its own copy-on-write branch of this project, and its connection string.',
			// Names the consequence rather than asking "are you sure" — the rule
			// `Task 3` settled on for outward-facing actions. A branch is cheap but
			// it is not free, and the cap that stops it being created is a plan
			// limit the user can only discover here.
			notice:
				"Each worktree cuts a real Neon branch and deleting the worktree deletes it. Branches count against the project's branch limit.",
			supportsPooled: true
		};
	},

	async listParents(context: BranchProviderContext): Promise<BranchParent[]> {
		const projects = await listNeonProjects(credentialsOf(context));
		return projects.map((project) => ({
			ref: project.id,
			name: project.name || project.id,
			detail: project.region_id ?? null,
			group: project.org_name ?? null,
			// A Neon project has no state of its own and a suspended compute wakes
			// on connection, so every listed project can be branched from. Claiming
			// otherwise would disable rows that work.
			isReady: true
		}));
	},

	async createBranch(
		context: BranchProviderContext,
		input: { parentRef: string; name: string; pooled: boolean }
	): Promise<CreatedBranch> {
		const credentials = credentialsOf(context);

		const created = await neonRequest<NeonApiCreatedBranch>(
			credentials,
			`/projects/${encodeURIComponent(input.parentRef)}/branches`,
			{
				method: 'POST',
				body: {
					branch: {
						name: input.name,
						// `parent_id` is OMITTED, which means "the project's default
						// branch" — exactly what is wanted, and one fewer request than
						// looking the default up in order to name it.
						//
						// `init_source` is omitted too, so the default `parent-data`
						// applies: schema AND data. A schema-only branch would be cheaper
						// and would defeat the point, since migrating against an empty
						// database tells you nothing about whether the migration is safe
						// for the data that exists.
					},
					// Mandatory. Without a compute the branch cannot be connected to.
					endpoints: [{ type: 'read_write' }]
				}
			}
		);

		const branch = created?.branch;
		if (!branch?.id) {
			throw new NeonError(
				'Neon accepted the branch but did not report its id, so it cannot be tracked or cleaned up. Check the project in the Neon console.',
				502,
				'error'
			);
		}

		// Use what the create call already returned when it returned it, and fall
		// back when it did not. Both paths are real: see the file header.
		const inline = connectionFromCreateResponse(created?.connection_uris, input.pooled);
		const connection = inline
			?? await resolveBranchConnection(credentials, {
				projectId: input.parentRef,
				branchId: branch.id,
				pooled: input.pooled
			});

		debug.log(
			'worktree',
			`Cut Neon branch ${branch.name} (${branch.id}) from ${input.parentRef}${inline ? '' : ' — connection resolved separately'}`
		);

		return {
			ref: branch.id,
			// What Neon ACTUALLY called it, not what was asked for. Neon does not
			// rewrite branch names today, but recording the requested name as
			// though it were the real one is how an orphan sweep starts missing
			// branches the day a provider starts truncating.
			name: branch.name || input.name,
			connection
		};
	},

	async deleteBranch(
		context: BranchProviderContext,
		input: { parentRef: string; branchRef: string }
	): Promise<void> {
		try {
			await neonRequest(
				credentialsOf(context),
				`/projects/${encodeURIComponent(input.parentRef)}/branches/${encodeURIComponent(input.branchRef)}`,
				{ method: 'DELETE' }
			);
		} catch (error) {
			// A branch that is already gone is a SUCCESS. The caller is deleting a
			// worktree, and turning "it was deleted already" into a failure would
			// file a perfectly clean deletion in the orphan list forever.
			if (error instanceof NeonError && error.status === 404) {
				debug.log('worktree', `Neon branch ${input.branchRef} was already gone`);
				return;
			}
			throw error;
		}
	},

	async listBranches(context: BranchProviderContext, parentRef: string): Promise<RemoteBranch[]> {
		const branches = await listBranches(credentialsOf(context), parentRef);
		return branches.map((branch) => ({
			ref: branch.id,
			name: branch.name,
			createdAt: branch.created_at ?? null,
			// A protected branch counts as default here too: neither can be deleted,
			// and offering a button that the provider will refuse is worse than not
			// offering one.
			isDefault: branch.default === true || branch.protected === true,
			sizeBytes: typeof branch.logical_size === 'number' ? branch.logical_size : null
		}));
	},

	async probe(context: BranchProviderContext): Promise<{ status: IntegrationStatus; detail: string | null }> {
		try {
			const projects = await listNeonProjects(credentialsOf(context));
			if (projects.length === 0) {
				return {
					status: 'needs_config',
					detail: 'The key works but reaches no projects to branch from — check which Neon account it belongs to.'
				};
			}
			const plural = projects.length === 1 ? 'project' : 'projects';
			return { status: 'ok', detail: `${projects.length} ${plural} can be branched` };
		} catch (error) {
			if (error instanceof NeonError) {
				const status: IntegrationStatus = error.kind === 'auth'
					? 'needs_auth'
					: error.kind === 'config' || error.kind === 'quota' ? 'needs_config' : 'error';
				return { status, detail: error.message };
			}
			return { status: 'error', detail: error instanceof Error ? error.message : String(error) };
		}
	}
};
