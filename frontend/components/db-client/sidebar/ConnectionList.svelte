<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ProviderMark from '$frontend/components/common/display/ProviderMark.svelte';
	import ConnectionBadge from './ConnectionBadge.svelte';
	import ConnectionForm from './ConnectionForm.svelte';
	import LinkDatabaseModal from '../accounts/LinkDatabaseModal.svelte';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';
	import { dbAccountsStore } from '$frontend/stores/features/db-client-accounts.svelte';
	import type { DbAccountLinkInfo, DbClientConnection } from '$shared/types/db-client';

	interface Props {
		onSelect?: () => void;
	}

	const { onSelect }: Props = $props();

	type Mode =
		| { kind: 'list' }
		| { kind: 'create' }
		| { kind: 'edit'; connection: DbClientConnection };

	let mode = $state<Mode>({ kind: 'list' });
	let searchQuery = $state('');
	let linkOpen = $state(false);
	let editingLink = $state<DbAccountLinkInfo | null>(null);

	/**
	 * The account entry points, loaded once when the list is shown.
	 *
	 * The call is admin-gated, and a member's failure is not surfaced: the entry
	 * points simply do not appear, which is the honest rendering of "you cannot
	 * connect accounts here".
	 */
	$effect(() => {
		if (mode.kind !== 'list') return;
		dbAccountsStore.ensureLoaded();
		// NOT fire-once: which project is open decides the answer, and a guard
		// keyed on nothing would keep offering the previous project's stack after
		// a switch. It is a local file read, and this effect only re-runs when the
		// sidebar returns to the list.
		void dbAccountsStore.detectLocal();
	});

	const canLink = $derived(
		dbAccountsStore.accounts.length > 0 || dbAccountsStore.providers.length > 0
	);
	const localStack = $derived(dbAccountsStore.localStack);

	$effect(() => {
		dbClientStore.setFormOpen(mode.kind !== 'list');
	});

	const connections = $derived(dbClientStore.connections);
	const activeId = $derived(dbClientStore.activeConnectionId);
	const health = $derived(dbClientStore.health);

	const filtered = $derived.by(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return connections;
		return connections.filter((c) => {
			const subtitle = `${c.host ?? ''} ${c.database ?? ''}`.toLowerCase();
			return c.name.toLowerCase().includes(q) || subtitle.includes(q);
		});
	});

	function startCreate(): void {
		mode = { kind: 'create' };
	}

	function openLink(link: DbAccountLinkInfo | null): void {
		editingLink = link;
		linkOpen = true;
	}

	/** Adopt the `supabase start` stack the open project already describes. */
	async function adoptLocal(): Promise<void> {
		const created = await dbAccountsStore.adoptLocal();
		await dbClientStore.list();
		dbClientStore.setActive(created.id);
		onSelect?.();
	}

	function startEdit(connection: DbClientConnection, e: MouseEvent): void {
		e.stopPropagation();
		mode = { kind: 'edit', connection };
	}

	function backToList(): void {
		mode = { kind: 'list' };
	}

	function onSelectConnection(connection: DbClientConnection): void {
		dbClientStore.setActive(connection.id);
		onSelect?.();
	}

	async function onDelete(connection: DbClientConnection, e: MouseEvent): Promise<void> {
		e.stopPropagation();
		// A managed connection is removed by dropping its LINK — deleting the row
		// would leave the account owning a connection that no longer exists, and
		// the next re-projection would put it straight back.
		if (connection.managedBy) {
			const link = dbAccountsStore.linkForConnection(connection.id);
			if (!link) return;
			if (!confirm(`Unlink "${connection.name}" from ${connection.managedBy.accountLabel}?`)) return;
			await dbAccountsStore.unlink(link.id);
			await dbClientStore.list();
			return;
		}
		if (!confirm(`Delete connection "${connection.name}"?`)) return;
		await dbClientStore.remove(connection.id);
	}
</script>

