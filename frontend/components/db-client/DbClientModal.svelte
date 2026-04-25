<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import ConnectionList from './sidebar/ConnectionList.svelte';
	import DriverIcon from './shared/DriverIcon.svelte';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';
	import { debug } from '$shared/utils/logger';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(), onClose }: Props = $props();

	let isMobileMenuOpen = $state(false);
	let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);

	const isMobile = $derived(windowWidth < 768);
	const activeConnection = $derived(dbClientStore.activeConnection);

	$effect(() => {
		if (isOpen) {
			dbClientStore.list().catch((err) => {
				debug.error('db-client', 'failed to load connections on modal open:', err);
			});
		}
	});

	function handleResize(): void {
		windowWidth = window.innerWidth;
		if (!isMobile) isMobileMenuOpen = false;
	}

	function onConnectionPicked(): void {
		if (isMobile) isMobileMenuOpen = false;
	}
</script>

<svelte:window on:resize={handleResize} />

<Modal
	bind:isOpen
	{onClose}
	bare
	mobileFullscreen
	ariaLabelledBy="db-client-title"
	className="flex flex-col w-full max-w-[90vw] h-[85dvh] max-h-[900px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]"
>
	{#snippet children()}
		<!-- Mobile header -->
		{#if isMobile}
			<header
				class="flex items-center justify-between py-3 px-4 bg-slate-100 dark:bg-slate-900/95 border-b border-slate-200 dark:border-slate-800"
			>
				<button
					type="button"
					class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={() => (isMobileMenuOpen = !isMobileMenuOpen)}
					aria-label="Toggle menu"
				>
					<Icon
						name={isMobileMenuOpen ? 'lucide:arrow-left' : 'lucide:menu'}
						class="w-5 h-5"
					/>
				</button>
				<h2
					id="db-client-title"
					class="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100 m-0"
				>
					DB Client
				</h2>
				<button
					type="button"
					class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={onClose}
					aria-label="Close"
				>
					<Icon name="lucide:x" class="w-5 h-5" />
				</button>
			</header>
		{/if}

		<div class="flex flex-1 min-h-0 relative">
			<!-- Sidebar -->
			<aside
				class="flex flex-col w-72 shrink-0 bg-white dark:bg-slate-900/98 border-r border-slate-200 dark:border-slate-800
					{isMobile
					? 'absolute left-0 top-0 bottom-0 z-10 w-80 shadow-[4px_0_20px_rgba(0,0,0,0.15)] dark:shadow-[4px_0_20px_rgba(0,0,0,0.3)] transition-transform duration-250 ease-out'
					: ''}
					{isMobile && !isMobileMenuOpen ? '-translate-x-full' : 'translate-x-0'}"
			>
				{#if !isMobile}
					<header
						class="flex items-center justify-between py-3 px-4 pl-6 border-b border-slate-200 dark:border-slate-800 shrink-0"
					>
						<div
							class="flex items-center gap-2.5 text-lg font-bold text-slate-900 dark:text-slate-100"
						>
							<span>DB Client</span>
						</div>
						<button
							type="button"
							class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
							onclick={onClose}
							aria-label="Close"
						>
							<Icon name="lucide:x" class="w-5 h-5" />
						</button>
					</header>
				{/if}

				<div class="flex-1 min-h-0">
					<ConnectionList onSelect={onConnectionPicked} />
				</div>
			</aside>

			<!-- Mobile menu overlay -->
			{#if isMobile && isMobileMenuOpen}
				<button
					type="button"
					class="absolute inset-0 z-[5] bg-black/40 border-none p-0 cursor-default"
					onclick={() => (isMobileMenuOpen = false)}
					aria-label="Close menu"
				></button>
			{/if}

			<!-- Right pane: workspace placeholder -->
			<main class="flex-1 flex flex-col min-w-0 overflow-hidden">
				{#if activeConnection}
					<div
						class="flex items-center gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/98 shrink-0"
					>
						<DriverIcon driver={activeConnection.driver} class="w-5 h-5" />
						<div class="flex-1 min-w-0">
							<div
								class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate"
							>
								{activeConnection.name}
							</div>
							<div class="text-xs text-slate-500 dark:text-slate-400 truncate">
								{activeConnection.driver}
								{#if activeConnection.host}
									• {activeConnection.host}{activeConnection.port
										? `:${activeConnection.port}`
										: ''}
								{/if}
								{#if activeConnection.database}
									• {activeConnection.database}
								{/if}
							</div>
						</div>
					</div>

					<div
						class="flex-1 flex items-center justify-center text-slate-400 dark:text-slate-600"
					>
						<div class="flex flex-col items-center gap-3 text-center px-6">
							<Icon name="lucide:hammer" class="w-10 h-10 opacity-40" />
							<div class="text-sm font-medium text-slate-500 dark:text-slate-400">
								Schema, query, and data tools land in Phase 2.
							</div>
							<div class="text-xs text-slate-400 dark:text-slate-500 max-w-xs">
								Phase 1 ships connection management — pick a connection and use Test to
								verify it reaches the server.
							</div>
						</div>
					</div>
				{:else}
					<div
						class="flex-1 flex items-center justify-center text-slate-400 dark:text-slate-600"
					>
						<div class="flex flex-col items-center gap-3 text-center px-6">
							<Icon name="lucide:mouse-pointer-click" class="w-10 h-10 opacity-40" />
							<div class="text-sm font-medium text-slate-500 dark:text-slate-400">
								Select a connection to begin
							</div>
							<div class="text-xs text-slate-400 dark:text-slate-500 max-w-xs">
								Use the sidebar to add or pick a connection. Phase 2 will fill this pane
								with schema, query, and data tools.
							</div>
						</div>
					</div>
				{/if}
			</main>
		</div>
	{/snippet}
</Modal>
