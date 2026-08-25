<!--
	SSH Client — saved hosts in the sidebar, and per host a remote shell, an SFTP
	file browser, port forwarding, and the host's connection/key overview.

	Laid out like the DB Client modal so the two read as one family: sidebar list
	on the left, a view switcher and the active view on the right, and the sidebar
	sliding over the content on mobile.
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import HostList from './sidebar/HostList.svelte';
	import TerminalPane from './main/TerminalPane.svelte';
	import FileBrowser from './main/FileBrowser.svelte';
	import ForwardsPanel from './main/ForwardsPanel.svelte';
	import HostOverview from './main/HostOverview.svelte';
	import { sshClientStore, type SshView } from '$frontend/stores/features/ssh-client.svelte';
	import { debug } from '$shared/utils/logger';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(), onClose }: Props = $props();

	let isMobileMenuOpen = $state(false);
	let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
	/**
	 * Heavy panes (xterm, Monaco) mount only after the open transition has
	 * finished — building them in the same flush makes the modal jump into place
	 * instead of scaling in.
	 */
	let contentReady = $state(false);

	const isMobile = $derived(windowWidth < 768);
	const activeConnection = $derived(sshClientStore.activeConnection);
	const view = $derived(activeConnection ? sshClientStore.getView(activeConnection.id) : null);
	const activeView = $derived(view?.activeView ?? 'terminal');
	const connected = $derived(sshClientStore.isConnected(activeConnection?.id));
	const health = $derived(activeConnection ? sshClientStore.health[activeConnection.id] : null);
	// Terminal and Files need a live transport; Forwards and Host are settings
	// pages and stay readable while the host is disconnected.
	const viewNeedsConnection = $derived(activeView === 'terminal' || activeView === 'files');

	let connecting = $state(false);

	async function connectActive(): Promise<void> {
		if (!activeConnection) return;
		connecting = true;
		try {
			await sshClientStore.activate(activeConnection.id);
		} catch (error) {
			debug.warn('ssh', 'Could not connect:', error);
		} finally {
			connecting = false;
		}
	}

	const VIEWS: Array<{ id: SshView; label: string; icon: IconName }> = [
		{ id: 'terminal', label: 'Terminal', icon: 'lucide:terminal' },
		{ id: 'files', label: 'Files', icon: 'lucide:folder' },
		{ id: 'forwards', label: 'Forwards', icon: 'lucide:arrow-left-right' },
		{ id: 'overview', label: 'Host', icon: 'lucide:info' }
	];

	function handleResize(): void {
		windowWidth = window.innerWidth;
	}

	$effect(() => {
		if (!isOpen) {
			contentReady = false;
			return;
		}
		sshClientStore.list().catch((error) => {
			debug.error('ssh', 'Could not load SSH hosts:', error);
		});
		sshClientStore.loadKnownHosts().catch(() => {
			// Not fatal — the overview simply shows no recorded key.
		});
	});

	function onHostPicked(): void {
		isMobileMenuOpen = false;
	}
</script>

<svelte:window on:resize={handleResize} />

<Modal
	bind:isOpen
	{onClose}
	bare
	mobileFullscreen
	onOpened={() => (contentReady = true)}
	ariaLabelledBy="ssh-client-title"
	className="flex flex-col w-full max-w-[90vw] h-[85dvh] max-h-[900px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]"
