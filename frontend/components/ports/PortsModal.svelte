<!--
	Ports — what is listening on this machine, where it came from, how to stop it.

	Scoped to the machine Clopen runs on. A saved SSH host's ports live in the
	SSH Client, on the host they belong to, rather than behind a second host
	picker here — one place per machine, no ambiguity about which is canonical.
	The implementation underneath is shared: the same store, the same scan and
	the same table serve both.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import PortTable from './main/PortTable.svelte';
	import PortDetailLayer from './PortDetailLayer.svelte';
	import PortKillDialog from './PortKillDialog.svelte';
	import { portsStore } from '$frontend/stores/features/ports.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { LOCAL_PORT_HOST, type PortEntry } from '$shared/types/ports';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(), onClose }: Props = $props();

	let pendingKill = $state<PortEntry | null>(null);

	const result = $derived(portsStore.result);
	const selected = $derived(portsStore.selected);
	/** Reading is open to every member; stopping a process is not. */
	const canKill = $derived(authStore.isAdmin);

	$effect(() => {
		if (!isOpen) return;
		// `untrack` because starting a watch writes the store state it also reads
		// — tracked, that is an effect that invalidates itself.
		untrack(() => void portsStore.watch(LOCAL_PORT_HOST));
		// Closing the panel must stop the polling behind it, not just hide it.
		return () => {
			void portsStore.unwatch(LOCAL_PORT_HOST);
		};
	});
</script>

<Modal
	bind:isOpen
	{onClose}
	bare
	mobileFullscreen
	ariaLabelledBy="ports-title"
	className="flex flex-col w-full max-w-4xl h-[85dvh] max-h-[900px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]"
>
	{#snippet children()}
		<header
			class="flex items-center justify-between gap-3 px-4 py-2.5 shrink-0 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
		>
			<div class="flex items-center gap-2.5 min-w-0">
				<Icon name="lucide:cable" class="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
				<span id="ports-title" class="text-md font-bold text-slate-900 dark:text-slate-100">Ports</span>
				<span class="hidden sm:block text-xs text-slate-500 dark:text-slate-500 truncate">
					on this machine
				</span>
			</div>
			<button
				type="button"
				class="flex items-center justify-center w-9 h-9 shrink-0 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10"
				onclick={onClose}
				aria-label="Close"
			>
				<Icon name="lucide:x" class="w-5 h-5" />
			</button>
		</header>

		<div class="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-slate-200 dark:border-slate-800">
			<div
				class="flex items-center gap-2 flex-1 min-w-0 px-2.5 h-8 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"
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
					title="This table refreshes about once a second while the panel is open"
				>
					<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
					live
				</span>
			{/if}
		</div>

		{#if portsStore.isLoading && !result}
			<div class="flex-1 flex items-center justify-center">
				<Icon name="lucide:loader-circle" class="w-5 h-5 animate-spin text-slate-400" />
			</div>
		{:else}
			<div class="flex flex-1 min-h-0 relative bg-slate-50 dark:bg-slate-950 overflow-hidden">
				<div class="port-list-wrap flex-1 min-h-0 flex flex-col overflow-hidden" class:detail-open={!!selected}>
					<PortTable {canKill} onKill={(entry) => (pendingKill = entry)} />
				</div>
				{#if selected}
					<PortDetailLayer entry={selected} onClose={() => portsStore.select(null)} />
				{/if}
			</div>
		{/if}
	{/snippet}
</Modal>

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
