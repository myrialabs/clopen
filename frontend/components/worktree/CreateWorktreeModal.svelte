<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import InlineError from '$frontend/components/common/display/InlineError.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import {
		createWorktree,
		switchWorktreeContext,
		worktreeState
	} from '$frontend/stores/features/worktrees.svelte';
	import {
		branchingStore,
		ensureBranchingState,
		ensureSuggestion,
		saveBinding
	} from '$frontend/stores/features/worktree-branching.svelte';
	import {
		DEFAULT_WORKTREE_BRANCH_CONFIG,
		type BranchDataMode
	} from '$shared/types/worktree-branching';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
		/** Move the workspace into the new worktree once it exists. */
		switchOnCreate?: boolean;
	}

	let { isOpen = $bindable(false), onClose, switchOnCreate = true }: Props = $props();

	let name = $state('');
	/**
	 * Whether this worktree gets a database, asked every time.
	 *
	 * A checkbox rather than a project-level switch that quietly fires: creating
	 * one makes a REAL database, and the answer depends on what this particular
	 * worktree is for.
	 */
	let useDatabase = $state(false);
	let dataMode = $state<BranchDataMode>(DEFAULT_WORKTREE_BRANCH_CONFIG.dataMode);
	let inputElement = $state<HTMLInputElement>();
	/**
	 * A branch that was expected and did not happen.
	 *
	 * Shown HERE rather than as a toast, and shown beside a worktree that was
	 * created successfully. The rule `Task 3` settled on: anything the user has
	 * to act on belongs in the surface that caused it, and this one usually ends
	 * in "delete a branch you no longer need" — advice a toast removes before it
	 * can be read.
	 */
	let branchError = $state<string | null>(null);

	const projectName = $derived(projectState.currentProject?.name ?? '');
	const canSubmit = $derived(name.trim().length > 0 && !worktreeState.isCreating);

	const binding = $derived(branchingStore.state?.binding ?? null);
	/**
	 * The binding this project WOULD get, when it has none.
	 *
	 * This is what makes the feature reachable without a setup trip: the
	 * project's own `.env` already names a database, and Clopen already has a
	 * connection to it, so the offer can be made here and accepted in one tick.
	 */
	const suggestion = $derived(binding ? null : (branchingStore.suggestion ?? null));
	const offer = $derived.by(() => {
		if (binding) {
			return {
				sourceLabel: binding.sourceLabel,
				providerName: binding.providerName,
				parentName: binding.parentName,
				envVar: binding.config.envVar,
				envFile: binding.config.envFile,
				noun: binding.isNative ? 'branch' : 'copy',
				notice: null as string | null,
				isNew: false
			};
		}
		if (!suggestion) return null;
		return {
			sourceLabel: suggestion.sourceLabel,
			providerName: suggestion.providerName,
			parentName: suggestion.parentName,
			envVar: suggestion.envVar,
			envFile: suggestion.envFile,
			noun: 'copy',
			notice: suggestion.notice,
			isNew: true
		};
	});
	const noun = $derived(offer?.noun ?? 'copy');

	const DATA_MODES: { id: BranchDataMode; label: string }[] = [
		{ id: 'schema-data', label: 'Schema and data' },
		{ id: 'schema', label: 'Schema only' },
		{ id: 'empty', label: 'Empty' }
	];

	// Loaded through `ensure*`, whose guard is a plain Set outside the reactive
	// graph — an effect that decided by reading `isLoading` would subscribe to
	// the cell its own fetch sets and re-run forever.
	$effect(() => {
		if (!isOpen) return;
		ensureBranchingState();
		ensureSuggestion();
	});

	function handleOpened() {
		name = '';
		branchError = null;
		// Ticked when the project has already said yes once, and when Clopen can
		// see what to copy. Either way it is visible and one click from off.
		useDatabase = binding ? binding.config.autoCreate : branchingStore.suggestion != null;
		dataMode = binding?.config.dataMode ?? DEFAULT_WORKTREE_BRANCH_CONFIG.dataMode;
		inputElement?.focus();
	}

	function handleClose() {
		if (worktreeState.isCreating) return;
		isOpen = false;
		onClose();
	}

	async function submit() {
		if (!canSubmit) return;
		branchError = null;

		try {
			// Accepting the suggestion IS setting the project up, so the binding is
			// written first — after which this create and every later one behaves
			// exactly as if the user had visited the setup dialog.
			if (useDatabase && suggestion) {
				await saveBinding({
					sourceKind: suggestion.sourceKind,
					sourceId: suggestion.sourceId,
					parentRef: suggestion.parentRef,
					parentName: suggestion.parentName,
					config: {
						envVar: suggestion.envVar,
						envFile: suggestion.envFile,
						autoCreate: true,
						pooled: false,
						dataMode
					}
				});
			}

			const result = await createWorktree(name.trim(), {
				skipBranch: !useDatabase,
				dataMode
			});
			if (!result) {
				isOpen = false;
				onClose();
				return;
			}

			// A branch that could not be cut does NOT close the dialog: the message
			// is the whole point, and closing over it would make a real failure
			// look like a clean success.
			if (result.branchError) {
				branchError = result.branchError;
			} else {
				isOpen = false;
				onClose();
			}

			const suffix = result.branch ? ` It has its own database ${noun}.` : '';
			addNotification({
				type: 'success',
				title: 'Worktree created',
				message: `"${result.worktree.name}" is ready — an isolated copy of ${projectName}.${suffix}`,
				duration: 4000
			});

			if (result.branch?.envStatus === 'skipped-tracked' && result.branch.envDetail) {
				// A refusal, not a failure — so it is its own message rather than a
				// line appended to the success one.
				branchError = result.branch.envDetail;
			}

			if (switchOnCreate) await switchWorktreeContext(result.worktree.id);
		} catch (error) {
			addNotification({
				type: 'error',
				title: 'Could not create worktree',
				message: error instanceof Error ? error.message : String(error),
				duration: 5000
			});
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			void submit();
		}
	}
