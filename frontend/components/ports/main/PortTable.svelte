<!--
	Port manager — the table, grouped by where each port came from.

	Grouping is the whole argument of this panel: the ports Clopen is
	responsible for, the ones it started, and the ones it merely found. The
	groups are always all present, so a machine with nothing running still shows
	that the third group is where unexplained ports would appear.
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import PortRow from './PortRow.svelte';
	import { portsStore } from '$frontend/stores/features/ports.svelte';
	import type { PortEntry } from '$shared/types/ports';

	interface Props {
		canKill: boolean;
		onKill: (entry: PortEntry) => void;
	}

	const { canKill, onKill }: Props = $props();

	const groups = $derived(portsStore.groups);
	const result = $derived(portsStore.result);
	const total = $derived(result?.entries.length ?? 0);
	const shown = $derived(portsStore.entries.length);

	const hasDetail = $derived(portsStore.selected !== null);
	// tanpa gap: saat detail terbuka, padding kanan di-nol-kan supaya
	// list menempel langsung ke border-l detail (w-[320px] == margin 320px).
	// p-3 = 0.75rem (12px di 16px), jadi pad 0.75rem ↔ 0 sinkron dengan
	// margin-right dan fly 240ms. Mobile tetap 0.75rem via !important di bawah.
	const padRight = $derived(hasDetail ? '0px' : '0.75rem');
</script>

<div
	class="port-table flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 p-3"
	style:padding-right={padRight}
	style:transition="padding-right 320ms cubic-bezier(0.16, 1, 0.3, 1)"
	style:will-change="padding-right"
	style:backface-visibility="hidden"
>
	{#if result?.error}
		<div
			class="flex items-start gap-2.5 p-3 rounded-lg bg-red-500/10 text-red-700 dark:text-red-400"
		>
			<Icon name="lucide:circle-alert" class="w-4 h-4 shrink-0 mt-0.5" />
			<p class="m-0 text-xs">{result.error}</p>
		</div>
	{/if}

	{#each groups as group (group.kind)}
		{@const collapsed = portsStore.isCollapsed(group.kind)}
		<section class="flex flex-col gap-1.5">
			<button
				type="button"
				class="flex items-center gap-2 w-full px-1 py-1 bg-transparent border-none cursor-pointer text-left"
				onclick={() => portsStore.toggleGroup(group.kind)}
			>
				<Icon
					name={collapsed ? 'lucide:chevron-right' : 'lucide:chevron-down'}
					class="w-3.5 h-3.5 shrink-0 text-slate-400"
				/>
				<span class="text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">
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
							<PortRow
								{entry}
								{canKill}
								selected={portsStore.selectedKey === entry.key}
								killing={portsStore.killingKey === entry.key}
								onSelect={() => portsStore.select(entry.key)}
								onKill={() => onKill(entry)}
							/>
						{/each}
					</div>
				{/if}
			{/if}
		</section>
	{/each}

	{#if total > 0 && shown === 0}
		<p class="m-0 px-3 py-6 text-center text-xs text-slate-500 dark:text-slate-500">
			No port matches that search.
		</p>
	{/if}

	{#if result && !result.error}
		<!-- Stated plainly rather than hidden: a row with no owner is this host
		     refusing to say, not Clopen failing to look. The probe is named
		     because how much a row can carry depends entirely on which one ran. -->
		<section class="flex flex-col gap-1.5 mt-2 p-3 rounded-lg bg-slate-100 dark:bg-slate-900/60">
			<h4 class="m-0 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
				How this host was read
			</h4>
			<p class="m-0 text-xs text-slate-500 dark:text-slate-500">
				{result.platform} · read with <code class="font-mono">{result.probe}</code>
			</p>
			{#each result.limitations as limitation (limitation.code)}
				<p class="m-0 text-xs text-slate-500 dark:text-slate-500">{limitation.message}</p>
			{/each}
		</section>
	{/if}
</div>

<style>
	/* Mobile: detail adalah bottom-sheet, jangan hilangkan padding kanan */
	@media (max-width: 767px) {
		.port-table {
			padding-right: 0.75rem !important;
		}
	}
</style>
