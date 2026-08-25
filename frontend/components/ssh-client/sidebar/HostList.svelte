<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import HostBadge from './HostBadge.svelte';
	import HostForm from './HostForm.svelte';
	import { sshClientStore } from '$frontend/stores/features/ssh-client.svelte';
	import type { SshConnection } from '$shared/types/ssh';

	interface Props {
		onSelect?: () => void;
	}

	const { onSelect }: Props = $props();

	type Mode = { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; connection: SshConnection };

	let mode = $state<Mode>({ kind: 'list' });
	let searchQuery = $state('');
	let pendingDelete = $state<SshConnection | null>(null);

	$effect(() => {
		sshClientStore.setFormOpen(mode.kind !== 'list');
	});

	const connections = $derived(sshClientStore.connections);
	const activeId = $derived(sshClientStore.activeConnectionId);
	const health = $derived(sshClientStore.health);

	const filtered = $derived.by(() => {
		const query = searchQuery.trim().toLowerCase();
		if (!query) return connections;
		return connections.filter((connection) => {
			const subtitle = `${connection.host} ${connection.username}`.toLowerCase();
			return connection.name.toLowerCase().includes(query) || subtitle.includes(query);
		});
	});

	function backToList(): void {
		mode = { kind: 'list' };
	}

	async function selectConnection(connection: SshConnection): Promise<void> {
		sshClientStore.setActive(connection.id);
		onSelect?.();
		try {
			// Opening the host here means the sidebar dot and the forwards are live
			// before the user asks for a shell or a directory listing.
			await sshClientStore.activate(connection.id);
		} catch (error) {
			sshClientStore.setError(error instanceof Error ? error.message : 'Could not connect');
		}
	}

	async function confirmDelete(): Promise<void> {
		const target = pendingDelete;
		pendingDelete = null;
		if (!target) return;
		await sshClientStore.remove(target.id);
	}
</script>

<div class="flex flex-col h-full min-h-0">
	{#if mode.kind === 'list'}
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
						placeholder="Search hosts…"
						class="py-1 flex-1 bg-transparent border-none outline-none text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 min-w-0"
					/>
				</div>
			{:else}
				<span
					class="flex-1 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
				>
					Hosts
				</span>
			{/if}
			<button
				type="button"
				class="flex items-center justify-center w-6 h-6 rounded-md text-slate-500 hover:bg-violet-500/10 hover:text-violet-600 transition-colors shrink-0"
				onclick={() => (mode = { kind: 'create' })}
				aria-label="New host"
				title="New host"
			>
				<Icon name="lucide:plus" class="w-4 h-4" />
			</button>
		</div>

		<div class="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1">
			{#if sshClientStore.isLoading && connections.length === 0}
				<div class="flex items-center justify-center py-8 text-xs text-slate-500">Loading…</div>
			{:else if connections.length === 0}
				<div class="flex flex-col items-center gap-2 py-8 px-3 text-center text-slate-500">
					<Icon name="lucide:server" class="w-8 h-8 opacity-40" />
					<span class="text-xs">No hosts yet</span>
					<button
						type="button"
						class="text-xs text-violet-600 hover:text-violet-700 dark:text-violet-400 underline"
						onclick={() => (mode = { kind: 'create' })}
					>
						Add your first host
					</button>
				</div>
			{:else}
				{#each filtered as connection (connection.id)}
					<!-- Actions sit beside the badge rather than floating over it on
					     hover: always visible, and never covering the host's address.
					     The wrapper carries the fill so it spans them too. -->
					<div
						class="flex items-center gap-0.5 pr-1 rounded-md transition-colors {activeId ===
						connection.id
							? 'bg-violet-500/10'
							: 'hover:bg-slate-100 dark:hover:bg-slate-800/60'}"
					>
						<div class="flex-1 min-w-0">
							<HostBadge
								{connection}
								health={health[connection.id]}
								active={activeId === connection.id}
								onClick={() => selectConnection(connection)}
							/>
						</div>
						<button
							type="button"
							class="flex items-center justify-center w-7 h-7 shrink-0 rounded-md text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/10 transition-colors"
							onclick={() => (mode = { kind: 'edit', connection })}
							aria-label="Edit host"
							title="Edit"
						>
							<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
						</button>
						<button
							type="button"
							class="flex items-center justify-center w-7 h-7 shrink-0 rounded-md text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-500/10 transition-colors"
							onclick={() => (pendingDelete = connection)}
							aria-label="Delete host"
							title="Delete"
						>
							<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
						</button>
					</div>
				{:else}
					<div class="text-center py-6 text-xs text-slate-500">No matches</div>
				{/each}
			{/if}

			{#if sshClientStore.error}
				<div
					class="mt-2 px-2.5 py-1.5 rounded-md text-xs bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 whitespace-pre-wrap wrap-anywhere"
				>
					{sshClientStore.error}
				</div>
			{/if}
		</div>
	{:else}
		<div
			class="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0"
		>
			<button
				type="button"
				class="flex items-center justify-center w-6 h-6 rounded-md text-slate-500 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100 transition-colors"
				onclick={backToList}
				aria-label="Back to hosts"
				title="Back"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
			</button>
			<span
				class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
			>
				{mode.kind === 'create' ? 'New Host' : 'Edit Host'}
			</span>
		</div>
		<div class="flex-1 min-h-0 overflow-y-auto p-3">
			{#if mode.kind === 'create'}
				<HostForm connection={null} onSaved={backToList} onCancel={backToList} />
			{:else}
				<HostForm connection={mode.connection} onSaved={backToList} onCancel={backToList} />
			{/if}
		</div>
	{/if}
</div>

<Dialog
	isOpen={pendingDelete !== null}
	onClose={() => (pendingDelete = null)}
	type="warning"
	title="Delete host"
	message="Delete “{pendingDelete?.name ?? ''}”? Its open shells and port forwards are stopped, and any database connection tunneling through it will need a new tunnel."
	confirmText="Delete"
	onConfirm={confirmDelete}
/>
