<!--
	Containers — what is running on this machine.

	Scoped to the machine Clopen runs on. A saved SSH host's containers live in
	the SSH Client, on the host they belong to, rather than behind a second host
	picker here — one place per machine, no ambiguity about which is canonical.
	The implementation underneath is shared: the same store, the same listing and
	the same pane serve both.
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import ContainersPane from './ContainersPane.svelte';
	import { LOCAL_CONTAINER_HOST } from '$shared/types/containers';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(), onClose }: Props = $props();

	/**
	 * The pane mounts only after the open transition has finished. It starts a
	 * watch and can mount an xterm, and doing either in the same flush makes the
	 * modal jump into place instead of scaling in.
	 */
	let contentReady = $state(false);

	$effect(() => {
		if (!isOpen) contentReady = false;
	});
</script>

<Modal
	bind:isOpen
	{onClose}
	bare
	mobileFullscreen
	onOpened={() => (contentReady = true)}
	ariaLabelledBy="containers-title"
	className="flex flex-col w-full max-w-5xl h-[85dvh] max-h-[900px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]"
>
	{#snippet children()}
		<header
			class="flex items-center justify-between gap-3 px-4 py-2.5 shrink-0 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
		>
			<div class="flex items-center gap-2.5 min-w-0">
				<Icon name="lucide:container" class="w-4 h-4 shrink-0 text-blue-600 dark:text-blue-400" />
				<span id="containers-title" class="text-md font-bold text-slate-900 dark:text-slate-100">
					Containers
				</span>
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

		{#if contentReady}
			<ContainersPane hostId={LOCAL_CONTAINER_HOST} />
		{:else}
			<div class="flex-1 flex items-center justify-center">
				<Icon name="lucide:loader-circle" class="w-5 h-5 animate-spin text-slate-400" />
			</div>
		{/if}
	{/snippet}
</Modal>
