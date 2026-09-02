<!--
	Containers — the list, split into what is running and what is not.

	Both groups are always present, so a host with nothing up still shows where
	its stopped containers would appear. The footer states how the host was read
	and what it could not answer, for the same reason the port table does: an
	empty list should never be ambiguous between "nothing is running" and "this
	host would not say".
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ContainerRow from './ContainerRow.svelte';
	import { containersStore } from '$frontend/stores/features/containers.svelte';
	import type { ContainerEntry } from '$shared/types/containers';

	interface Props {
		canManage: boolean;
		onToggle: (entry: ContainerEntry) => void;
	}

	const { canManage, onToggle }: Props = $props();

	const groups = $derived(containersStore.groups);
	const result = $derived(containersStore.result);
	const total = $derived(result?.entries.length ?? 0);
	const shown = $derived(containersStore.entries.length);
</script>

<div class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 p-3">
	{#if result?.error}
		<div class="flex items-start gap-2.5 p-3 rounded-lg bg-red-500/10 text-red-700 dark:text-red-400">
			<Icon name="lucide:circle-alert" class="w-4 h-4 shrink-0 mt-0.5" />
			<p class="m-0 text-xs">{result.error}</p>
		</div>
	{/if}

	{#each result?.limitations ?? [] as limitation (limitation.code)}
		<!-- A host with no runtime is not an error, it is an answer. It is shown
		     where the list would be, because that is the question being asked. -->
		<div
			class="flex items-start gap-2.5 p-3 rounded-lg bg-slate-100 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400"
		>
			<Icon
				name={limitation.code === 'no-runtime' ? 'lucide:info' : 'lucide:triangle-alert'}
				class="w-4 h-4 shrink-0 mt-0.5"
			/>
			<p class="m-0 text-xs">{limitation.message}</p>
		</div>
	{/each}

	{#if result?.runtime}
		{#each groups as group (group.id)}
			{@const collapsed = containersStore.isCollapsed(group.id)}
			<section class="flex flex-col gap-1.5">
				<button
					type="button"
					class="flex items-center gap-2 w-full px-1 py-1 bg-transparent border-none cursor-pointer text-left"
					onclick={() => containersStore.toggleGroup(group.id)}
				>
					<Icon
						name={collapsed ? 'lucide:chevron-right' : 'lucide:chevron-down'}
						class="w-3.5 h-3.5 shrink-0 text-slate-400"
					/>
					<span
						class="text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400"
					>
						{group.title}
					</span>
					<span class="text-[11px] text-slate-400 dark:text-slate-600">{group.entries.length}</span>
					<span class="hidden sm:block flex-1 text-[11px] text-slate-400 dark:text-slate-600 truncate">
						{group.blurb}
					</span>
				</button>

				{#if !collapsed}
					{#if group.entries.length === 0}
						<p class="m-0 px-3 py-2 text-xs text-slate-400 dark:text-slate-600">
							Nothing here right now.
						</p>
					{:else}
						<div class="flex flex-col gap-1">
							{#each group.entries as entry (entry.key)}
								<ContainerRow
									{entry}
									{canManage}
									selected={containersStore.selectedId === entry.id}
									busy={containersStore.actingId === entry.id}
									onSelect={() => containersStore.select(entry.id)}
									onToggle={() => onToggle(entry)}
									onLogs={() => void containersStore.startLogs(entry)}
								/>
							{/each}
						</div>
					{/if}
				{/if}
			</section>
		{/each}

		{#if total > 0 && shown === 0}
			<p class="m-0 px-3 py-6 text-center text-xs text-slate-500 dark:text-slate-500">
				No container matches that search.
			</p>
		{/if}

		<section class="flex flex-col gap-1.5 mt-2 p-3 rounded-lg bg-slate-100 dark:bg-slate-900/60">
			<h4 class="m-0 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
				How this host was read
			</h4>
			<p class="m-0 text-xs text-slate-500 dark:text-slate-500">
				{result.runtime}{result.runtimeVersion ? ` ${result.runtimeVersion}` : ''} · detected, not
				configured
			</p>
		</section>
	{/if}
</div>
