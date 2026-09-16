<script lang="ts">
	/**
	 * Database branching for this project: what it is pointed at, and what it
	 * leaked.
	 *
	 * Two peer tabs rather than one scroll, and the second one is the reason this
	 * dialog exists at all. `Task 4` learned that anything a user manages needs a
	 * place that exists BEFORE it is needed — creating an organisation lived
	 * inside an empty state, so it was reachable only once things had gone wrong
	 * and invisible the moment they had not. An orphaned database is exactly that
	 * shape of problem, so Leaks is a tab that is always there and says "none"
	 * when there are none.
	 */
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import InlineError from '$frontend/components/common/display/InlineError.svelte';
	import ProviderMark from '$frontend/components/common/display/ProviderMark.svelte';
	import RefreshButton from '$frontend/components/common/display/RefreshButton.svelte';
	import ConfirmDestructive from '$frontend/components/common/overlay/ConfirmDestructive.svelte';
	import ConnectAccountModal from '$frontend/components/settings/integrations/ConnectAccountModal.svelte';
	import { integrationsStore } from '$frontend/stores/features/integrations.svelte';
	import { showConfirm } from '$frontend/stores/ui/dialog.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import {
		branchingStore,
		clearBinding,
		deleteOrphan,
		deleteUntracked,
		ensureBranchingState,
		ensureParents,
		forgetOrphan,
		loadBranchingState,
		loadOrphans,
		loadParents,
		saveBinding,
		sourceKey
	} from '$frontend/stores/features/worktree-branching.svelte';
	import { DEFAULT_WORKTREE_BRANCH_CONFIG } from '$shared/types/worktree-branching';
	import type { BranchDataMode, BranchSourceKind } from '$shared/types/worktree-branching';
	import type { IntegrationProviderInfo } from '$shared/types/integrations';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(false), onClose }: Props = $props();

	type Tab = 'setup' | 'leaks';
	let tab = $state<Tab>('setup');

	/** `<kind>:<id>` — one value, because the picker offers one list. */
	let sourceValue = $state('');
	let parentRef = $state('');
	let envVar = $state(DEFAULT_WORKTREE_BRANCH_CONFIG.envVar);
	let envFile = $state('');
	let autoCreate = $state(true);
	let pooled = $state(false);
	let dataMode = $state<BranchDataMode>(DEFAULT_WORKTREE_BRANCH_CONFIG.dataMode);
	let showAdvanced = $state(false);
	let saveError = $state<string | null>(null);
	let connectProvider = $state<IntegrationProviderInfo | null>(null);

	const view = $derived(branchingStore.state);
	const sources = $derived(view?.sources ?? []);
	const binding = $derived(view?.binding ?? null);
	const source = $derived(sources.find((entry) => `${entry.kind}:${entry.id}` === sourceValue) ?? null);
	const sourceRef = $derived(
		source ? { sourceKind: source.kind, sourceId: source.id } : null
	);
	const parents = $derived(
		sourceRef && branchingStore.parentsSourceKey === sourceKey(sourceRef)
			? branchingStore.parents
			: []
	);
	const chosenParent = $derived(parents.find((entry) => entry.ref === parentRef) ?? null);
	const noun = $derived(source?.noun ?? 'database');
	const canSave = $derived(
		sourceValue !== '' && parentRef !== '' && envVar.trim() !== '' && envFile.trim() !== ''
	);

	/**
	 * The provider record behind a NATIVE source, when there is one.
	 *
	 * Only accounts have one, and only it knows about pooled endpoints — a copy
	 * Clopen makes on a local Postgres has no pooler to choose.
	 */
	const pooledProvider = $derived(
		source?.isNative
			? (view?.providers.find((entry) => entry.id === source.provider) ?? null)
			: null
	);

	/** Native providers first: they are cheaper and carry the parent whole. */
	const groupedSources = $derived([
		{ label: 'Branches the provider cuts', entries: sources.filter((entry) => entry.isNative) },
		{ label: 'Copies Clopen makes', entries: sources.filter((entry) => !entry.isNative) }
	].filter((group) => group.entries.length > 0));

	const DATA_MODES: { id: BranchDataMode; label: string; help: string }[] = [
		{
			id: 'schema-data',
			label: 'Schema and data',
			help: 'The worktree starts as a copy, so the app runs and the fixtures are there.'
		},
		{
			id: 'schema',
			label: 'Schema only',
			help: 'Structure without rows. Nothing sensitive is copied, and nothing is seeded.'
		},
		{
			id: 'empty',
			label: 'Empty',
			help: 'A database with nothing in it, for an agent that runs the migrations itself.'
		}
	];

	/**
	 * Dotenv files, existing ones first and the two standard names always
	 * offered.
	 *
	 * `.env` and `.env.local` are appended even when neither exists because a
	 * project that has not needed one yet still has a right answer, and a picker
	 * with no options is a dead end the user cannot get out of from here.
	 */
	const envFileOptions = $derived.by(() => {
		const found = view?.envFiles ?? [];
		const options = [...found];
		for (const fallback of ['.env.local', '.env']) {
			if (!options.includes(fallback)) options.push(fallback);
		}
		return options;
	});

	const orphans = $derived(branchingStore.orphans);
	const leakCount = $derived(
		(orphans?.tracked.length ?? 0) + (orphans?.untracked.length ?? 0)
	);

	/**
	 * Seed the form from the stored binding.
	 *
	 * Reads `binding` and nothing it also writes. `Task 4`'s `effect_update_depth_exceeded`
	 * came from effects that read the same cell their fetch was about to set, so
	 * the loads here go through `ensure*`, whose guard lives outside the reactive
	 * graph entirely.
	 */
	$effect(() => {
		if (!isOpen) return;
		ensureBranchingState();
	});

	$effect(() => {
		if (!isOpen || !binding) return;
		sourceValue = `${binding.sourceKind}:${binding.sourceId}`;
		parentRef = binding.parentRef;
		envVar = binding.config.envVar;
		envFile = binding.config.envFile;
		autoCreate = binding.config.autoCreate;
		pooled = binding.config.pooled;
		dataMode = binding.config.dataMode;
	});

	$effect(() => {
		if (!isOpen) return;
		ensureParents(sourceRef);
	});

	$effect(() => {
		if (!isOpen || tab !== 'leaks') return;
		void loadOrphans();
	});

	function handleOpened() {
		tab = 'setup';
		saveError = null;
		// A project with no binding has nothing to seed from, so the defaults have
		// to come from somewhere — and the most-precedent existing dotenv file is
		// the one answer that is right more often than any fixed name.
		if (!binding) {
			envVar = DEFAULT_WORKTREE_BRANCH_CONFIG.envVar;
			envFile = view?.envFiles[0] ?? DEFAULT_WORKTREE_BRANCH_CONFIG.envFile;
			autoCreate = true;
			pooled = false;
			dataMode = DEFAULT_WORKTREE_BRANCH_CONFIG.dataMode;
			sourceValue = sources[0] ? `${sources[0].kind}:${sources[0].id}` : '';
			parentRef = '';
		}
	}

	function close() {
		if (branchingStore.isSaving) return;
		isOpen = false;
		onClose();
	}

	async function openConnect() {
		await integrationsStore.load();
		// Every provider that declares the capability, whether or not an adapter
		// for it is loaded — the hub is the one place that knows what exists.
		connectProvider =
			integrationsStore.providers.find((entry) =>
				entry.capabilities.includes('worktree-branching')
			) ?? null;
	}

	async function submit() {
		if (!canSave) return;
		saveError = null;
		try {
			if (!sourceRef) return;
			await saveBinding({
				...sourceRef,
				parentRef,
				parentName: chosenParent?.name ?? parentRef,
				config: {
					envVar: envVar.trim(),
					envFile: envFile.trim(),
					autoCreate,
					pooled,
					dataMode
				}
			});
			addNotification({
				type: 'success',
				title: 'Worktree databases set up',
				message: `New worktrees can get their own ${noun} of ${chosenParent?.name ?? parentRef}.`,
				duration: 4000
			});
		} catch (error) {
			saveError = error instanceof Error ? error.message : String(error);
		}
	}

	async function stopBranching() {
		const confirmed = await showConfirm({
			title: 'Stop branching this project?',
			// Says what SURVIVES, because that is the part someone is about to
			// guess wrong: the worktrees still open are still using their branches.
			message: `New worktrees stop getting a ${noun}. The ones that already have one keep it, and it is still deleted when its worktree is.`,
			type: 'warning',
			confirmText: 'Stop branching'
		});
		if (!confirmed) return;

		try {
			await clearBinding();
		} catch (error) {
			saveError = error instanceof Error ? error.message : String(error);
		}
	}

	/**
	 * What the confirm dialog is currently guarding.
	 *
	 * One dialog for both kinds of leak rather than two: they ask the same
	 * question and the only difference is which call answers it.
	 */
	type DeleteTarget =
		| { kind: 'tracked'; id: string; name: string; noun: string; providerName: string }
		| {
			kind: 'untracked';
			sourceKind: BranchSourceKind;
			sourceId: string;
			parentRef: string;
			branchRef: string;
			name: string;
		};

	let deleteTarget = $state<DeleteTarget | null>(null);
	let deleting = $state(false);

	async function confirmDelete() {
		const target = deleteTarget;
		if (!target || deleting) return;

		deleting = true;
		try {
			if (target.kind === 'tracked') await deleteOrphan(target.id);
			else {
				await deleteUntracked({
					sourceKind: target.sourceKind,
					sourceId: target.sourceId,
					parentRef: target.parentRef,
					branchRef: target.branchRef
				});
			}
			deleteTarget = null;
		} catch (error) {
			addNotification({
				type: 'error',
				title: 'Delete failed',
				message: error instanceof Error ? error.message : String(error),
				duration: 5000
			});
		} finally {
			deleting = false;
		}
	}

	const fieldClass =
		'w-full h-9 px-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 outline-none focus:border-violet-500/50 disabled:opacity-60';
	const labelClass =
		'text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider';