<div class="flex flex-col h-full min-h-0">
	{#if mode.kind === 'list'}
		<!-- Unified header: title/search + add -->
		<div
			class="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0"
		>
			{#if connections.length > 0}
				<div
					class="flex-1 flex items-center gap-2 px-2.5 py-1 bg-slate-100/80 dark:bg-slate-800/60 rounded-md"
				>
					<Icon name="lucide:search" class="w-3.5 h-3.5 text-slate-400" />
					<input
						type="text"
						bind:value={searchQuery}
						placeholder="Search connections…"
						class="py-1 flex-1 bg-transparent border-none outline-none text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 min-w-0"
					/>
				</div>
			{:else}
				<span
					class="flex-1 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
				>
					Connections
				</span>
			{/if}
			<button
				type="button"
				class="flex items-center justify-center w-6 h-6 rounded-md text-slate-500 hover:bg-violet-500/10 hover:text-violet-600 transition-colors shrink-0"
				onclick={startCreate}
				aria-label="New connection"
				title="New connection"
			>
				<Icon name="lucide:plus" class="w-4 h-4" />
			</button>
		</div>

		<!-- List -->
		<div class="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1">
			<!-- Connecting starts HERE, not in Settings. A user already in DB Client
			     must never be told to go somewhere else to add a database. -->
			{#if canLink || localStack}
				<div class="flex flex-col gap-1 pb-2 mb-1 border-b border-slate-200/70 dark:border-slate-800">
					{#if canLink}
						<button
							type="button"
							class="flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-slate-600 dark:text-slate-300 hover:bg-violet-500/10 hover:text-violet-700 dark:hover:text-violet-300 transition-colors cursor-pointer"
							onclick={() => openLink(null)}
						>
							<Icon name="lucide:link" class="w-4 h-4 shrink-0 text-slate-400" />
							<span class="text-xs font-medium">Add from an account…</span>
						</button>
					{/if}
					{#if localStack && !localStack.alreadyAdded}
						<button
							type="button"
							class="flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-slate-600 dark:text-slate-300 hover:bg-violet-500/10 hover:text-violet-700 dark:hover:text-violet-300 transition-colors cursor-pointer"
							onclick={adoptLocal}
						>
							<ProviderMark provider="supabase" size="w-4 h-4" fallback="lucide:database" />
							<span class="flex flex-col min-w-0">
								<span class="text-xs font-medium">Use the local Supabase stack</span>
								<span class="text-3xs text-slate-400 truncate">
									Detected in this project · port {localStack.dbPort}
								</span>
							</span>
						</button>
					{/if}
				</div>
			{/if}

			{#if dbClientStore.isLoading && connections.length === 0}
				<div class="flex items-center justify-center py-8 text-xs text-slate-500">Loading…</div>
			{:else if connections.length === 0}
				<div class="flex flex-col items-center gap-2 py-8 px-3 text-center text-slate-500">
					<Icon name="lucide:database" class="w-8 h-8 opacity-40" />
					<span class="text-xs">No connections yet</span>
					<button
						type="button"
						class="text-xs text-violet-600 hover:text-violet-700 dark:text-violet-400 underline"
						onclick={startCreate}
					>
						Add your first connection
					</button>
				</div>
			{:else}
				{#each filtered as connection (connection.id)}
					<div class="group relative">
						<ConnectionBadge
							{connection}
							health={health[connection.id]}
							active={activeId === connection.id}
							onClick={() => onSelectConnection(connection)}
						/>
						<div
							class="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
						>
							<button
								type="button"
								class="flex items-center justify-center w-6 h-6 rounded-md bg-white/80 dark:bg-slate-800/80 text-slate-500 hover:text-violet-600 hover:bg-violet-500/10"
								onclick={(e) => startEdit(connection, e)}
								aria-label="Edit connection"
								title={connection.managedBy ? 'Managed by an account — open to see where it points' : 'Edit'}
							>
								<Icon name="lucide:pencil" class="w-3 h-3" />
							</button>
							<button
								type="button"
								class="flex items-center justify-center w-6 h-6 rounded-md bg-white/80 dark:bg-slate-800/80 text-slate-500 hover:text-red-600 hover:bg-red-500/10"
								onclick={(e) => onDelete(connection, e)}
								aria-label={connection.managedBy ? 'Unlink connection' : 'Delete connection'}
								title={connection.managedBy ? 'Unlink' : 'Delete'}
							>
								<Icon name="lucide:trash-2" class="w-3 h-3" />
							</button>
						</div>
					</div>
				{:else}
					<div class="text-center py-6 text-xs text-slate-500">No matches</div>
				{/each}
			{/if}

			{#if dbClientStore.error}
				<div
					class="mt-2 px-2.5 py-1.5 rounded-md text-xs bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300"
				>
					{dbClientStore.error}
				</div>
			{/if}
		</div>
	{:else}
		<!-- Form replaces list -->
		<div
			class="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0"
		>
			<button
				type="button"
				class="flex items-center justify-center w-6 h-6 rounded-md text-slate-500 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100 transition-colors"
				onclick={backToList}
				aria-label="Back to connections"
				title="Back"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
			</button>
			<span
				class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
			>
				{mode.kind === 'create' ? 'New Connection' : 'Edit Connection'}
			</span>
		</div>
		<div class="flex-1 min-h-0 overflow-y-auto p-3">
			{#if mode.kind === 'create'}
				<ConnectionForm connection={null} onSaved={backToList} onCancel={backToList} />
			{:else}
				<ConnectionForm
					connection={mode.connection}
					onSaved={backToList}
					onCancel={backToList}
					onEditLink={(connection) => openLink(dbAccountsStore.linkForConnection(connection.id))}
				/>
			{/if}
		</div>
	{/if}
</div>

<LinkDatabaseModal
	bind:isOpen={linkOpen}
	link={editingLink}
	onClose={() => {
		linkOpen = false;
		editingLink = null;
	}}
	onDone={() => (mode = { kind: 'list' })}
/>
