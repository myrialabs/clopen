<script lang="ts">
	/**
	 * Create a remote project for this one.
	 *
	 * A PANEL sharing one dialog with the deploy flow — see DeployPanel for why.
	 *
	 * Prefilled from the LOCAL project, because it already answers both
	 * questions a user would otherwise retype: a project called `calc-2` that
	 * pushes to `acme/calc-2` needs neither a name nor a repository typed out.
	 *
	 * Connecting the repository is offered rather than assumed, but it is the
	 * default: a target with no repository connected cannot be deployed from
	 * Clopen at all, so creating one unconnected would produce exactly the dead
	 * end this dialog exists to remove.
	 *
	 * The framework is left unset unless asked for. Vercel detects it from the
	 * repository, and a wrong guess here is a broken build with a confusing
	 * cause.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import { deploymentsStore } from '$frontend/stores/features/deployments.svelte';
	import InlineError from './InlineError.svelte';

	interface Props {
		/** True while this panel is the visible tab — it fetches on becoming so. */
		isActive: boolean;
		onClose: () => void;
	}

	const { isActive, onClose }: Props = $props();

	let name = $state('');
	let gitRepo = $state('');
	let gitProvider = $state<string | null>(null);
	let connectRepo = $state(true);
	let isLoading = $state(false);
	let isSaving = $state(false);
	let failure = $state<string | null>(null);
	/**
	 * Whether the account can actually reach that repository.
	 *
	 * Checked HERE too, not only in the deploy dialog. Offering "Connect
	 * acme/web" ticked by default, on an account that cannot see acme, produces
	 * a form that looks ready and a creation that fails — and the user has no
	 * way to tell which half went wrong.
	 */
	let access = $state<{ state: string; reason: string | null; actionUrl: string | null } | null>(null);

	$effect(() => {
		if (!isActive) return;
		isLoading = true;
		failure = null;
		access = null;

		void deploymentsStore
			.newProjectDefaults()
			.then(async (defaults) => {
				name = defaults.suggestedName;
				gitRepo = defaults.gitRepo ?? '';
				gitProvider = defaults.gitProvider;
				// Nothing to connect means nothing to offer connecting.
				connectRepo = defaults.gitRepo !== null;

				if (defaults.gitRepo) {
					access = await deploymentsStore.repoAccess(defaults.gitRepo).catch(() => null);
					// Only a verified block unticks it. `unknown` leaves the choice
					// alone, because refusing on a check we could not read would be
					// the same mistake in the other direction.
					if (access?.state === 'blocked') connectRepo = false;
				}
			})
			.catch(() => {
				// An empty form is still a working form.
			})
			.finally(() => {
				isLoading = false;
			});
	});

	const isBlocked = $derived(access?.state === 'blocked');

	async function submit() {
		if (!name.trim() || isSaving) return;
		isSaving = true;
		failure = null;
		try {
			await deploymentsStore.createProject({
				name: name.trim(),
				gitRepo: connectRepo && gitRepo.trim() ? gitRepo.trim() : null,
				gitProvider: connectRepo && gitRepo.trim() ? gitProvider || 'github' : null,
				framework: null
			});
			onClose();
		} catch (error) {
			// Kept in the dialog: the name may need changing, and the provider's
			// message often carries a link the user has to follow.
			failure = error instanceof Error ? error.message : String(error);
		} finally {
			isSaving = false;
		}
	}
</script>

	<div class="flex flex-col gap-4">
		<p class="text-sm text-slate-600 dark:text-slate-400 m-0">
			Creates it on the connected account and points this project at it straight away.
		</p>

		{#if isLoading}
			<div class="flex items-center justify-center py-6">
				<Icon name="lucide:loader-circle" class="w-5 h-5 text-slate-400 animate-spin" />
			</div>
		{:else}
			<label class="flex flex-col gap-1.5">
				<span class="text-xs font-medium text-slate-700 dark:text-slate-300">Name</span>
				<input
					type="text"
					class="w-full h-9 px-2.5 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
					placeholder="my-project"
					value={name}
					oninput={(event) => (name = event.currentTarget.value)}
				/>
				<span class="text-[11px] text-slate-500 dark:text-slate-500">
					Lowercase letters, numbers and hyphens.
				</span>
			</label>

			{#if gitRepo}
				<label class="flex items-start gap-2.5 cursor-pointer">
					<input
						type="checkbox"
						class="mt-0.5 w-3.5 h-3.5 accent-violet-600 cursor-pointer"
						checked={connectRepo}
						onchange={(event) => (connectRepo = event.currentTarget.checked)}
					/>
					<span class="flex flex-col gap-0.5">
						<span class="text-xs font-medium text-slate-700 dark:text-slate-300">
							Connect <span class="font-mono">{gitRepo}</span>
						</span>
						<span class="text-[11px] text-slate-500 dark:text-slate-500">
							Read from this project's git remote. Without a connected repository there is nothing
							to build from, and deploying has to be done with the provider's CLI.
						</span>
					</span>
				</label>
			{:else}
				<p class="flex items-start gap-2 px-3 py-2.5 m-0 bg-amber-500/10 rounded-lg text-xs text-amber-800 dark:text-amber-300">
					<Icon name="lucide:circle-alert" class="w-3.5 h-3.5 shrink-0 mt-px" />
					<span>
						This project has no git remote, so the new project will have nothing to build from.
						Push it to a host first if you want to deploy from here.
					</span>
				</p>
			{/if}
		{/if}

		{#if failure}
			<InlineError message={failure} onDismiss={() => (failure = null)} />
		{/if}

		<div class="flex justify-end gap-2 pt-1">
			<Button size="sm" variant="outline" onclick={onClose}>Cancel</Button>
			<Button size="sm" disabled={!name.trim() || isSaving || isLoading} onclick={submit}>
				{isSaving ? 'Creating…' : 'Create and link'}
			</Button>
		</div>
	</div>
