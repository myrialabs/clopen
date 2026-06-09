<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import Icon from '../../common/display/Icon.svelte';
	import Dialog from '../../common/overlay/Dialog.svelte';
	import TunnelQRCode from '../../tunnel/TunnelQRCode.svelte';
	import { tunnelConfigStore, type RemoteConfigItem, type LocalConfigItem } from '$frontend/stores/features/tunnel-config.svelte';
	import { tunnelStore } from '$frontend/stores/features/tunnel.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { debug } from '$shared/utils/logger';
	import ws from '$frontend/utils/ws';

	// --- Remote state ---
	let remoteName = $state('');
	let remoteToken = $state('');
	let showRemoteToken = $state(false);
	let showRemoteAddForm = $state(false);
	let remoteRemoveTargetId = $state<string | null>(null);
	let removingRemoteId = $state<string | null>(null);

	// --- Local state ---
	let localName = $state('');
	let showLocalCreateForm = $state(false);
	let localDeleteTargetId = $state<string | null>(null);
	let deletingLocalId = $state<string | null>(null);

	// Local auth
	type LoginStep = 'idle' | 'loading' | 'waiting-url' | 'zone-prompt' | 'success' | 'error';
	let loginStep = $state<LoginStep>('idle');
	let loginUrl = $state<string | null>(null);
	let loginError = $state<string | null>(null);
	let loginUrlCopied = $state(false);
	let isAuthenticated = $state(false);
	let authorizedZone = $state<string | null>(null);
	let zoneInput = $state('');

	// Copy & QR
	let copiedUrl = $state<string | null>(null);
	let qrUrl = $state('');

	// Local domain add
	let domainConfigId = $state<string | null>(null);
	let domainSubdomain = $state('');
	let domainService = $state('');
	let isAddingDomain = $state(false);

	// Derived
	const remotes = $derived(tunnelConfigStore.remotes);
	const locals = $derived(tunnelConfigStore.locals);
	const isSaving = $derived(tunnelConfigStore.isSaving);
	const storeError = $derived(tunnelConfigStore.error);

	// Event listener cleanup
	const cleanups: Array<() => void> = [];

	/** Sync isActive flags on config store based on actual tunnel status from backend */
	async function syncActiveStates() {
		try {
			await tunnelStore.checkStatus();
			const activeTunnels = tunnelStore.tunnels;

			// Sync remote active states
			for (const remote of tunnelConfigStore.remotes) {
				const isRunning = activeTunnels.some((t) => t.id === remote.id && t.type === 'remote');
				tunnelConfigStore.setRemoteActive(remote.id, isRunning);
			}

			// Sync local active states
			for (const local of tunnelConfigStore.locals) {
				const isRunning = activeTunnels.some((t) => t.id === local.id && t.type === 'local');
				tunnelConfigStore.setLocalActive(local.id, isRunning);
			}
		} catch {
			// Status check failed
		}
	}

	/** Live edge-connection count for a configured tunnel; > 0 means it is publicly reachable. */
	function tunnelConnections(id: string, type: 'remote' | 'local'): number {
		return tunnelStore.tunnels.find((t) => t.id === id && t.type === type)?.connections ?? 0;
	}

	onMount(async () => {
		// Listen for login events
		cleanups.push(
			ws.on('tunnel:local:login-url', (data: { url: string }) => {
				loginUrl = data.url;
				loginStep = 'waiting-url';
			}),
			ws.on('tunnel:local:login-complete', () => {
				loginStep = 'zone-prompt';
				isAuthenticated = true;
			}),
			ws.on('tunnel:local:login-error', (data: { message: string }) => {
				loginError = data.message;
				loginStep = 'error';
			}),
			ws.on('tunnel:remote:ingress-update', (data: { id: string; ingress: Array<{ hostname?: string; service: string }> }) => {
				tunnelConfigStore.updateRemoteIngress(data.id, data.ingress);
			}),
			ws.on('tunnel:status-changed', (_data: { tunnels: Array<{ id?: string; type: string }> }) => {
				// Re-sync active states when tunnel status changes
				syncActiveStates();
			})
		);

		// Load configs and check auth
		await tunnelConfigStore.refresh();
		try {
			const authResult = await tunnelStore.checkAuth();
			isAuthenticated = authResult.authenticated;
			authorizedZone = authResult.zone;
		} catch {
			// Auth check failed
		}

		// Sync active states with actual backend status
		await syncActiveStates();
	});

	onDestroy(() => {
		for (const cleanup of cleanups) cleanup();
		cleanups.length = 0;

		if (loginStep === 'loading' || loginStep === 'waiting-url') {
			tunnelStore.cancelLogin();
		}
	});

	// --- Remote handlers ---

	/** Extract JWT token from various cloudflared command formats */
	function extractToken(raw: string): string {
		const match = raw.trim().match(/eyJ[\w-]+(?:\.[\w-]+)*/);
		return match ? match[0] : raw.trim();
	}

	async function handleAddRemote() {
		const token = extractToken(remoteToken);
		if (!remoteName.trim() || !token) return;
		try {
			await tunnelConfigStore.addRemote(remoteName.trim(), token);
			remoteName = '';
			remoteToken = '';
			showRemoteToken = false;
			showRemoteAddForm = false;
			addNotification({ type: 'success', title: 'Added', message: 'Remote tunnel config added' });
		} catch {
			// Error handled by store
		}
	}

	async function handleRemoveRemote() {
		if (!remoteRemoveTargetId) return;
		const id = remoteRemoveTargetId;
		remoteRemoveTargetId = null;
		removingRemoteId = id;
		try {
			await tunnelConfigStore.removeRemote(id);
			addNotification({ type: 'success', title: 'Removed', message: 'Remote tunnel config removed' });
		} catch {
			// Error handled by store
		}
		removingRemoteId = null;
	}

	async function handleStartRemote(config: RemoteConfigItem) {
		try {
			await tunnelStore.startRemoteTunnel(config.id);
			tunnelConfigStore.setRemoteActive(config.id, true);
			addNotification({ type: 'success', title: 'Started', message: `Remote tunnel "${config.name}" started` });
		} catch (error) {
			tunnelConfigStore.setRemoteActive(config.id, false);
			const msg = error instanceof Error ? error.message : 'Failed to start';
			addNotification({ type: 'error', title: 'Error', message: msg });
		}
	}

	async function handleStopRemote(config: RemoteConfigItem) {
		try {
			await tunnelStore.stopRemoteTunnel(config.id);
			tunnelConfigStore.setRemoteActive(config.id, false);
			addNotification({ type: 'success', title: 'Stopped', message: `Remote tunnel "${config.name}" stopped` });
		} catch (error) {
			const msg = error instanceof Error ? error.message : 'Failed to stop';
			addNotification({ type: 'error', title: 'Error', message: msg });
		}
	}

	// --- Local auth handlers ---

	function startLogin() {
		loginStep = 'loading';
		loginUrl = null;
		loginError = null;
		tunnelStore.startLogin();
	}

	function cancelLogin() {
		tunnelStore.cancelLogin();
		loginStep = 'idle';
		loginUrl = null;
	}

	async function copyLoginUrl() {
		if (!loginUrl) return;
		try {
			await navigator.clipboard.writeText(loginUrl);
			loginUrlCopied = true;
			setTimeout(() => { loginUrlCopied = false; }, 2000);
		} catch {
			// Silently fail
		}
	}

	async function handleSetZone() {
		if (!zoneInput.trim()) return;
		try {
			await tunnelStore.setZone(zoneInput.trim());
			authorizedZone = zoneInput.trim();
			zoneInput = '';
			loginStep = 'idle';
			addNotification({ type: 'success', title: 'Authenticated', message: `Cloudflare login successful for ${authorizedZone}` });
		} catch {
			addNotification({ type: 'error', title: 'Error', message: 'Failed to save zone' });
		}
	}

	async function handleLogout() {
		try {
			await tunnelStore.logout();
			isAuthenticated = false;
			authorizedZone = null;
			loginStep = 'idle';
			addNotification({ type: 'info', title: 'Logged out', message: 'Cloudflare credentials removed' });
		} catch {
			addNotification({ type: 'error', title: 'Error', message: 'Failed to logout' });
		}
	}

	// --- Local tunnel handlers ---

	async function handleCreateLocal() {
		if (!localName.trim()) return;
		try {
			await tunnelConfigStore.createLocal(localName.trim());
			localName = '';
			showLocalCreateForm = false;
			addNotification({ type: 'success', title: 'Created', message: 'Local tunnel created' });
		} catch {
			// Error handled by store
		}
	}

	async function handleDeleteLocal() {
		if (!localDeleteTargetId) return;
		const id = localDeleteTargetId;
		localDeleteTargetId = null;
		deletingLocalId = id;
		try {
			await tunnelConfigStore.deleteLocal(id);
			addNotification({ type: 'success', title: 'Deleted', message: 'Local tunnel deleted' });
		} catch {
			// Error handled by store
		}
		deletingLocalId = null;
	}

	async function handleStartLocal(config: LocalConfigItem) {
		try {
			await tunnelStore.startLocalTunnel(config.id);
			tunnelConfigStore.setLocalActive(config.id, true);
			addNotification({ type: 'success', title: 'Started', message: `Local tunnel "${config.name}" started` });
		} catch (error) {
			tunnelConfigStore.setLocalActive(config.id, false);
			const msg = error instanceof Error ? error.message : 'Failed to start';
			addNotification({ type: 'error', title: 'Error', message: msg });
		}
	}

	async function handleStopLocal(config: LocalConfigItem) {
		try {
			await tunnelStore.stopLocalTunnel(config.id);
			tunnelConfigStore.setLocalActive(config.id, false);
			addNotification({ type: 'success', title: 'Stopped', message: `Local tunnel "${config.name}" stopped` });
		} catch (error) {
			const msg = error instanceof Error ? error.message : 'Failed to stop';
			addNotification({ type: 'error', title: 'Error', message: msg });
		}
	}

	async function handleAddDomain(configId: string) {
		if (!domainSubdomain.trim() || !domainService.trim() || !authorizedZone) return;
		const hostname = `${domainSubdomain.trim()}.${authorizedZone}`;
		isAddingDomain = true;
		try {
			const result = await tunnelConfigStore.addIngress(configId, hostname, domainService.trim());
			domainSubdomain = '';
			domainService = '';
			domainConfigId = null;
			if (result.dnsRouted) {
				addNotification({ type: 'success', title: 'Added', message: `Subdomain ${hostname} added and DNS routed` });
			} else if (result.dnsError) {
				addNotification({ type: 'warning', title: 'Added', message: `Subdomain ${hostname} added, but DNS routing failed: ${result.dnsError}` });
			} else {
				addNotification({ type: 'success', title: 'Added', message: `Subdomain ${hostname} added` });
			}
		} catch {
			// Error handled by store
		}
		isAddingDomain = false;
	}

	async function handleRemoveDomain(configId: string, hostname: string) {
		try {
			await tunnelConfigStore.removeIngress(configId, hostname);
		} catch {
			// Error handled by store
		}
	}

	async function copyUrl(url: string) {
		try {
			await navigator.clipboard.writeText(url);
			copiedUrl = url;
			addNotification({ type: 'success', title: 'Copied', message: 'URL copied to clipboard' });
			setTimeout(() => { copiedUrl = null; }, 2000);
		} catch (error) {
			debug.error('tunnel', 'Failed to copy:', error);
			addNotification({ type: 'error', title: 'Error', message: 'Failed to copy URL' });
		}
	}

	function getRemoteLoadingState(configId: string) {
		return tunnelStore.getLoadingState(configId);
	}

	function getLocalLoadingState(configId: string) {
		return tunnelStore.getLoadingState(configId);
	}
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Tunnel</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">Cloudflare tunnel services for persistent domains</p>

	<div class="space-y-6">
		<!-- ========== REMOTELY-MANAGED ========== -->
		<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700/50">
				<div class="flex items-center gap-3">
					<div class="flex items-center justify-center w-9 h-9 rounded-lg bg-orange-500/10 dark:bg-orange-500/15">
						<Icon name="lucide:cloud" class="w-5 h-5 text-orange-600 dark:text-orange-400" />
					</div>
					<div>
						<h4 class="font-semibold text-slate-900 dark:text-slate-100">Remotely-Managed</h4>
						<p class="text-xs text-slate-500 dark:text-slate-400">Tunnels configured via Cloudflare Dashboard</p>
					</div>
				</div>

				<div class="flex items-center gap-2">
					{#if remotes.length > 0}
						<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400">
							{remotes.length} configured
						</span>
					{/if}
					<a
						href="https://dash.cloudflare.com/?to=/:account/tunnels"
						target="_blank"
						rel="noopener noreferrer"
						class="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-slate-500 dark:text-slate-400 hover:text-orange-600 dark:hover:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20 transition-colors"
						title="Open Cloudflare Dashboard"
					>
						<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
						Dashboard
					</a>
				</div>
			</div>

			<!-- Body -->
			<div class="px-5 py-4 space-y-4">
				<!-- Existing remote configs -->
				{#if remotes.length > 0}
					<div class="space-y-2">
						{#each remotes as config (config.id)}
							{@const loadState = getRemoteLoadingState(config.id)}
							{@const remoteConns = tunnelConnections(config.id, 'remote')}
							<div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/50">
								<div class="flex items-center justify-between gap-3">
									<div class="flex items-center gap-2.5 min-w-0">
										<span
											class="relative flex w-2 h-2 shrink-0"
											title={!config.isActive
												? 'Inactive'
												: remoteConns > 0
													? `Public · ${remoteConns} edge connection${remoteConns > 1 ? 's' : ''}`
													: 'Connecting…'}
										>
											{#if config.isActive && remoteConns === 0}
												<span class="absolute inline-flex w-full h-full rounded-full bg-amber-400 opacity-75 animate-ping"></span>
											{/if}
											<span
												class="relative inline-flex w-2 h-2 rounded-full {!config.isActive
													? 'bg-slate-300 dark:bg-slate-600'
													: remoteConns > 0
														? 'bg-green-500'
														: 'bg-amber-500'}"
											></span>
										</span>
										<span class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{config.name}</span>
									</div>
									<div class="flex items-center gap-2 shrink-0">
										{#if loadState.isLoading}
											<div class="flex items-center gap-1.5 text-xs text-slate-500">
												<div class="w-3.5 h-3.5 border-2 border-violet-500 border-t-transparent rounded-full animate-spin"></div>
												Starting...
											</div>
										{:else if config.isActive}
											<button
												type="button"
												class="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors cursor-pointer"
												onclick={() => handleStopRemote(config)}
											>
												<Icon name="lucide:circle-stop" class="w-3.5 h-3.5" />
												Stop
											</button>
										{:else}
											<button
												type="button"
												class="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors cursor-pointer"
												onclick={() => handleStartRemote(config)}
											>
												<Icon name="lucide:play" class="w-3.5 h-3.5" />
												Start
											</button>
										{/if}
										<button
											type="button"
											class="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
											onclick={() => { remoteRemoveTargetId = config.id; }}
											disabled={config.isActive || removingRemoteId === config.id}
											title={config.isActive ? 'Stop the tunnel first' : 'Delete tunnel'}
										>
											{#if removingRemoteId === config.id}
												<div class="w-3.5 h-3.5 border-2 border-red-400 border-t-transparent rounded-full animate-spin"></div>
											{:else}
												<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
											{/if}
										</button>
									</div>
								</div>
								<!-- Remote ingress list (only shown when active) -->
								{#if config.isActive}
									{@const hostRules = config.ingress?.filter((r) => r.hostname) ?? []}
									{#if hostRules.length > 0}
										<div class="mt-2 pt-2 border-t border-slate-200 dark:border-slate-700/30 space-y-2">
											{#each hostRules as rule}
												{@const ruleUrl = `https://${rule.hostname}`}
												<div>
													<div class="flex items-start justify-between gap-2">
														<a
															href={ruleUrl}
															target="_blank"
															rel="noopener noreferrer"
															class="flex items-center gap-2 text-sm font-medium text-violet-600 dark:text-violet-400 hover:underline break-all"
														>
															<Icon name="lucide:globe" class="w-3.5 h-3.5 text-orange-500 shrink-0" />
															{rule.hostname}
														</a>
														<div class="flex items-center gap-1 shrink-0">
															<button
																type="button"
																class="flex p-1.5 rounded transition-colors cursor-pointer {copiedUrl === ruleUrl
																	? 'text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/20'
																	: 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'}"
																onclick={() => copyUrl(ruleUrl)}
																title="Copy URL"
															>
																<Icon name={copiedUrl === ruleUrl ? 'lucide:check' : 'lucide:copy'} class="w-3.5 h-3.5" />
															</button>
															<button
																type="button"
																class="flex p-1.5 rounded transition-colors cursor-pointer {qrUrl === ruleUrl
																	? 'text-violet-600 dark:text-violet-400 bg-violet-100 dark:bg-violet-900/20'
																	: 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'}"
																onclick={() => { qrUrl = qrUrl === ruleUrl ? '' : ruleUrl; }}
																title="Show QR Code"
															>
																<Icon name="lucide:qr-code" class="w-3.5 h-3.5" />
															</button>
														</div>
													</div>
													<div class="flex items-center gap-2 pl-5.5 text-xs text-slate-500 dark:text-slate-400">
														<Icon name="lucide:arrow-right" class="w-3 h-3 shrink-0" />
														<span class="font-mono">{rule.service}</span>
													</div>
													{#if qrUrl === ruleUrl}
														<div class="mt-2 ml-5.5 p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
															<TunnelQRCode value={ruleUrl} />
														</div>
													{/if}
												</div>
											{/each}
										</div>
									{:else}
										<div class="mt-2 pt-2 border-t border-slate-200 dark:border-slate-700/30">
											<p class="text-sm text-slate-400 dark:text-slate-500 italic">No domains connected yet. Configure ingress rules in Cloudflare Dashboard.</p>
										</div>
									{/if}
								{/if}
								{#if loadState.error}
									<p class="text-xs text-red-500 dark:text-red-400 mt-2">{loadState.error}</p>
								{/if}
							</div>
						{/each}
					</div>
				{/if}

				<!-- Add remote button / form -->
				{#if !showRemoteAddForm}
					<button
						type="button"
						class="flex items-center gap-2 w-full px-4 py-2 text-sm font-medium rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors cursor-pointer justify-center"
						onclick={() => { showRemoteAddForm = true; }}
					>
						<Icon name="lucide:plus" class="w-4 h-4" />
						Add Remote Tunnel
					</button>
				{:else}
					<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
						<!-- Guide -->
						<div class="flex gap-2.5 p-3 rounded-lg bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700/50">
							<Icon name="lucide:info" class="w-4 h-4 shrink-0 mt-0.5 text-violet-600 dark:text-violet-400" />
							<div class="text-xs text-slate-600 dark:text-slate-400 space-y-1.5">
								<p class="font-medium text-slate-700 dark:text-slate-300">How to get a tunnel token:</p>
								<ol class="list-decimal list-inside space-y-0.5">
									<li>Go to <a href="https://dash.cloudflare.com/?to=/:account/tunnels" target="_blank" rel="noopener noreferrer" class="text-violet-600 dark:text-violet-400 underline underline-offset-2">Cloudflare Dashboard</a></li>
									<li>Navigate to Networking &rarr; Tunnels</li>
									<li>Click <strong>Create a tunnel</strong></li>
									<li>Enter a <strong>Tunnel name</strong></li>
									<li>Copy the tunnel token</li>
								</ol>
							</div>
						</div>

						<!-- Name input -->
						<div class="space-y-2">
							<label for="remote-name" class="block text-sm font-semibold text-slate-700 dark:text-slate-300">
								Name
							</label>
							<input
								id="remote-name"
								type="text"
								bind:value={remoteName}
								placeholder="e.g. My Dev Tunnel"
								class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
							/>
						</div>

						<!-- Token input -->
						<div class="space-y-2">
							<label for="remote-token" class="block text-sm font-semibold text-slate-700 dark:text-slate-300">
								Tunnel Token
							</label>
							<div class="relative">
								<input
									id="remote-token"
									type={showRemoteToken ? 'text' : 'password'}
									bind:value={remoteToken}
									placeholder="eyJhIjoiNWE3ZjY0Nz..."
									class="w-full px-3 py-2 pr-10 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
								/>
								<button
									type="button"
									class="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors cursor-pointer"
									onclick={() => { showRemoteToken = !showRemoteToken; }}
									title={showRemoteToken ? 'Hide token' : 'Show token'}
								>
									<Icon name={showRemoteToken ? 'lucide:eye-off' : 'lucide:eye'} class="w-4 h-4" />
								</button>
							</div>
						</div>

						<!-- Buttons -->
						<div class="flex gap-2">
							<button
								type="button"
								class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
								onclick={handleAddRemote}
								disabled={isSaving || !remoteName.trim() || !remoteToken.trim()}
							>
								{#if isSaving}
									<div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
									Saving...
								{:else}
									<Icon name="lucide:plus" class="w-3.5 h-3.5" />
									Add
								{/if}
							</button>
							<button
								type="button"
								class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
								onclick={() => { showRemoteAddForm = false; remoteName = ''; remoteToken = ''; showRemoteToken = false; }}
							>
								Cancel
							</button>
						</div>
					</div>
				{/if}
			</div>
		</div>

		<!-- ========== LOCALLY-MANAGED ========== -->
		<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700/50">
				<div class="flex items-center gap-3">
					<div class="flex items-center justify-center w-9 h-9 rounded-lg bg-blue-500/10 dark:bg-blue-500/15">
						<Icon name="lucide:server" class="w-5 h-5 text-blue-600 dark:text-blue-400" />
					</div>
					<div>
						<h4 class="font-semibold text-slate-900 dark:text-slate-100">Locally-Managed</h4>
						<p class="text-xs text-slate-500 dark:text-slate-400">Tunnels configured and managed from Clopen</p>
					</div>
				</div>

				{#if locals.length > 0}
					<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">
						{locals.length} configured
					</span>
				{/if}
			</div>

			<!-- Body -->
			<div class="px-5 py-4 space-y-4">
				<!-- Auth status -->
				{#if !isAuthenticated}
					<div class="p-4 rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-900/10">
						<div class="flex items-start gap-3">
							<Icon name="lucide:key" class="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
							<div class="flex-1">
								<p class="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">Cloudflare Login Required</p>
								<p class="text-xs text-slate-600 dark:text-slate-400 mb-3">
									Locally-managed tunnels require authentication with your Cloudflare account.
								</p>

								{#if loginStep === 'idle'}
									<button
										type="button"
										class="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition-colors cursor-pointer"
										onclick={startLogin}
									>
										<Icon name="lucide:log-in" class="w-4 h-4" />
										Login to Cloudflare
									</button>
								{:else if loginStep === 'loading'}
									<div class="flex items-center gap-2 text-sm text-slate-500">
										<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
										Starting authentication...
									</div>
								{:else if loginStep === 'waiting-url'}
									<div class="space-y-3">
										<p class="text-xs text-slate-600 dark:text-slate-400">
											Open the URL below in your browser, log in to Cloudflare, and <strong>select the domain</strong> you want to use with tunnels.
										</p>
										<!-- Auth URL -->
										<div class="bg-white dark:bg-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-700 dark:text-slate-300 break-all border border-slate-200 dark:border-slate-700">
											{loginUrl}
										</div>
										<div class="flex gap-2">
											<button
												type="button"
												class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer
													{loginUrlCopied
													? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
													: 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'}"
												onclick={copyLoginUrl}
											>
												{#if loginUrlCopied}
													<Icon name="lucide:check" class="w-3 h-3" />
													Copied
												{:else}
													<Icon name="lucide:copy" class="w-3 h-3" />
													Copy URL
												{/if}
											</button>
											<a
												href={loginUrl}
												target="_blank"
												rel="noopener noreferrer"
												class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 hover:bg-violet-200 dark:hover:bg-violet-800/40 transition-colors"
											>
												<Icon name="lucide:external-link" class="w-3 h-3" />
												Open in Browser
											</a>
											<button
												type="button"
												class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors cursor-pointer"
												onclick={cancelLogin}
											>
												Cancel
											</button>
										</div>
										<p class="text-2xs text-slate-400 dark:text-slate-500">
											Waiting for browser authorization...
										</p>
									</div>
								{:else if loginStep === 'zone-prompt'}
									<div class="space-y-3">
										<div class="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 mb-2">
											<Icon name="lucide:circle-check" class="w-4 h-4" />
											Login successful!
										</div>
										<p class="text-xs text-slate-600 dark:text-slate-400">
											Enter the domain you selected during Cloudflare authorization. This will be used for subdomain configuration.
										</p>
										<div class="flex gap-2">
											<input
												type="text"
												bind:value={zoneInput}
												placeholder="example.com"
												class="flex-1 px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
												onkeydown={(e) => { if (e.key === 'Enter') handleSetZone(); }}
											/>
											<button
												type="button"
												class="px-4 py-1.5 text-xs font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
												onclick={handleSetZone}
												disabled={!zoneInput.trim()}
											>
												Confirm
											</button>
										</div>
									</div>
								{:else if loginStep === 'error'}
									<div class="space-y-2">
										<div class="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
											<Icon name="lucide:circle-alert" class="w-4 h-4" />
											{loginError ?? 'Authentication failed'}
										</div>
										<button
											type="button"
											class="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors cursor-pointer"
											onclick={() => { loginStep = 'idle'; loginError = null; }}
										>
											Try Again
										</button>
									</div>
								{/if}
							</div>
						</div>
					</div>
				{:else}
					<!-- Authenticated indicator with zone + logout + info -->
					<div class="rounded-lg bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-800/30">
						<div class="flex items-center justify-between gap-3 px-3 pt-2">
							<div class="flex items-center gap-2">
								<Icon name="lucide:circle-check" class="w-4 h-4 text-green-600 dark:text-green-400" />
								<span class="text-xs text-green-700 dark:text-green-300 font-medium">
									Cloudflare authenticated
									{#if authorizedZone}
										<span class="text-green-600/70 dark:text-green-400/70">({authorizedZone})</span>
									{/if}
								</span>
							</div>
							<button
								type="button"
								class="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors cursor-pointer"
								onclick={handleLogout}
							>
								<Icon name="lucide:log-out" class="w-3 h-3" />
								Logout
							</button>
						</div>
						<div class="px-3 pb-2">
							<p class="text-2xs text-green-600/60 dark:text-green-400/50">
								One domain per login. For multiple domains, use Remotely-Managed tunnels.
							</p>
						</div>
					</div>

					{#if !authorizedZone}
						<!-- Zone prompt for already-authenticated users who haven't set zone -->
						<div class="p-3 rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-900/10">
							<p class="text-xs text-slate-600 dark:text-slate-400 mb-2">
								Enter the domain authorized with your Cloudflare account to enable subdomain configuration.
							</p>
							<div class="flex gap-2">
								<input
									type="text"
									bind:value={zoneInput}
									placeholder="example.com"
									class="flex-1 px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
									onkeydown={(e) => { if (e.key === 'Enter') handleSetZone(); }}
								/>
								<button
									type="button"
									class="px-4 py-1.5 text-xs font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
									onclick={handleSetZone}
									disabled={!zoneInput.trim()}
								>
									Set Domain
								</button>
							</div>
						</div>
					{/if}
				{/if}

				<!-- Existing local configs -->
				{#if locals.length > 0}
					<div class="space-y-3">
						{#each locals as config (config.id)}
							{@const loadState = getLocalLoadingState(config.id)}
							{@const localConns = tunnelConnections(config.id, 'local')}
							<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 overflow-hidden">
								<!-- Config header -->
								<div class="flex items-center justify-between gap-3 p-3 bg-slate-50 dark:bg-slate-800/80">
									<div class="flex items-center gap-2.5 min-w-0">
										<span
											class="relative flex w-2 h-2 shrink-0"
											title={!config.isActive
												? 'Inactive'
												: localConns > 0
													? `Public · ${localConns} edge connection${localConns > 1 ? 's' : ''}`
													: 'Connecting…'}
										>
											{#if config.isActive && localConns === 0}
												<span class="absolute inline-flex w-full h-full rounded-full bg-amber-400 opacity-75 animate-ping"></span>
											{/if}
											<span
												class="relative inline-flex w-2 h-2 rounded-full {!config.isActive
													? 'bg-slate-300 dark:bg-slate-600'
													: localConns > 0
														? 'bg-green-500'
														: 'bg-amber-500'}"
											></span>
										</span>
										<span class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{config.name}</span>
									</div>
									<div class="flex items-center gap-2 shrink-0">
										{#if loadState.isLoading}
											<div class="flex items-center gap-1.5 text-xs text-slate-500">
												<div class="w-3.5 h-3.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
												Starting...
											</div>
										{:else if config.isActive}
											<button
												type="button"
												class="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors cursor-pointer"
												onclick={() => handleStopLocal(config)}
											>
												<Icon name="lucide:circle-stop" class="w-3.5 h-3.5" />
												Stop
											</button>
										{:else if config.ingress.length > 0}
											<button
												type="button"
												class="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors cursor-pointer"
												onclick={() => handleStartLocal(config)}
											>
												<Icon name="lucide:play" class="w-3.5 h-3.5" />
												Start
											</button>
										{/if}
										<button
											type="button"
											class="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
											onclick={() => { localDeleteTargetId = config.id; }}
											disabled={config.isActive || deletingLocalId === config.id}
											title={config.isActive ? 'Stop the tunnel first' : 'Delete tunnel'}
										>
											{#if deletingLocalId === config.id}
												<div class="w-3.5 h-3.5 border-2 border-red-400 border-t-transparent rounded-full animate-spin"></div>
											{:else}
												<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
											{/if}
										</button>
									</div>
								</div>

								{#if loadState.error}
									<div class="px-3 py-2 bg-red-50 dark:bg-red-900/10 border-t border-red-200 dark:border-red-800/30">
										<p class="text-xs text-red-500 dark:text-red-400">{loadState.error}</p>
									</div>
								{/if}

								<!-- Domains -->
								<div class="px-3 py-2.5 space-y-2 border-t border-slate-200 dark:border-slate-700/50">
									{#if config.ingress.length > 0}
										{#each config.ingress as rule}
											{@const ruleUrl = `https://${rule.hostname}`}
											<div>
												<div class="flex items-start justify-between gap-2">
													<a
														href={ruleUrl}
														target="_blank"
														rel="noopener noreferrer"
														class="flex items-center gap-2 text-sm font-medium text-violet-600 dark:text-violet-400 hover:underline break-all"
													>
														<Icon name="lucide:globe" class="w-3.5 h-3.5 text-blue-500 shrink-0" />
														{rule.hostname}
													</a>
													<div class="flex items-center gap-1 shrink-0">
														<button
															type="button"
															class="flex p-1.5 rounded transition-colors cursor-pointer {copiedUrl === ruleUrl
																? 'text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/20'
																: 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'}"
															onclick={() => copyUrl(ruleUrl)}
															title="Copy URL"
														>
															<Icon name={copiedUrl === ruleUrl ? 'lucide:check' : 'lucide:copy'} class="w-3.5 h-3.5" />
														</button>
														<button
															type="button"
															class="flex p-1.5 rounded transition-colors cursor-pointer {qrUrl === ruleUrl
																? 'text-violet-600 dark:text-violet-400 bg-violet-100 dark:bg-violet-900/20'
																: 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'}"
															onclick={() => { qrUrl = qrUrl === ruleUrl ? '' : ruleUrl; }}
															title="Show QR Code"
														>
															<Icon name="lucide:qr-code" class="w-3.5 h-3.5" />
														</button>
														{#if !config.isActive}
															<button
																type="button"
																class="flex p-1.5 text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors shrink-0 cursor-pointer"
																onclick={() => handleRemoveDomain(config.id, rule.hostname)}
																title="Remove subdomain"
															>
																<Icon name="lucide:x" class="w-3.5 h-3.5" />
															</button>
														{/if}
													</div>
												</div>
												<div class="flex items-center gap-2 pl-5.5 text-xs text-slate-500 dark:text-slate-400">
													<Icon name="lucide:arrow-right" class="w-3 h-3 shrink-0" />
													<span class="font-mono">{rule.service}</span>
												</div>
												{#if qrUrl === ruleUrl}
													<div class="mt-2 ml-5.5 p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
														<TunnelQRCode value={ruleUrl} />
													</div>
												{/if}
											</div>
										{/each}
									{:else}
										<p class="text-sm text-slate-400 dark:text-slate-500 italic">No subdomains configured yet</p>
									{/if}

									<!-- Add subdomain -->
									{#if !config.isActive && authorizedZone}
										{#if domainConfigId === config.id}
											<div class="space-y-3 pt-1">
												<div class="space-y-2">
													<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300">Subdomain</label>
													<div class="flex">
														<input
															type="text"
															bind:value={domainSubdomain}
															placeholder="dev"
															class="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded-l-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 focus:z-10"
														/>
														<span class="inline-flex items-center px-3 py-2 text-sm font-mono text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border border-l-0 border-slate-300 dark:border-slate-600 rounded-r-lg">
															.{authorizedZone}
														</span>
													</div>
												</div>
												<div class="space-y-2">
													<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300">Service URL</label>
													<input
														type="text"
														bind:value={domainService}
														placeholder="http://localhost:3000"
														class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
													/>
												</div>
												<div class="flex gap-2">
													<button
														type="button"
														class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
														onclick={() => handleAddDomain(config.id)}
														disabled={!domainSubdomain.trim() || !domainService.trim() || isAddingDomain}
													>
														{#if isAddingDomain}
															<div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
															Adding...
														{:else}
															<Icon name="lucide:plus" class="w-3.5 h-3.5" />
															Add Subdomain
														{/if}
													</button>
													<button
														type="button"
														class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
														onclick={() => { domainConfigId = null; domainSubdomain = ''; domainService = ''; }}
													>
														Cancel
													</button>
												</div>
											</div>
										{:else}
											<button
												type="button"
												class="flex items-center gap-2 w-full mt-3 px-4 py-2 text-xs font-medium rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer justify-center"
												onclick={() => { domainConfigId = config.id; }}
											>
												<Icon name="lucide:plus" class="w-4 h-4" />
												Add Subdomain
											</button>
										{/if}
									{:else if !config.isActive && !authorizedZone}
										<p class="text-xs text-amber-500 dark:text-amber-400 pt-1">Set your authorized domain above to add subdomains</p>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}

				<!-- Add local tunnel button / form -->
				{#if isAuthenticated && authorizedZone}
					{#if !showLocalCreateForm}
						<button
							type="button"
							class="flex items-center gap-2 w-full px-4 py-2 text-sm font-medium rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer justify-center"
							onclick={() => { showLocalCreateForm = true; }}
						>
							<Icon name="lucide:plus" class="w-4 h-4" />
							Add Local Tunnel
						</button>
					{:else}
						<div class="space-y-3 p-4 rounded-lg border border-blue-200 dark:border-blue-800/50 bg-blue-50/50 dark:bg-blue-900/10">
							<div class="space-y-2">
								<label for="local-name" class="block text-sm font-semibold text-slate-700 dark:text-slate-300">
									Tunnel Name
								</label>
								<input
									id="local-name"
									type="text"
									bind:value={localName}
									placeholder="e.g. my-dev-tunnel"
									class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
								/>
								<p class="text-2xs text-slate-400 dark:text-slate-500">
									A unique name for the tunnel (lowercase, no spaces)
								</p>
							</div>
							<div class="flex gap-2">
								<button
									type="button"
									class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
									onclick={handleCreateLocal}
									disabled={isSaving || !localName.trim()}
								>
									{#if isSaving}
										<div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
										Adding...
									{:else}
										<Icon name="lucide:plus" class="w-3.5 h-3.5" />
										Add
									{/if}
								</button>
								<button
									type="button"
									class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
									onclick={() => { showLocalCreateForm = false; localName = ''; }}
								>
									Cancel
								</button>
							</div>
						</div>
					{/if}
				{/if}
			</div>
		</div>
	</div>

	<!-- Store error -->
	{#if storeError}
		<div class="mt-4 flex items-center gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50">
			<Icon name="lucide:circle-alert" class="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
			<span class="text-sm text-red-700 dark:text-red-300">{storeError}</span>
		</div>
	{/if}
</div>

<!-- Remove remote dialog -->
<Dialog
	bind:isOpen={() => remoteRemoveTargetId !== null, (v) => { if (!v) remoteRemoveTargetId = null; }}
	onClose={() => { remoteRemoveTargetId = null; }}
	type="warning"
	title="Remove Remote Tunnel"
	message="Are you sure you want to remove this remote tunnel config? The tunnel token will be deleted. If the tunnel is running, it will be stopped."
	confirmText="Remove"
	cancelText="Cancel"
	onConfirm={handleRemoveRemote}
/>

<!-- Delete local dialog -->
<Dialog
	bind:isOpen={() => localDeleteTargetId !== null, (v) => { if (!v) localDeleteTargetId = null; }}
	onClose={() => { localDeleteTargetId = null; }}
	type="warning"
	title="Delete Local Tunnel"
	message="Are you sure you want to delete this tunnel? The tunnel and its configuration will be permanently removed from Cloudflare."
	confirmText="Delete"
	cancelText="Cancel"
	onConfirm={handleDeleteLocal}
/>