</script>

<Modal bind:isOpen onClose={close} onOpened={handleOpened} title="Database branching" size="lg">
	<div class="space-y-4">
		<!-- Two peer tabs: leaks are not an error state, they are a place. -->
		<div class="flex items-center gap-1 border-b border-slate-200 dark:border-slate-700">
			{#each [{ id: 'setup' as Tab, label: 'Setup' }, { id: 'leaks' as Tab, label: 'Leaks' }] as entry (entry.id)}
				<button
					type="button"
					class="relative px-3 py-2 text-sm font-medium transition-colors
						{tab === entry.id
							? 'text-violet-600 dark:text-violet-400'
							: 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}"
					onclick={() => (tab = entry.id)}
				>
					{entry.label}
					{#if entry.id === 'leaks' && leakCount > 0}
						<span class="ml-1.5 px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 text-[11px] font-semibold">
							{leakCount}
						</span>
					{/if}
					{#if tab === entry.id}
						<span class="absolute inset-x-0 -bottom-px h-0.5 bg-violet-500"></span>
					{/if}
				</button>
			{/each}
		</div>

		{#if tab === 'setup'}
			{#if branchingStore.isLoading && !view}
				<!-- A form that has to fetch before it can be drawn needs a skeleton
				     shaped like the form that is coming — empty space reads as a
				     glitch rather than as work. -->
				<div class="space-y-4 animate-pulse">
					{#each [0, 1, 2] as row (row)}
						<div class="space-y-1.5">
							<div class="h-3 w-24 rounded bg-slate-200 dark:bg-slate-700"></div>
							<div class="h-9 rounded-lg bg-slate-100 dark:bg-slate-800"></div>
						</div>
					{/each}
				</div>
			{:else if sources.length === 0}
				<div class="py-6 text-center space-y-3">
					<Icon name="lucide:database" class="w-8 h-8 mx-auto text-slate-400" />
					<p class="text-sm text-slate-600 dark:text-slate-400 max-w-md mx-auto leading-relaxed">
						Add a database in DB Client, or connect a provider that branches natively,
						and every new worktree can get its own copy to migrate against.
					</p>
					<Button variant="primary" onclick={openConnect}>Connect an account</Button>
				</div>
			{:else}
				<div class="space-y-4">
					<!--
						ONE list, accounts and connections together, because the user is
						choosing which DATABASE. Which mechanism copies it is grouped and
						labelled rather than made into a decision of its own.
					-->
					<div class="space-y-1.5">
						<span class={labelClass}>Database lives in</span>
						<div class="flex items-center gap-2">
							<select
								class="{fieldClass} flex-1"
								value={sourceValue}
								onchange={(event) => {
									sourceValue = event.currentTarget.value;
									parentRef = '';
								}}
							>
								{#each groupedSources as group (group.label)}
									<optgroup label={group.label}>
										{#each group.entries as entry (entry.kind + entry.id)}
											<option value={`${entry.kind}:${entry.id}`}>
												{entry.label} · {entry.providerName}
											</option>
										{/each}
									</optgroup>
								{/each}
							</select>
							<button
								type="button"
								class="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
								onclick={openConnect}
							>
								Add another
							</button>
						</div>
						{#if source && !source.isNative}
							<p class="text-xs text-slate-500 dark:text-slate-500 leading-relaxed">
								Clopen copies this one itself, on the same server.{source.notice ? ` ${source.notice}` : ''}
							</p>
						{/if}
					</div>

					<!--
						What the copy STARTS WITH. A default rather than a question in the
						common case, and the help under each option is what the user is
						actually weighing: a seeded dev database is worth copying whole and
						a forty-gigabyte one is not.
					-->
					<div class="space-y-1.5">
						<span class={labelClass}>Each worktree starts with</span>
						<select class={fieldClass} bind:value={dataMode}>
							{#each DATA_MODES as entry (entry.id)}
								<option value={entry.id}>{entry.label}</option>
							{/each}
						</select>
						<p class="text-xs text-slate-500 dark:text-slate-500 leading-relaxed">
							{DATA_MODES.find((entry) => entry.id === dataMode)?.help}
						</p>
					</div>

					<div class="space-y-1.5">
						<div class="flex items-center justify-between">
							<span class={labelClass}>Database</span>
							<RefreshButton
								isLoading={branchingStore.isLoadingParents}
								onRefresh={() => {
									if (sourceRef) void loadParents(sourceRef);
								}}
							/>
						</div>
						{#if branchingStore.isLoadingParents && parents.length === 0}
							<div class="h-9 rounded-lg bg-slate-100 dark:bg-slate-800 animate-pulse"></div>
						{:else if branchingStore.parentsError}
							<InlineError message={branchingStore.parentsError} />
						{:else}
							<select class={fieldClass} bind:value={parentRef}>
								<option value="">Choose one…</option>
								{#each parents as entry (entry.ref)}
									<option value={entry.ref} disabled={!entry.isReady}>
										{entry.name}{entry.group ? ` · ${entry.group}` : ''}{entry.detail ? ` · ${entry.detail}` : ''}
									</option>
								{/each}
							</select>
						{/if}
					</div>

					<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
						<div class="space-y-1.5">
							<span class={labelClass}>Variable</span>
							<input class={fieldClass} bind:value={envVar} spellcheck="false" />
						</div>
						<div class="space-y-1.5">
							<span class={labelClass}>Written to</span>
							<select class={fieldClass} bind:value={envFile}>
								{#each envFileOptions as file (file)}
									<option value={file}>
										{file}{(view?.envFiles ?? []).includes(file) ? '' : ' (will be created)'}
									</option>
								{/each}
							</select>
						</div>
					</div>

					<!--
						Asked rather than guessed, and the help says why. Next.js and Vite
						read `.env.local` in preference to `.env`, so on a project with
						both there is one right answer — and picking the other produces
						the worst outcome available: the branch is created, the variable
						is written, and nothing reads it.
					-->
					<p class="text-xs text-slate-500 dark:text-slate-500 leading-relaxed">
						Next.js and Vite read <code class="font-mono">.env.local</code> in preference to
						<code class="font-mono">.env</code>, so pick the one this project actually loads.
						The value goes in a marked block; everything else in the file is left alone.
					</p>

					<label class="flex items-start gap-2.5 cursor-pointer">
						<input type="checkbox" bind:checked={autoCreate} class="mt-0.5 accent-violet-600" />
						<span class="text-sm text-slate-700 dark:text-slate-300">
							Create one for every new worktree
							<span class="block text-xs text-slate-500">
								Off means branching stays set up but nothing is created until you turn this back on.
							</span>
						</span>
					</label>

					{#if pooledProvider?.supportsPooled}
						<button
							type="button"
							class="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
							onclick={() => (showAdvanced = !showAdvanced)}
						>
							<Icon
								name={showAdvanced ? 'lucide:chevron-down' : 'lucide:chevron-right'}
								class="w-3.5 h-3.5"
							/>
							Advanced
						</button>
						{#if showAdvanced}
							<label class="flex items-start gap-2.5 cursor-pointer pl-5">
								<input type="checkbox" bind:checked={pooled} class="mt-0.5 accent-violet-600" />
								<span class="text-sm text-slate-700 dark:text-slate-300">
									Use the pooled endpoint
									<span class="block text-xs text-slate-500">
										Transaction mode, which breaks prepared statements — including the ones this client uses.
									</span>
								</span>
							</label>
						{/if}
					{/if}

					{#if pooledProvider}
						<p class="flex items-start gap-2 text-xs text-slate-500 dark:text-slate-500 leading-relaxed">
							<Icon name="lucide:info" class="w-3.5 h-3.5 mt-0.5 shrink-0" />
							<span>{pooledProvider.notice}</span>
						</p>
					{/if}

					{#if saveError}
						<InlineError message={saveError} onDismiss={() => (saveError = null)} />
					{/if}
				</div>
			{/if}
		{:else}
			<div class="space-y-3">
				<div class="flex items-start justify-between gap-3">
					<p class="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
						Databases that outlived the worktree they belonged to. They still exist at the
						provider, and nothing else will clean them up.
					</p>
					<RefreshButton isLoading={branchingStore.isLoadingOrphans} onRefresh={loadOrphans} />
				</div>

				{#if orphans?.sweepError}
					<!-- Stated rather than folded into an empty list: "none found" and
					     "we could not look" are different answers. -->
					<InlineError message={orphans.sweepError} />
				{/if}

				{#if branchingStore.isLoadingOrphans && !orphans}
					<div class="space-y-2 animate-pulse">
						{#each [0, 1] as row (row)}
							<div class="h-14 rounded-lg bg-slate-100 dark:bg-slate-800"></div>
						{/each}
					</div>
				{:else if leakCount === 0}
					<div class="py-8 text-center">
						<Icon name="lucide:check" class="w-7 h-7 mx-auto text-emerald-500" />
						<p class="mt-2 text-sm text-slate-600 dark:text-slate-400">
							Nothing left behind.
						</p>
					</div>
				{:else}
					{#each orphans?.tracked ?? [] as branch (branch.id)}
						<div class="flex items-start gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
							<ProviderMark provider={branch.provider} size="w-4 h-4" />
							<div class="flex-1 min-w-0">
								<p class="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
									{branch.branchName}
								</p>
								<p class="text-xs text-slate-500 truncate">
									{branch.providerName} · {branch.sourceLabel}
								</p>
								{#if branch.error}
									<p class="mt-1 text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
										{branch.error}
									</p>
								{/if}
							</div>
							<div class="flex items-center gap-1.5 shrink-0">
								<Button
									variant="ghost"
									size="sm"
									disabled={branchingStore.busyBranchId === branch.id}
									onclick={() => forgetOrphan(branch.id)}
								>
									Forget
								</Button>
								<Button
									variant="danger"
									size="sm"
									disabled={branchingStore.busyBranchId === branch.id}
									onclick={() =>
										(deleteTarget = {
											kind: 'tracked',
											id: branch.id,
											name: branch.branchName,
											noun: branch.noun,
											providerName: branch.providerName
										})}
								>
									Delete
								</Button>
							</div>
						</div>
					{/each}

					{#each orphans?.untracked ?? [] as entry (entry.branch.ref)}
						<div class="flex items-start gap-3 p-3 rounded-lg border border-amber-300/60 dark:border-amber-700/50 bg-amber-500/5">
							<ProviderMark provider={entry.provider} size="w-4 h-4" />
							<div class="flex-1 min-w-0">
								<p class="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
									{entry.branch.name}
								</p>
								<p class="text-xs text-slate-500 leading-relaxed">
									Found at the provider with no record here — most likely created just
									before Clopen stopped.
								</p>
							</div>
							<Button
								variant="danger"
								size="sm"
								disabled={branchingStore.busyBranchId === entry.branch.ref}
								onclick={() =>
									(deleteTarget = {
										kind: 'untracked',
										sourceKind: entry.sourceKind,
										sourceId: entry.sourceId,
										parentRef: entry.parentRef,
										branchRef: entry.branch.ref,
										name: entry.branch.name
									})}
							>
								Delete
							</Button>
						</div>
					{/each}
				{/if}
			</div>
		{/if}
	</div>

	{#snippet footer()}
		<div class="flex items-center justify-between gap-2">
			{#if tab === 'setup' && binding}
				<Button variant="ghost" onclick={stopBranching} disabled={branchingStore.isSaving}>
					Stop branching
				</Button>
			{:else}
				<span></span>
			{/if}

			<div class="flex items-center gap-2">
				<Button variant="ghost" onclick={close} disabled={branchingStore.isSaving}>Close</Button>
				{#if tab === 'setup' && sources.length > 0}
					<Button
						variant="primary"
						class="gap-2"
						onclick={submit}
						disabled={!canSave || branchingStore.isSaving}
					>
						{#if branchingStore.isSaving}
							<Icon name="lucide:loader-circle" class="w-4 h-4 animate-spin" />
							Saving…
						{:else}
							{binding ? 'Save' : 'Set up branching'}
						{/if}
					</Button>
				{/if}
			</div>
		</div>
	{/snippet}
</Modal>

<!--
	Names the database and says what it costs, rather than asking "are you sure".
	The name is the thing someone can check against what they meant.
-->
<ConfirmDestructive
	isOpen={deleteTarget !== null}
	title={deleteTarget ? `Delete "${deleteTarget.name}"?` : ''}
	message={deleteTarget
		? deleteTarget.kind === 'tracked'
			? `This permanently deletes the ${deleteTarget.noun} and everything in it, at ${deleteTarget.providerName}. It cannot be undone.`
			: 'This permanently deletes it and everything in it, at the provider. It cannot be undone.'
		: ''}
	confirmText={deleting ? 'Deleting…' : 'Delete'}
	onConfirm={confirmDelete}
	onClose={() => (deleteTarget = null)}
/>

<!-- The hub's own connect dialog, embedded. A user here never lands in Settings. -->
<ConnectAccountModal
	provider={connectProvider}
	onClose={() => (connectProvider = null)}
	onConnected={() => {
		connectProvider = null;
		void loadBranchingState();
	}}
/>