>
	{#snippet children()}
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
					<Icon name={isMobileMenuOpen ? 'lucide:arrow-left' : 'lucide:menu'} class="w-5 h-5" />
				</button>
				<h2
					id="ssh-client-title"
					class="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100 m-0"
				>
					SSH Client
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
			<aside
				class="flex flex-col w-72 shrink-0 bg-white dark:bg-slate-900/98 border-r border-slate-200 dark:border-slate-800
					{isMobile
					? 'absolute left-0 top-0 bottom-0 z-30 w-80 bg-white dark:bg-slate-900 shadow-[4px_0_20px_rgba(0,0,0,0.15)] dark:shadow-[4px_0_20px_rgba(0,0,0,0.3)] transition-transform duration-250 ease-out'
					: ''}
					{isMobile && !isMobileMenuOpen ? '-translate-x-full' : 'translate-x-0'}"
			>
				{#if !isMobile}
					<header
						class="flex items-center justify-between py-1.5 px-4 pl-6 border-b border-slate-200 dark:border-slate-800 shrink-0"
					>
						<div
							class="flex items-center gap-2.5 text-md font-bold text-slate-900 dark:text-slate-100"
						>
							<span id="ssh-client-title">SSH Client</span>
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

				<div class="flex flex-col min-h-0 flex-1">
					<HostList onSelect={onHostPicked} />
				</div>
			</aside>

			{#if isMobile && isMobileMenuOpen}
				<button
					type="button"
					class="absolute inset-0 z-[25] bg-black/40 border-none p-0 cursor-default"
					onclick={() => (isMobileMenuOpen = false)}
					aria-label="Close menu"
				></button>
			{/if}

			<!-- @container: the panes inside size themselves against this area, which
			     is the viewport minus the sidebar rather than the viewport. -->
			<main
				class="@container flex-1 flex flex-col min-w-0 overflow-hidden bg-slate-50 dark:bg-slate-950"
			>
				{#if activeConnection}
					<div class="flex-1 min-h-0 p-3 flex flex-col gap-2">
						<!-- View switcher -->
						<div
							class="flex items-center gap-1 shrink-0 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-1 min-w-0 overflow-x-auto no-scrollbar"
						>
							{#each VIEWS as entry (entry.id)}
								<button
									type="button"
									title={entry.label}
									class="flex items-center gap-1.5 px-2.5 sm:px-3 h-7 rounded-md text-xs font-semibold transition-colors cursor-pointer shrink-0
										{activeView === entry.id
										? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
										: 'text-slate-500 dark:text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:text-slate-100 dark:hover:bg-slate-800'}"
									onclick={() => sshClientStore.setView(activeConnection.id, entry.id)}
								>
									<Icon name={entry.icon} class="w-3.5 h-3.5" />
									<span class="hidden @lg:inline">{entry.label}</span>
								</button>
							{/each}

							<div class="flex-1"></div>

							<div class="hidden @2xl:flex items-center gap-1.5 px-2 shrink-0 min-w-0">
								<span
									class="w-1.5 h-1.5 rounded-full shrink-0 {connected
										? 'bg-emerald-500'
										: health?.hostKeyChanged
											? 'bg-amber-500'
											: health && !health.suspended
												? 'bg-red-500'
												: 'bg-slate-400'}"
								></span>
								<span class="text-xs text-slate-400 dark:text-slate-500 font-mono truncate">
									{activeConnection.username}@{activeConnection.host}
								</span>
							</div>
						</div>

						<!-- Active view. Keyed on the connection so switching hosts tears the
						     pane down rather than reusing it against the wrong host. -->
						<div
							class="flex-1 min-h-0 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden flex flex-col"
						>
							{#if !contentReady}
								<div class="flex-1 flex items-center justify-center text-xs text-slate-500">
									Loading…
								</div>
							{:else if viewNeedsConnection && !connected}
								<!-- Disconnect has to mean something: the panes that need the
								     transport stay closed until the host is opened again. -->
								<div class="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
									<Icon name="lucide:unplug" class="w-10 h-10 text-slate-300 dark:text-slate-600" />
									<p class="text-sm text-slate-600 dark:text-slate-300 m-0">
										{health?.suspended
											? 'This host is disconnected.'
											: health?.error
												? 'Could not connect to this host.'
												: 'Not connected to this host yet.'}
									</p>
									{#if health?.error}
										<p
											class="max-w-lg text-xs text-red-600 dark:text-red-400 m-0 whitespace-pre-wrap wrap-anywhere"
										>
											{health.error}
										</p>
									{/if}
									<button
										type="button"
										class="flex items-center gap-2 px-3.5 py-2 text-sm rounded-md bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50"
										onclick={connectActive}
										disabled={connecting}
									>
										<Icon name="lucide:plug" class="w-4 h-4" />
										{connecting ? 'Connecting…' : 'Connect'}
									</button>
									{#if health?.hostKeyChanged}
										<button
											type="button"
											class="text-xs text-violet-600 dark:text-violet-400 underline"
											onclick={() => sshClientStore.setView(activeConnection.id, 'overview')}
										>
											Review the host key
										</button>
									{/if}
								</div>
							{:else}
								{#key activeConnection.id}
									{#if activeView === 'terminal'}
										<TerminalPane connectionId={activeConnection.id} />
									{:else if activeView === 'files'}
										<FileBrowser connectionId={activeConnection.id} />
									{:else if activeView === 'forwards'}
										<ForwardsPanel connectionId={activeConnection.id} />
									{:else}
										<HostOverview connection={activeConnection} />
									{/if}
								{/key}
							{/if}
						</div>
					</div>
				{:else}
					<div class="flex-1 flex flex-col items-center justify-center gap-3 text-slate-500 p-6">
						<Icon name="lucide:server" class="w-10 h-10 opacity-30" />
						<p class="text-sm m-0">Select a host to open a shell, browse its files, or forward a port.</p>
						{#if isMobile}
							<button
								type="button"
								class="text-xs text-violet-600 hover:text-violet-700 dark:text-violet-400 underline"
								onclick={() => (isMobileMenuOpen = true)}
							>
								Show hosts
							</button>
						{/if}
					</div>
				{/if}
			</main>
		</div>
	{/snippet}
</Modal>
