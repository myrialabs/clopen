<!--
	ssh-client — what is listening on this host.

	The same table the Ports tool shows for the local machine, scoped to the host
	the SSH Client is already on. Nothing is reimplemented here: the store, the
	scan and the rows are shared, and this only decides which host is watched and
	when to stop watching it.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import PortTable from '$frontend/components/ports/main/PortTable.svelte';
	import PortDetailLayer from '$frontend/components/ports/PortDetailLayer.svelte';
	import PortKillDialog from '$frontend/components/ports/PortKillDialog.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { portsStore } from '$frontend/stores/features/ports.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import type { PortEntry } from '$shared/types/ports';

	interface Props {
		connectionId: string;
	}

	const { connectionId }: Props = $props();

	let pendingKill = $state<PortEntry | null>(null);

	const selected = $derived(portsStore.selected);
	const result = $derived(portsStore.result);
	/** Reading is open to every member; stopping a process is not. */
	const canKill = $derived(authStore.isAdmin);

	$effect(() => {
		const hostId = connectionId;
		// `untrack` because starting a watch writes the store state it also reads
		// — tracked, that is an effect that invalidates itself, and each re-run
		// costs another round of watch/unwatch on the host.
		untrack(() => void portsStore.watch(hostId));
		// Leaving this tab — or the modal — must stop the polling behind it.
		return () => {
			void portsStore.unwatch(hostId);
		};
	});
</script>

<div class="flex flex-col flex-1 min-h-0 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
	<div class="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-slate-200 dark:border-slate-800">
		<div
			class="flex items-center gap-2 flex-1 min-w-0 px-2.5 h-8 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800"
		>
			<Icon name="lucide:search" class="w-3.5 h-3.5 shrink-0 text-slate-400" />
			<input
				type="text"
				class="flex-1 min-w-0 bg-transparent border-none outline-none text-xs text-slate-800 dark:text-slate-200 placeholder:text-slate-400"
				placeholder="Search port, process, command, directory…"
				bind:value={portsStore.search}
			/>
		</div>

		{#if result}
			<span
				class="hidden sm:flex items-center gap-1.5 shrink-0 text-[11px] text-slate-400 dark:text-slate-600"
				title="This table refreshes about once a second while the tab is open"
			>
				<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
				live
			</span>
		{/if}
	</div>

	<div class="flex flex-1 min-h-0 relative overflow-hidden">
		<div class="port-list-wrap flex-1 min-h-0 flex flex-col overflow-hidden" class:detail-open={!!selected}>
			<PortTable {canKill} onKill={(entry) => (pendingKill = entry)} />
		</div>
		{#if selected}
			<PortDetailLayer entry={selected} onClose={() => portsStore.select(null)} />
		{/if}
	</div>
</div>

<style>
	@media (min-width: 768px) {
		.port-list-wrap {
			transition: margin-right 320ms cubic-bezier(0.16, 1, 0.3, 1);
			margin-right: 0;
			will-change: margin-right;
			backface-visibility: hidden;
		}
		.port-list-wrap.detail-open {
			margin-right: 320px;
		}
	}
</style>

<PortKillDialog bind:entry={pendingKill} />