</script>

<Modal bind:isOpen onClose={handleClose} onOpened={handleOpened} title="New worktree" size="md">
	<div class="space-y-4">
		<p class="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
			A worktree is a private copy of <span class="font-medium text-slate-800 dark:text-slate-200">{projectName}</span>.
			Work done in it — by you or by the agent — never touches the main project until you apply it.
		</p>

		<div class="space-y-1.5">
			<label for="worktree-name" class="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider">
				Name
			</label>
			<input
				id="worktree-name"
				bind:this={inputElement}
				bind:value={name}
				onkeydown={handleKeydown}
				type="text"
				maxlength="80"
				placeholder="e.g. refactor auth"
				disabled={worktreeState.isCreating}
				class="w-full px-3 py-2 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 outline-none focus:border-violet-500/50 disabled:opacity-60"
			/>
		</div>

		<!--
			Stated before the button, not discovered afterwards: creating this
			worktree is about to create a real database at a third party, and the
			opt-out is for the one worktree in front of the user rather than a
			setting they have to go and change.
		-->
		{#if offer}
			<div class="flex items-start gap-2.5 p-3 rounded-lg bg-violet-500/5 border border-violet-500/20">
				<Icon name="lucide:database" class="w-4 h-4 mt-0.5 shrink-0 text-violet-600 dark:text-violet-400" />
				<div class="min-w-0 flex-1 space-y-2">
					<label class="flex items-start gap-2 cursor-pointer">
						<input
							type="checkbox"
							bind:checked={useDatabase}
							disabled={worktreeState.isCreating}
							class="mt-0.5 accent-violet-600"
						/>
						<span class="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
							Give it its own {noun} of
							<span class="font-medium text-slate-800 dark:text-slate-200">{offer.parentName}</span>
							on {offer.sourceLabel}, with
							<code class="font-mono text-xs">{offer.envVar}</code> in
							<code class="font-mono text-xs">{offer.envFile}</code> pointing at it.
						</span>
					</label>

					{#if useDatabase}
						<div class="pl-6 space-y-1.5">
							<select
								bind:value={dataMode}
								disabled={worktreeState.isCreating}
								class="h-8 px-2 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100"
							>
								{#each DATA_MODES as entry (entry.id)}
									<option value={entry.id}>{entry.label}</option>
								{/each}
							</select>
							{#if offer.notice}
								<p class="text-xs text-slate-500 dark:text-slate-500 leading-relaxed">
									{offer.notice}
								</p>
							{/if}
							{#if offer.isNew}
								<!-- Said plainly, because ticking this box does more than it
								     looks like: it is also the setup step. -->
								<p class="text-xs text-slate-500 dark:text-slate-500 leading-relaxed">
									This also sets it up for future worktrees — change or stop it in
									Database branching.
								</p>
							{/if}
						</div>
					{/if}
				</div>
			</div>
		{/if}

		{#if branchError}
			<InlineError message={branchError} onDismiss={() => (branchError = null)} />
		{/if}
	</div>

	{#snippet footer()}
		<div class="flex justify-end gap-2">
			<Button variant="ghost" onclick={handleClose} disabled={worktreeState.isCreating}>
				{branchError ? 'Close' : 'Cancel'}
			</Button>
			{#if !branchError}
				<Button variant="primary" class="gap-2" onclick={submit} disabled={!canSubmit}>
					{#if worktreeState.isCreating}
						<Icon name="lucide:loader-circle" class="w-4 h-4 animate-spin" />
						Creating…
					{:else}
						Create worktree
					{/if}
				</Button>
			{/if}
		</div>
	{/snippet}
</Modal>
