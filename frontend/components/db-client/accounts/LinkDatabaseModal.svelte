<script lang="ts">
	/**
	 * Manage an account's databases from inside DB Client.
	 *
	 * TWO TABS, because creating an organisation used to live inside the
	 * empty-state of the create-a-database form — reachable only when things had
	 * already gone wrong, and invisible once they had not. Anything a user is
	 * expected to manage needs a place that exists whether or not it is currently
	 * needed, so Organisations is a peer of Databases rather than a consolation
	 * prize.
	 *
	 * The account strip is shared by both tabs and owns the account itself:
	 * health, and an Edit that opens the SAME connect dialog Settings uses. A
	 * user who has to go to Settings to change a token is a user who was told the
	 * contextual entry point was a lie.
	 *
	 * Also serves editing one link: opened with `link`, it skips to that form
	 * with the mode and secrets it already has.
	 */
	import { untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import ProviderMark from '$frontend/components/common/display/ProviderMark.svelte';
	import InlineError from '$frontend/components/common/display/InlineError.svelte';
	import ConnectAccountModal from '$frontend/components/settings/integrations/ConnectAccountModal.svelte';
	import ConfirmDestructive from '$frontend/components/common/overlay/ConfirmDestructive.svelte';
	import { dbAccountsStore, type DbClientAccountInfo } from '$frontend/stores/features/db-client-accounts.svelte';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';
	import { integrationsStore } from '$frontend/stores/features/integrations.svelte';
	import type {
		DbAccountLinkInfo,
		DbProviderCreateOptions,
		DbProviderInfo,
		DbRemoteDatabase
	} from '$shared/types/db-client';
	import type { IntegrationProviderInfo } from '$shared/types/integrations';

	interface Props {
		isOpen: boolean;
		/** Present when editing an existing link rather than creating one. */
		link?: DbAccountLinkInfo | null;
		onClose: () => void;
		onDone?: () => void;
	}

	let { isOpen = $bindable(), link = null, onClose, onDone }: Props = $props();

	let accountId = $state('');
	let remoteRef = $state('');
	let label = $state('');
	let mode = $state('');
	let secrets = $state<Record<string, string>>({});
	let saving = $state(false);
	let error = $state<string | null>(null);
	let connectProvider = $state<IntegrationProviderInfo | null>(null);
	let showAdvanced = $state(false);
	/**
	 * The header is showing the connect-a-provider list rather than the accounts.
	 *
	 * A toggle because the two are alternatives, not neighbours. Rendering both
	 * at once put a dashed "Connect Supabase…" directly under a selected Neon
	 * account, where it read as part of that selection — and it took the same
	 * room whether or not the user had any intention of adding a second vendor.
	 */
	let showConnect = $state(false);

	/**
	 * Creating a database rather than picking one.
	 *
	 * The same dialog, not a second modal: two buttons that both say "add a
	 * database" make the user choose before they know what either does, which is
	 * the lesson the deploy dialogs landed on.
	 */
	let creating = $state(false);
	let createOptions = $state<DbProviderCreateOptions | null>(null);
	let createName = $state('');
	let createGroup = $state('');
	let createRegion = $state('');
	let createBusy = $state(false);
	let provisioning = $state(false);
	let newGroupName = $state('');
	let creatingGroup = $state(false);
	/**
	 * The Organisations tab is showing its create form rather than its list.
	 *
	 * The peer of `creating` on the Databases tab, and named separately from
	 * `creatingGroup` because that one is the in-flight flag, not the view.
	 */
	let addingGroup = $state(false);

	type Tab = 'databases' | 'groups';
	let tab = $state<Tab>('databases');
	let editingAccount = $state(false);
	let deleteTarget = $state<DbRemoteDatabase | null>(null);
	let deleting = $state(false);
	/**
	 * The database being renamed, and its new name.
	 *
	 * A view like `creating` and `addingGroup`, not a modal on top of a modal:
	 * the row's pencil swaps the list for a form and the footer carries the
	 * action, which is the shape everything else in this dialog already has.
	 */
	let renameTarget = $state<DbRemoteDatabase | null>(null);
	let renameName = $state('');
	let renaming = $state(false);

	const isEditing = $derived(link !== null);
	const accounts = $derived(dbAccountsStore.accounts);
	const account = $derived(accounts.find((entry) => entry.accountId === accountId) ?? null);
	const provider = $derived<DbProviderInfo | null>(
		account ? dbAccountsStore.providers.find((entry) => entry.id === account.provider) ?? null : null
	);
	const remote = $derived(accountId ? dbAccountsStore.remoteFor(accountId) : null);
	const selectedMode = $derived(provider?.modes.find((entry) => entry.id === mode) ?? null);
	const hasAdvancedModes = $derived((provider?.modes ?? []).some((entry) => entry.isAdvanced));
	const databases = $derived<DbRemoteDatabase[]>(remote?.data ?? []);
	const selected = $derived(databases.find((database) => database.ref === remoteRef) ?? null);

	/**
	 * Providers with no account yet.
	 *
	 * Listed as a connect action rather than hidden, because "Supabase is not in
	 * this list" is indistinguishable from "Clopen does not support Supabase"
	 * for someone who has never connected one.
	 */
	const connectable = $derived(
		dbAccountsStore.providers.filter(
			(entry) => !accounts.some((connected) => connected.provider === entry.id)
		)
	);

	/**
	 * Accounts grouped by provider.
	 *
	 * Two accounts of the SAME provider is the case a flat list cannot render:
	 * both rows carry the same mark and differ only by a label the user chose,
	 * so the vendor has to be said once above them rather than implied twice
	 * inside them.
	 */
	const accountGroups = $derived.by(() => {
		const byProvider = new Map<string, DbClientAccountInfo[]>();
		for (const entry of accounts) {
			const list = byProvider.get(entry.provider) ?? [];
			list.push(entry);
			byProvider.set(entry.provider, list);
		}
		return [...byProvider.entries()].map(([id, list]) => ({
			provider: id,
			name: dbAccountsStore.providers.find((entry) => entry.id === id)?.name ?? id,
			accounts: list
		}));
	});

	// Seed on open. `link` decides between the two shapes the dialog serves.
	//
	// The account list is read through `untrack`: this effect must run when the
	// dialog OPENS, not every time that list changes. Without it, connecting an
	// account from inside the dialog reloads the list, re-runs this, and resets
	// the selection `onConnected` had just made — the new account is chosen and
	// then silently unchosen.
	$effect(() => {
		if (!isOpen) return;
		showConnect = false;
		if (link) {
			accountId = link.accountId;
			remoteRef = link.remoteRef;
			label = link.label;
			mode = link.mode;
		} else {
			accountId = untrack(() => accounts[0]?.accountId ?? '');
			remoteRef = '';
			label = '';
			mode = '';
		}
		secrets = {};
		error = null;
		showAdvanced = false;
		creating = false;
		provisioning = false;
		addingGroup = false;
		newGroupName = '';
		tab = 'databases';
		deleteTarget = null;
		renameTarget = null;
	});

	// Health is only ever written by a probe, and nothing probes on connect — so
	// an account read "UNKNOWN" indefinitely, which looks like a fault rather
	// than like a question nobody had asked yet.
	$effect(() => {
		if (!isOpen || !accountId) return;
		if (account?.status !== 'unknown') return;
		dbAccountsStore.probeAccount(accountId);
	});

	// The Organisations tab needs the same options the create form does.
	$effect(() => {
		if (!isOpen || tab !== 'groups' || !accountId || createOptions || createBusy) return;
		void loadCreateOptions();
	});

	// The default mode comes from the provider, which is only known once an
	// account is chosen.
	$effect(() => {
		if (!provider || mode) return;
		mode = provider.modes.find((entry) => entry.isDefault)?.id ?? provider.modes[0]?.id ?? '';
	});

	// Fetch the account's databases once, when it is chosen. Editing skips it:
	// the database is already decided and re-listing would only be able to
	// change it.
	//
	// `ensureRemoteDatabases` decides "already asked" from a plain Set rather
	// than from the cell. Reading the cell here is what made this effect write
	// what it had just subscribed to, re-run, and fire a request per frame until
	// Supabase answered 429.
	$effect(() => {
		if (!isOpen || !accountId || isEditing) return;
		dbAccountsStore.ensureRemoteDatabases(accountId);
	});

	function pick(database: DbRemoteDatabase): void {
		if (database.isLinked || !database.isReady) return;
		remoteRef = database.ref;
		if (!label.trim()) label = database.name;
	}

	/** Fetch the organisations and regions both the form and the tab need. */
	async function loadCreateOptions(): Promise<boolean> {
		createBusy = true;
		try {
			createOptions = await dbAccountsStore.createOptions(accountId);
			createGroup = createOptions?.groups[0]?.value ?? '';
			createRegion = createOptions?.regions[0]?.value ?? '';
			return true;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load the create form';
			return false;
		} finally {
			createBusy = false;
		}
	}

	/** Switch to the create form, fetching what it needs to render. */
	async function startCreating(): Promise<void> {
		error = null;
		creating = true;
		createName = '';
		if (createOptions) return;
		if (!(await loadCreateOptions())) creating = false;
	}

	/** Swap the list for the rename form, seeded with the name it has now. */
	function startRename(database: DbRemoteDatabase): void {
		error = null;
		renameTarget = database;
		renameName = database.name;
	}

	/**
	 * Rename a database at the provider.
	 *
	 * The provider's name, not the link's label — a linked database keeps
	 * whatever this install calls it, because that was typed here on purpose and
	 * is edited in the link form.
	 */
	async function renameDatabase(): Promise<void> {
		if (!renameTarget) return;
		const target = renameTarget;
		const next = renameName.trim();
		if (!next || next === target.name) {
			renameTarget = null;
			return;
		}
		renaming = true;
		error = null;
		try {
			await dbAccountsStore.renameDatabase(accountId, target.ref, next);
			renameTarget = null;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not rename that database';
		} finally {
			renaming = false;
		}
	}

	/**
	 * Destroy a database at the provider.
	 *
	 * Confirmed by naming it rather than by asking "are you sure": the name is
	 * the thing someone can check against what they meant. Unlinking is the other
	 * button and leaves the database alone — the confirm says which this is.
	 */
	async function deleteDatabase(): Promise<void> {
		if (!deleteTarget) return;
		const target = deleteTarget;
		deleting = true;
		error = null;
		try {
			await dbAccountsStore.deleteDatabase(accountId, target.ref);
			await dbAccountsStore.remoteDatabases(accountId);
			await dbClientStore.list();
			deleteTarget = null;
			if (remoteRef === target.ref) remoteRef = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not delete that database';
		} finally {
			deleting = false;
		}
	}

	/**
	 * Create the owning organisation and select it.
	 *
	 * The result is used DIRECTLY rather than re-read, and that reversal is the
	 * whole point. Re-reading looked more rigorous and was actually wrong: the
	 * options call verifies each candidate with `GET /v1/organizations/{slug}`,
	 * and a token may be permitted to CREATE an organisation while being unable
	 * to READ one — they are separate permissions. So the freshly created
	 * organisation failed verification and vanished from the list, and creating
	 * it again answered "you are already a member of an organisation named…".
	 *
	 * Having just created it is the strongest evidence available that this token
	 * can act in it. Throwing that away to ask a question the token cannot
	 * answer is how a working capability became a loop.
	 */
	async function createOrganisation(): Promise<void> {
		error = null;
		creatingGroup = true;
		try {
			const group = await dbAccountsStore.createGroup(accountId, newGroupName.trim());
			newGroupName = '';
			if (createOptions) {
				createOptions = {
					...createOptions,
					groups: [
						...createOptions.groups.filter((entry) => entry.value !== group.value),
						{ ...group, detail: 'just created' }
					]
				};
			}
			createGroup = group.value;
			if (!createRegion) createRegion = createOptions?.regions[0]?.value ?? '';
			// Back to the list, where the organisation that was just created is
			// now a row. Staying on an emptied form says nothing happened.
			addingGroup = false;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not create that organisation';
		} finally {
			creatingGroup = false;
		}
	}

	async function createDatabase(): Promise<void> {
		error = null;
		createBusy = true;
		provisioning = true;
		try {
			const result = await dbAccountsStore.createDatabase({
				accountId,
				name: createName.trim(),
				group: createGroup,
				region: createRegion
			});
			await dbClientStore.list();
			if (result.ready) {
				onDone?.();
				onClose();
				return;
			}
			// The database exists and its password is stored; it is simply not
			// answering yet. Saying so beats reporting a failure for something that
			// worked, or pretending a connection is ready when it is not.
			error =
				'Created, but it is still starting up. Its password is saved — open the link and press Save once it is running.';
			creating = false;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not create that database';
		} finally {
			createBusy = false;
			provisioning = false;
		}
	}

	const canCreate = $derived(
		!!createName.trim() && !!createGroup && !!createRegion && !createBusy
	);
	const canOfferCreate = $derived(!isEditing && !!accountId && provider !== null);
	/** Organisations only make sense where the provider has such a thing. */
	const canManageGroups = $derived(!isEditing && !!accountId && provider !== null);

	/**
	 * The group tab's label, pluralised in ONE place.
	 *
	 * `groupLabel` is singular ("Organisation"), and the tab used to append an
	 * "s" to it — including to the fallback, which was already plural, so the
	 * tab read "Organisationss" until the options finished loading and then
	 * silently corrected itself.
	 */
	const groupLabel = $derived(createOptions?.groupLabel ?? 'Organisation');
	const groupTabLabel = $derived(`${groupLabel}s`);

	/** The chosen organisation, when the provider could not confirm this token can use it. */
	const unverifiedGroup = $derived(
		createOptions?.groups.find((entry) => entry.value === createGroup && entry.isUnverified) ?? null
	);

	async function openConnect(providerId: string): Promise<void> {
		await integrationsStore.load();
		connectProvider = integrationsStore.providers.find((entry) => entry.id === providerId) ?? null;
	}

	/** Open the hub's connect dialog in reconfigure mode for this account. */
	async function editAccount(): Promise<void> {
		if (!account) return;
		await integrationsStore.load();
		connectProvider = integrationsStore.providers.find((entry) => entry.id === account.provider) ?? null;
		editingAccount = connectProvider !== null;
	}

	async function onConnected(): Promise<void> {
		// A credential change invalidates every answer derived from the old one —
		// which organisations are reachable, which databases exist, and whether
		// the token works at all.
		if (editingAccount) {
			createOptions = null;
			dbAccountsStore.forgetProbe(accountId);
			connectProvider = null;
			editingAccount = false;
			await dbAccountsStore.load({ force: true });
			await dbAccountsStore.remoteDatabases(accountId);
			dbAccountsStore.probeAccount(accountId);
			return;
		}
		connectProvider = null;
		// Back to the accounts: the list the user was adding to now has the thing
		// they added, and leaving the connect view up hides it.
		showConnect = false;
		// The new account has to reach this dialog's own list before it can be
		// selected, so the provider list is re-read rather than patched.
		await dbAccountsStore.load({ force: true });
		const latest = dbAccountsStore.accounts.at(-1);
		if (latest) accountId = latest.accountId;
	}

	async function save(): Promise<void> {
		error = null;
		saving = true;
		try {
			if (link) {
				await dbAccountsStore.updateLink(link.id, {
					label: label.trim() || undefined,
					mode,
					secrets
				});
			} else {
				await dbAccountsStore.link({ accountId, remoteRef, label: label.trim(), mode, secrets });
			}
			// The projection has already run on the server, so the panel's list is
			// one refresh behind rather than needing to be patched by hand.
			await dbClientStore.list();
			onDone?.();
			onClose();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not link that database';
		} finally {
			saving = false;
		}
	}

	const canSave = $derived(
		!!accountId &&
		!!remoteRef &&
		(provider?.secretFields ?? []).every(
			(field) =>
				!field.isRequired ||
				(secrets[field.name] ?? '').trim().length > 0 ||
				(link?.configuredSecrets ?? []).includes(field.name)
		)
	);
</script>

<Modal bind:isOpen title={isEditing ? 'Edit database link' : 'Add from an account'} size="lg" onClose={onClose}>
	<div class="flex flex-col gap-4">
		{#if accounts.length === 0 && connectable.length === 0}
			<div class="flex flex-col items-center gap-2 py-8 text-center">
				<Icon name="lucide:database" class="w-8 h-8 text-slate-300 dark:text-slate-600" />
				<p class="text-sm text-slate-500 dark:text-slate-400">
					No database providers are available on this install.
				</p>
			</div>
		{:else}
			<!-- Step 1: which account.
			     THREE SHAPES, because the question is a different one in each. With
			     nothing connected there is no account to choose and the providers
			     ARE the choice, so they are the primary control rather than a
			     dashed afterthought under an empty list. With one account there is
			     nothing to choose either, so it is one strip and adding a second
			     vendor is a link. With several, the vendor is said once above its
			     accounts — two accounts of one provider carry the same mark and
			     differ only by a label, which a flat list cannot show. -->
			{#if !isEditing}
				{#if accounts.length === 0}
					<div class="flex flex-col gap-2">
						<span class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
							Connect a provider
						</span>
						<div class="grid gap-2 sm:grid-cols-2">
							{#each connectable as entry (entry.id)}
								<button
									type="button"
									class="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-left hover:border-violet-400 hover:bg-violet-500/5 transition-colors cursor-pointer"
									onclick={() => openConnect(entry.id)}
								>
									<ProviderMark provider={entry.id} size="w-5 h-5" fallback="lucide:database" />
									<span class="flex flex-col min-w-0">
										<span class="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
											{entry.name}
										</span>
										{#if entry.docsUrl}
											<a
												href={entry.docsUrl}
												target="_blank"
												rel="noopener noreferrer"
												class="text-3xs text-slate-400 hover:text-violet-500 hover:underline truncate"
												onclick={(event) => event.stopPropagation()}
											>Where the credential lives ↗</a>
										{/if}
									</span>
									<Icon name="lucide:arrow-right" class="w-3.5 h-3.5 ml-auto shrink-0 text-slate-400" />
								</button>
							{/each}
						</div>
					</div>
				{:else}
					<div class="flex flex-col gap-2">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
								{accounts.length === 1 ? 'Account' : 'Accounts'}
							</span>
							{#if connectable.length > 0}
								<button
									type="button"
									class="text-xs text-violet-600 dark:text-violet-400 hover:underline cursor-pointer"
									onclick={() => (showConnect = !showConnect)}
								>
									{showConnect ? 'Back to accounts' : 'Connect another provider'}
								</button>
							{/if}
						</div>

						{#if showConnect}
							<div class="flex flex-col gap-1">
								{#each connectable as entry (entry.id)}
									<button
										type="button"
										class="flex items-center gap-2 px-3 h-10 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 text-left hover:border-violet-400 hover:bg-violet-500/5 transition-colors cursor-pointer"
										onclick={() => openConnect(entry.id)}
									>
										<ProviderMark provider={entry.id} size="w-4 h-4" fallback="lucide:database" />
										<span class="text-sm text-slate-700 dark:text-slate-300">Connect {entry.name}…</span>
										<Icon name="lucide:arrow-right" class="w-3.5 h-3.5 ml-auto text-slate-400" />
									</button>
								{/each}
							</div>
						{:else if accounts.length === 1}
							{@render accountRow(accounts[0])}
						{:else}
							{#each accountGroups as group (group.provider)}
								<div class="flex flex-col gap-1">
									<span class="flex items-center gap-1.5 text-3xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
										<ProviderMark provider={group.provider} size="w-3 h-3" fallback="lucide:database" />
										{group.name}
									</span>
									{#each group.accounts as entry (entry.accountId)}
										{@render accountRow(entry)}
									{/each}
								</div>
							{/each}
						{/if}
					</div>
				{/if}
			{/if}

			<!-- Two peers. Organisations used to hide inside the create form's
			     empty state, which made it findable only after something failed. -->
			{#if canManageGroups}
				<div class="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800 -mt-1">
					{#each [{ id: 'databases', label: 'Databases' }, { id: 'groups', label: groupTabLabel }] as entry (entry.id)}
						<button
							type="button"
							class="px-3 h-8 text-xs font-semibold border-b-2 -mb-px transition-colors cursor-pointer
								{tab === entry.id
									? 'border-violet-500 text-violet-700 dark:text-violet-300'
									: 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}"
							onclick={() => (tab = entry.id as Tab)}
						>
							{entry.label}
						</button>
					{/each}
				</div>
			{/if}

			<!-- Organisations. Built to the SAME shape as the database list above —
			     section header with its actions, then rows, then the notices —
			     because two tabs of one dialog that lay their contents out
			     differently read as two dialogs that happen to share a frame. -->
			{#if tab === 'groups'}
				<div class="flex flex-col gap-2">
					<div class="flex items-center justify-between">
						<span class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
							{addingGroup ? `New ${groupLabel.toLowerCase()}` : groupLabel}
						</span>
						{#if addingGroup}
							<button
								type="button"
								class="text-xs text-slate-500 hover:text-violet-600 dark:hover:text-violet-400 cursor-pointer"
								onclick={() => (addingGroup = false)}
							>
								Back to the list
							</button>
						{:else}
							<div class="flex items-center gap-3">
								{#if createOptions?.canCreateGroup}
									<button
										type="button"
										class="text-xs text-violet-600 dark:text-violet-400 hover:underline cursor-pointer"
										onclick={() => {
											newGroupName = '';
											addingGroup = true;
										}}
									>
										New {groupLabel.toLowerCase()}
									</button>
								{/if}
								<button
									type="button"
									class="text-xs text-slate-500 hover:text-violet-600 dark:hover:text-violet-400 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
									onclick={loadCreateOptions}
									disabled={createBusy}
								>
									Refresh
								</button>
							</div>
						{/if}
					</div>

					{#if addingGroup && createOptions}
						<!-- The same shape the database form uses: one labelled field,
						     the notice under it, and the primary action in the footer.
						     This used to be an input and a Create button pinned below the
						     list, so the two tabs asked for a new thing in two different
						     ways. -->
						<label class="flex flex-col gap-1">
							<span class="text-xs text-slate-500 dark:text-slate-400">Name</span>
							<input
								type="text"
								bind:value={newGroupName}
								placeholder="Acme"
								class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
							/>
						</label>
						<p class="text-xs text-slate-500 dark:text-slate-400">
							{createOptions.createGroupNotice}
						</p>
					{:else if createBusy && !createOptions}
						<div class="flex flex-col gap-1">
							{#each [0, 1, 2] as row (row)}
								<div class="h-10 rounded-lg bg-slate-100 dark:bg-slate-800/60 animate-pulse"></div>
							{/each}
						</div>
					{:else if createOptions}
						{#if createOptions.groups.length === 0}
							<p class="text-xs text-slate-500 dark:text-slate-400">
								{createOptions.emptyGroupsNotice}
							</p>
							{@render consoleLink()}
						{:else}
							<div class="flex flex-col gap-1 max-h-56 overflow-y-auto">
								{#each createOptions.groups as group (group.value)}
									<div class="flex items-center gap-2 px-3 py-2 min-h-10 rounded-lg border border-slate-200 dark:border-slate-700 min-w-0">
										<Icon name="lucide:building-2" class="w-4 h-4 text-slate-400 shrink-0" />
										<span class="text-sm text-slate-800 dark:text-slate-200 truncate">{group.label}</span>
										{#if group.isUnverified}
											<span class="ml-auto text-3xs uppercase tracking-wider text-amber-600 dark:text-amber-400 shrink-0">
												unverified
											</span>
										{:else if group.detail}
											<span class="ml-auto text-3xs uppercase tracking-wider text-slate-400 shrink-0">
												{group.detail}
											</span>
										{/if}
									</div>
								{/each}
							</div>
						{/if}

						<!-- Stated rather than left as missing buttons, and PROVIDER-
						     DECLARED: which of create/rename/delete exist differs per
						     vendor, and hard-coding one sentence sent a Neon user to
						     Supabase's dashboard. -->
						{#if createOptions?.groupManagementNotice}
							<!-- The sentence AND the trip. Saying "this is managed in the
							     vendor's console" and leaving the user to find it is the
							     read-only window this surface exists to remove, and the
							     link is provider-declared so it is not only Neon that
							     gets one. -->
							<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
								<p class="text-xs text-slate-500 dark:text-slate-500">
									{createOptions.groupManagementNotice}
								</p>
								{@render consoleLink()}
							</div>
						{/if}
					{/if}
				</div>
			{/if}

			<!-- Step 2: which database -->
			{#if tab === 'databases' && accountId && !isEditing && !creating && !renameTarget}
				<div class="flex flex-col gap-2">
					<div class="flex items-center justify-between">
						<span class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
							Database
						</span>
						<div class="flex items-center gap-3">
							{#if canOfferCreate}
								<button
									type="button"
									class="text-xs text-violet-600 dark:text-violet-400 hover:underline cursor-pointer"
									onclick={startCreating}
								>
									New database
								</button>
							{/if}
							<!-- Disabled while it works, like the Organisations tab's. The
							     fetch always ran, but the skeleton only shows on an EMPTY
							     list, so refreshing a list that already had rows changed
							     nothing on screen and read as a dead button. -->
							<button
								type="button"
								class="text-xs text-slate-500 hover:text-violet-600 dark:hover:text-violet-400 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
								onclick={() => dbAccountsStore.remoteDatabases(accountId)}
								disabled={remote?.loading}
							>
								Refresh
							</button>
						</div>
					</div>

					{#if remote?.loading && databases.length === 0}
						<div class="flex flex-col gap-1">
							{#each [0, 1, 2] as row (row)}
								<div class="h-10 rounded-lg bg-slate-100 dark:bg-slate-800/60 animate-pulse"></div>
							{/each}
						</div>
					{:else if remote?.error}
						<p class="px-3 py-2 rounded-md text-xs bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300">
							{remote.error}
						</p>
					{:else if databases.length === 0}
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
							<p class="text-xs text-slate-500 dark:text-slate-400">
								This account reaches no databases yet.
							</p>
							{@render consoleLink()}
						</div>
					{:else}
						<div class="flex flex-col gap-1 max-h-56 overflow-y-auto">
							{#each databases as database (database.ref)}
								{@render databaseRow(database)}
							{/each}
						</div>
					{/if}
				</div>
			{/if}

			<!-- Rename one. Same shape as the create views: header, one field, and
			     the action in the footer. -->
			{#if tab === 'databases' && renameTarget}
				<div class="flex flex-col gap-2">
					<div class="flex items-center justify-between">
						<span class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
							Rename database
						</span>
						<button
							type="button"
							class="text-xs text-slate-500 hover:text-violet-600 dark:hover:text-violet-400 cursor-pointer"
							onclick={() => (renameTarget = null)}
						>
							Back to the list
						</button>
					</div>

					<label class="flex flex-col gap-1">
						<span class="text-xs text-slate-500 dark:text-slate-400">Name</span>
						<input
							type="text"
							bind:value={renameName}
							placeholder={renameTarget.name}
							class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
						/>
					</label>
					<p class="text-xs text-slate-500 dark:text-slate-400">
						This renames the database at the provider, not this connection's own name.
					</p>
				</div>
			{/if}

			<!-- Create a database instead of picking one -->
			{#if tab === 'databases' && creating && !createOptions}
				<!--
					The options have to be fetched before this form can be drawn, and
					the first version simply rendered NOTHING while that was in flight:
					clicking New database blanked the dialog for a second and then
					filled it, which reads as a glitch rather than as work. A skeleton
					shaped like the form that is coming says "this is loading" without
					a spinner that says nothing about what for.
				-->
				<div class="flex flex-col gap-3" aria-busy="true">
					<div class="h-3 w-24 rounded bg-slate-100 dark:bg-slate-800/60 animate-pulse"></div>
					<div class="h-9 rounded-md bg-slate-100 dark:bg-slate-800/60 animate-pulse"></div>
					<div class="grid grid-cols-2 gap-2">
						<div class="h-9 rounded-md bg-slate-100 dark:bg-slate-800/60 animate-pulse"></div>
						<div class="h-9 rounded-md bg-slate-100 dark:bg-slate-800/60 animate-pulse"></div>
					</div>
					<div class="h-12 rounded-md bg-slate-100 dark:bg-slate-800/60 animate-pulse"></div>
				</div>
			{/if}

			{#if tab === 'databases' && creating && createOptions}
				<div class="flex flex-col gap-3">
					<div class="flex items-center justify-between">
						<span class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
							New database
						</span>
						<button
							type="button"
							class="text-xs text-slate-500 hover:text-violet-600 dark:hover:text-violet-400 cursor-pointer"
							onclick={() => (creating = false)}
						>
							Back to the list
						</button>
					</div>

					{#if createOptions.groups.length === 0}
						<!-- No database form. Every field below depends on an
						     organisation, so rendering them would only lead to a failure
						     after the work of filling them in. What IS offered is the way
						     out of the dead end. -->
						<InlineError message={createOptions.emptyGroupsNotice} />

						{#if createOptions.canCreateGroup}
							<div class="flex flex-col gap-2 pt-1 border-t border-slate-200 dark:border-slate-800">
								<span class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
									New {createOptions.groupLabel.toLowerCase()}
								</span>
								<div class="flex items-center gap-2">
									<!-- Both h-9: a Button's own padding makes it taller than an
									     input sized by its text, and the two then never line up. -->
									<input
										type="text"
										bind:value={newGroupName}
										placeholder="Acme"
										class="flex-1 min-w-0 h-9 px-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
									/>
									<button
										type="button"
										class="flex items-center justify-center gap-1.5 h-9 px-3 shrink-0 rounded-md border border-slate-200 dark:border-slate-700 text-sm font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
										onclick={createOrganisation}
										disabled={!newGroupName.trim() || creatingGroup}
									>
										{#if creatingGroup}
											<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
										{/if}
										Create
									</button>
								</div>
								<p class="text-xs text-slate-500 dark:text-slate-400">
									{createOptions.createGroupNotice}
								</p>
							</div>
						{/if}
					{:else}
					<label class="flex flex-col gap-1">
						<span class="text-xs text-slate-500 dark:text-slate-400">Name</span>
						<input
							type="text"
							bind:value={createName}
							placeholder="my-app"
							class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
						/>
					</label>

					<div class="grid grid-cols-2 gap-2">
						<label class="flex flex-col gap-1 min-w-0">
							<span class="text-xs text-slate-500 dark:text-slate-400">{createOptions.groupLabel}</span>
							<select
								bind:value={createGroup}
								disabled={createOptions.groups.length === 0}
								class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100 disabled:opacity-60 disabled:cursor-not-allowed"
							>
								{#each createOptions.groups as group (group.value)}
									<option value={group.value}>{group.label}{group.detail ? ` — ${group.detail}` : ''}</option>
								{/each}
							</select>
						</label>
						<label class="flex flex-col gap-1 min-w-0">
							<span class="text-xs text-slate-500 dark:text-slate-400">{createOptions.regionLabel}</span>
							<select
								bind:value={createRegion}
								class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
							>
								{#each createOptions.regions as region (region.value)}
									<option value={region.value}>{region.label}</option>
								{/each}
							</select>
						</label>
					</div>

					{#if unverifiedGroup}
						<!-- Offered, but not vouched for. The token can see this
						     organisation through a project without being allowed to read
						     it, and reading and creating are separate permissions — so
						     this may work. Saying which it is beats both hiding the
						     option and pretending it is fine. -->
						<p class="px-3 py-2 rounded-md text-xs bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300">
							This token cannot read <span class="font-semibold">{unverifiedGroup.label}</span>, so
							creating here may be refused. Worth trying — if it fails, the error names the
							permission to add.
						</p>
					{/if}

					<!-- Names the consequence. Creating one is not a local action. -->
					<p class="px-3 py-2 rounded-md text-xs bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300">
						{createOptions.notice}
					</p>

					<p class="text-xs text-slate-500 dark:text-slate-400">
						Clopen sets the database password, so there is nothing to type — it is stored here,
						encrypted, the moment the database exists.
					</p>

					{#if provisioning}
						<p class="text-xs text-slate-500 dark:text-slate-400">
							Provisioning takes about a minute. Leave this open.
						</p>
					{/if}
					{/if}
				</div>
			{/if}

			<!-- Step 3: how to connect -->
			{#if tab === 'databases' && provider && !creating && !renameTarget && (remoteRef || isEditing)}
				<div class="flex flex-col gap-3 pt-1 border-t border-slate-200 dark:border-slate-800">
					<label class="flex flex-col gap-1">
						<span class="text-xs text-slate-500 dark:text-slate-400">Name</span>
						<input
							type="text"
							bind:value={label}
							placeholder={selected?.name ?? remoteRef}
							class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
						/>
					</label>

					<!-- One line, not a radio list. The default is right in every case
					     the alternatives are not, so the alternatives are folded away
					     rather than put in front of someone who has no way to choose
					     between them yet. -->
					<div class="flex flex-col gap-1.5">
						<div class="flex items-center gap-2 text-xs">
							<span class="text-slate-500 dark:text-slate-400">Connection</span>
							<span class="text-slate-800 dark:text-slate-200">{selectedMode?.label ?? mode}</span>
							{#if hasAdvancedModes}
								<button
									type="button"
									class="ml-auto text-slate-500 hover:text-violet-600 dark:hover:text-violet-400 cursor-pointer"
									onclick={() => (showAdvanced = !showAdvanced)}
								>
									{showAdvanced ? 'Hide options' : 'Change'}
								</button>
							{/if}
						</div>

						{#if showAdvanced}
							<div class="flex flex-col gap-0.5 pl-0.5">
								{#each provider.modes as option (option.id)}
									<label class="flex items-baseline gap-2 px-2 py-1.5 rounded-md cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50">
										<input
											type="radio"
											name="db-link-mode"
											value={option.id}
											checked={mode === option.id}
											onchange={() => (mode = option.id)}
											class="accent-violet-600"
										/>
										<span class="text-sm text-slate-800 dark:text-slate-200">{option.label}</span>
										<span class="text-xs text-slate-500 dark:text-slate-400 truncate">{option.help}</span>
									</label>
								{/each}
							</div>
						{/if}
					</div>

					{#each provider.secretFields as field (field.name)}
						<label class="flex flex-col gap-1">
							<span class="text-xs text-slate-500 dark:text-slate-400">
								{field.label}
								{#if (link?.configuredSecrets ?? []).includes(field.name)}
									<span class="text-slate-400">— set, leave blank to keep</span>
								{/if}
							</span>
							<input
								type="password"
								value={secrets[field.name] ?? ''}
								placeholder={field.placeholder ?? ''}
								onchange={(e) => (secrets = { ...secrets, [field.name]: e.currentTarget.value })}
								class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
							/>
							{#if field.help}
								<span class="text-xs text-slate-500 dark:text-slate-500">{field.help}</span>
							{/if}
						</label>
					{/each}

				</div>
			{/if}

			{#if error}
				<p class="px-3 py-2 rounded-md text-xs bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 wrap-anywhere">
					{error}
				</p>
			{/if}

			<div class="flex items-center justify-end gap-2">
				<Button size="sm" variant="outline" onclick={onClose}>Cancel</Button>
				<!-- Gated on the tab as well as on the view, because the views live on
				     one tab each: without it, switching to Organisations mid-create
				     left "Create database" sitting under a list of organisations. -->
				{#if tab === 'databases' && creating}
					{#if (createOptions?.groups.length ?? 0) > 0}
						<Button size="sm" onclick={createDatabase} disabled={!canCreate} loading={createBusy}>
							Create database
						</Button>
					{/if}
				{:else if tab === 'databases' && renameTarget}
					<Button
						size="sm"
						onclick={renameDatabase}
						disabled={!renameName.trim() || renaming}
						loading={renaming}
					>
						Rename database
					</Button>
				{:else if tab === 'groups' && addingGroup}
					<Button
						size="sm"
						onclick={createOrganisation}
						disabled={!newGroupName.trim() || creatingGroup}
						loading={creatingGroup}
					>
						Create {groupLabel.toLowerCase()}
					</Button>
				{:else}
					<Button size="sm" onclick={save} disabled={!canSave || saving} loading={saving}>
						{isEditing ? 'Save' : 'Add connection'}
					</Button>
				{/if}
			</div>
		{/if}
	</div>
</Modal>

<!--
	Deleting names the database and says what survives, because the button beside
	it (unlink) looks similar and does something entirely different: one removes
	Clopen's connection, the other destroys the data.
-->
<ConfirmDestructive
	isOpen={deleteTarget !== null}
	title="Delete this database?"
	message={deleteTarget
		? `This permanently deletes "${deleteTarget.name}" and everything in it, at the provider. It cannot be undone, and it is not the same as unlinking — unlinking only removes the connection here.`
		: ''}
	confirmText={deleting ? 'Deleting…' : 'Delete database'}
	onConfirm={deleteDatabase}
	onClose={() => (deleteTarget = null)}
/>

<!-- The hub's own connect dialog, embedded. Kept mounted so it animates in. -->
<ConnectAccountModal
	provider={connectProvider}
	account={editingAccount ? integrationsStore.accounts.find((entry) => entry.id === accountId) ?? null : null}
	onClose={() => {
		connectProvider = null;
		editingAccount = false;
	}}
	onConnected={onConnected}
/>

{#snippet consoleLink()}
	{#if provider?.consoleUrl}
		<a
			href={provider.consoleUrl}
			target="_blank"
			rel="noopener noreferrer"
			class="inline-flex items-center gap-1 text-xs font-medium text-violet-600 dark:text-violet-400 hover:underline"
		>
			Open {provider.name}
			<Icon name="lucide:external-link" class="w-3 h-3" />
		</a>
	{/if}
{/snippet}

{#snippet accountRow(entry: DbClientAccountInfo)}
	<div
		class="flex items-center gap-2 pl-3 pr-1.5 py-2 min-h-10 rounded-lg border transition-colors min-w-0
			{accountId === entry.accountId
				? 'border-violet-400 bg-violet-500/10'
				: 'border-slate-200 dark:border-slate-700'}"
	>
		<button
			type="button"
			class="flex items-center gap-2 flex-1 min-w-0 h-full text-left cursor-pointer"
			onclick={() => {
				accountId = entry.accountId;
				remoteRef = '';
				mode = '';
			}}
		>
			<ProviderMark provider={entry.provider} size="w-4 h-4" fallback="lucide:database" />
			<span class="text-sm text-slate-800 dark:text-slate-200 truncate">{entry.label}</span>
		</button>

		<!-- `unknown` is not a fault, it is a question nobody asked yet, so it
		     reads as a neutral "checking…" while the probe runs. -->
		{#if entry.status === 'unknown'}
			<span class="text-3xs uppercase tracking-wider text-slate-400 shrink-0">checking…</span>
		{:else if entry.status !== 'ok'}
			<span class="text-3xs uppercase tracking-wider text-amber-600 dark:text-amber-400 shrink-0">
				{entry.status.replace(/_/g, ' ')}
			</span>
		{/if}

		<!-- Changing a token must be possible from where the token is failing. -->
		{#if accountId === entry.accountId}
			<button
				type="button"
				class="flex items-center justify-center w-7 h-7 shrink-0 rounded-md text-slate-500 hover:text-violet-600 hover:bg-violet-500/10 cursor-pointer"
				onclick={editAccount}
				title="Edit this account's credentials"
				aria-label="Edit account"
			>
				<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
			</button>
		{/if}
	</div>
{/snippet}

{#snippet databaseRow(database: DbRemoteDatabase)}
	{@const unavailable = database.isLinked || !database.isReady}
	<div
		class="flex items-center gap-2 pl-3 pr-1.5 py-2 min-h-10 rounded-lg border transition-colors min-w-0
			{unavailable
				? 'border-slate-200 dark:border-slate-800'
				: remoteRef === database.ref
					? 'border-violet-400 bg-violet-500/10'
					: 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50'}"
	>
		<button
			type="button"
			disabled={unavailable}
			class="flex items-center gap-2 flex-1 min-w-0 text-left {unavailable
				? 'opacity-50 cursor-not-allowed'
				: 'cursor-pointer'}"
			onclick={() => pick(database)}
		>
			<span class="flex flex-col gap-0.5 min-w-0">
				<span class="text-sm text-slate-800 dark:text-slate-200 truncate">{database.name}</span>
				{#if database.group || database.detail}
					<span class="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 min-w-0">
						{#if database.group}
							<Icon name="lucide:building-2" class="w-3 h-3 shrink-0" />
							<span class="truncate">{database.group}</span>
						{/if}
						{#if database.group && database.detail}
							<span class="text-slate-300 dark:text-slate-600 shrink-0">·</span>
						{/if}
						{#if database.detail}
							<span class="truncate shrink-0">{database.detail}</span>
						{/if}
					</span>
				{/if}
			</span>
		</button>

		{#if database.isLinked}
			<span class="text-3xs uppercase tracking-wider text-slate-400 shrink-0">Linked</span>
		{:else if !database.isReady}
			<!-- A project that is paused or still coming up looks ordinary in a
			     list and refuses every connection, so it says which it is. -->
			<span class="text-3xs uppercase tracking-wider text-amber-600 dark:text-amber-400 shrink-0">
				{(database.status ?? 'unavailable').toLowerCase().replace(/_/g, ' ')}
			</span>
		{/if}

		<button
			type="button"
			class="flex items-center justify-center w-7 h-7 shrink-0 rounded-md text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/10 cursor-pointer"
			onclick={() => startRename(database)}
			title="Rename this database at the provider"
			aria-label="Rename database"
		>
			<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
		</button>

		<button
			type="button"
			class="flex items-center justify-center w-7 h-7 shrink-0 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-500/10 cursor-pointer"
			onclick={() => (deleteTarget = database)}
			title="Delete this database at the provider"
			aria-label="Delete database"
		>
			<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
		</button>
	</div>
{/snippet}
