<!--
	Host overview: connection state and everything Clopen knows about the host,
	plus the two actions the user actually has to take by hand — connecting or
	disconnecting it, and accepting a host key that changed.

	Connect/Disconnect are real: the backend pool dials on demand, so disconnect
	also suspends the host, and the terminal and file browser go with it.
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import { sshClientStore } from '$frontend/stores/features/ssh-client.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import type { SshConnection } from '$shared/types/ssh';

	interface Props {
		connection: SshConnection;
	}

	const { connection }: Props = $props();

	const health = $derived(sshClientStore.health[connection.id] ?? null);
	const connected = $derived(health?.ok === true);
	const suspended = $derived(health?.suspended === true);
	const diskUsage = $derived(sshClientStore.diskUsage[connection.id] ?? null);
	const forwards = $derived(sshClientStore.forwards[connection.id] ?? []);
	const forwardStatuses = $derived(sshClientStore.forwardStatuses[connection.id] ?? {});
	const runningForwards = $derived(
		forwards.filter((forward) => forwardStatuses[forward.id]?.running).length
	);
	const openShells = $derived(sshClientStore.getView(connection.id).tabs.length);

	const knownHost = $derived(
		sshClientStore.knownHosts.find(
			(entry) => entry.host === connection.host && entry.port === connection.port
		) ?? null
	);
	const jumpHost = $derived(
		connection.jumpConnectionId
			? (sshClientStore.connections.find((entry) => entry.id === connection.jumpConnectionId) ?? null)
			: null
	);

	let busy = $state(false);
	let actionError = $state<string | null>(null);
	let confirmTrust = $state(false);

	const AUTH_LABELS = {
		password: 'Password',
		key: 'Private key (stored in Clopen)',
		'key-file': 'Private key file on the server',
		agent: 'ssh-agent'
	} as const;

	const statusText = $derived.by(() => {
		if (connected) return health?.latencyMs !== null && health?.latencyMs !== undefined
			? `Connected · ${health.latencyMs} ms`
			: 'Connected';
		if (suspended) return 'Disconnected';
		if (health?.hostKeyChanged) return 'Host key changed';
		if (health) return 'Connection failed';
		return 'Not connected yet';
	});

	const statusColor = $derived.by(() => {
		if (connected) return 'bg-emerald-500';
		if (suspended) return 'bg-slate-400';
		if (health?.hostKeyChanged) return 'bg-amber-500';
		if (health) return 'bg-red-500';
		return 'bg-slate-400';
	});

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}

	const diskRatio = $derived(
		diskUsage && diskUsage.usedBytes !== null && diskUsage.totalBytes
			? diskUsage.usedBytes / diskUsage.totalBytes
			: null
	);

	async function connect(): Promise<void> {
		busy = true;
		actionError = null;
		try {
			const result = await sshClientStore.activate(connection.id);
			if (!result.ok && result.error) actionError = result.error;
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Could not connect';
		} finally {
			busy = false;
		}
	}

	async function disconnect(): Promise<void> {
		busy = true;
		actionError = null;
		try {
			await sshClientStore.disconnect(connection.id);
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Could not disconnect';
		} finally {
			busy = false;
		}
	}

	async function trustNewKey(): Promise<void> {
		confirmTrust = false;
		busy = true;
		actionError = null;
		try {
			await sshClientStore.trustHostKey(connection.id);
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Could not trust the new key';
		} finally {
			busy = false;
		}
	}

	$effect(() => {
		sshClientStore.loadKnownHosts().catch(() => {
			// The overview still works without the trusted-key list.
		});
	});

	$effect(() => {
		sshClientStore.loadForwards(connection.id).catch(() => {
			// Forward counts are a summary; the Forwards tab reports its own errors.
		});
	});

	// Disk figures are part of what this page is for, so it asks for them itself
	// rather than waiting for the file browser to happen to have been opened.
	// Gated on a live connection: probing needs a transport.
	$effect(() => {
		if (!sshClientStore.isConnected(connection.id)) return;
		sshClientStore.loadDiskUsage(connection.id, connection.initialPath ?? '').catch(() => {
			// A host that cannot report its quota still shows everything else.
		});
	});

	interface DetailRow {
		label: string;
		value: string;
		icon: IconName;
		mono?: boolean;
	}

	const connectionDetails = $derived<DetailRow[]>([
		{ label: 'Address', value: `${connection.host}:${connection.port}`, icon: 'lucide:globe', mono: true },
		{ label: 'User', value: connection.username, icon: 'lucide:user', mono: true },
		{ label: 'Authentication', value: AUTH_LABELS[connection.authMethod], icon: 'lucide:key-round' },
		{
			label: 'Jump host',
			value: jumpHost ? `${jumpHost.name} (${jumpHost.host}:${jumpHost.port})` : 'Direct',
			icon: 'lucide:route'
		},
		{
			label: 'Start in',
			value: connection.initialPath || 'Home directory',
			icon: 'lucide:folder',
			mono: true
		},
		{
			label: 'Keepalive',
			value: connection.keepaliveSeconds > 0 ? `Every ${connection.keepaliveSeconds}s` : 'Disabled',
			icon: 'lucide:activity'
		},
		{
			label: 'Last used',
			value: connection.lastUsedAt ? new Date(connection.lastUsedAt).toLocaleString() : 'Never',
			icon: 'lucide:clock'
		},
		{
			label: 'Added',
			value: new Date(connection.createdAt).toLocaleDateString(),
			icon: 'lucide:calendar'
		}
	]);

	const cardClass =
		'rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4';
	const sectionTitle =
		'text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 m-0';
</script>

<!-- @container: measured against this pane, not the viewport — a sidebar
     sits beside it inside the modal. -->
<div class="@container flex-1 min-h-0 overflow-y-auto p-4">
	<div class="flex flex-col gap-4">
		<!-- Status + primary action -->
		<section class={cardClass}>
			<!-- Stacked below sm: at phone width the address and the button fight for
			     the same row and the status line ends up under the button. -->
			<div class="flex flex-col @2xl:flex-row @2xl:items-start @2xl:justify-between gap-3">
				<div class="min-w-0 @2xl:flex-1">
					<div class="flex items-center gap-2.5 min-w-0">
						<Icon name="lucide:server" class="w-5 h-5 text-violet-500 shrink-0" />
						<h3 class="text-lg font-semibold text-slate-900 dark:text-slate-100 m-0 truncate">
							{connection.name}
						</h3>
					</div>
					<p class="text-sm text-slate-500 dark:text-slate-400 m-0 mt-1 font-mono truncate">
						{connection.username}@{connection.host}:{connection.port}
					</p>
					<div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm min-w-0">
						<span class="flex items-center gap-2 shrink-0">
							<span class="w-2 h-2 rounded-full shrink-0 {statusColor}"></span>
							<span class="text-slate-700 dark:text-slate-300">{statusText}</span>
						</span>
						{#if health?.remoteOs}
							<span
								class="min-w-0 max-w-full truncate text-slate-400 dark:text-slate-500 font-mono text-xs"
								title={health.remoteOs}
							>
								{health.remoteOs}
							</span>
						{/if}
					</div>
				</div>

				<button
					type="button"
					class="flex items-center justify-center gap-2 w-full @2xl:w-auto shrink-0 px-3.5 py-2 text-sm rounded-md transition-colors disabled:opacity-50 {connected
						? 'border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
						: 'bg-violet-600 hover:bg-violet-700 text-white'}"
					onclick={connected ? disconnect : connect}
					disabled={busy}
				>
					<Icon name={connected ? 'lucide:unplug' : 'lucide:plug'} class="w-4 h-4" />
					{busy ? 'Working…' : connected ? 'Disconnect' : 'Connect'}
				</button>
			</div>

			{#if suspended}
				<p class="mt-3 text-xs text-slate-500 dark:text-slate-500 m-0">
					Shells and port forwards on this host are stopped, and the terminal and file browser stay
					closed until you connect again.
				</p>
			{/if}

			{#if health && !health.ok && health.error}
				<div
					class="mt-3 px-3 py-2 rounded-md text-xs bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 whitespace-pre-wrap wrap-anywhere"
				>
					{health.error}
				</div>
			{/if}

			{#if actionError}
				<div
					class="mt-3 px-3 py-2 rounded-md text-xs bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 whitespace-pre-wrap wrap-anywhere"
				>
					{actionError}
				</div>
			{/if}
		</section>

		<!-- Live counters -->
		<div class="grid grid-cols-2 @4xl:grid-cols-4 gap-3">
			<div class={cardClass}>
				<div class="flex items-center gap-2 text-slate-500 dark:text-slate-400">
					<Icon name="lucide:terminal" class="w-4 h-4" />
					<span class="text-xs font-medium">Open shells</span>
				</div>
				<div class="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
					{openShells}
				</div>
			</div>
			<div class={cardClass}>
				<div class="flex items-center gap-2 text-slate-500 dark:text-slate-400">
					<Icon name="lucide:arrow-left-right" class="w-4 h-4" />
					<span class="text-xs font-medium">Forwards running</span>
				</div>
				<div class="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
					{runningForwards}<span class="text-base text-slate-400">/{forwards.length}</span>
				</div>
			</div>
			<div class={cardClass}>
				<div class="flex items-center gap-2 text-slate-500 dark:text-slate-400">
					<Icon name="lucide:gauge" class="w-4 h-4" />
					<span class="text-xs font-medium">Latency</span>
				</div>
				<div class="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
					{health?.latencyMs !== null && health?.latencyMs !== undefined
						? `${health.latencyMs}`
						: '—'}<span class="text-base text-slate-400">
						{health?.latencyMs !== null && health?.latencyMs !== undefined ? ' ms' : ''}
					</span>
				</div>
			</div>
			<div class="{cardClass} col-span-2 @4xl:col-span-1">
				<div class="flex items-center gap-2 text-slate-500 dark:text-slate-400">
					<Icon name="lucide:hard-drive" class="w-4 h-4 shrink-0" />
					<span class="text-xs font-medium">
						{diskUsage && diskUsage.source !== 'unknown' ? diskUsage.sourceLabel : 'Disk'}
					</span>
				</div>
				{#if diskUsage && diskUsage.usedBytes !== null}
					<div class="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
						{diskRatio !== null ? `${(diskRatio * 100).toFixed(1)}%` : formatBytes(diskUsage.usedBytes)}
					</div>
					{#if diskUsage.totalBytes}
						<div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
							{formatBytes(diskUsage.usedBytes)} of {formatBytes(diskUsage.totalBytes)}
						</div>
						<div class="mt-1.5 h-1 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
							<div
								class="h-full {diskRatio !== null && diskRatio > 0.9
									? 'bg-red-500'
									: diskRatio !== null && diskRatio > 0.75
										? 'bg-amber-500'
										: 'bg-emerald-500'}"
								style:width="{Math.min(100, (diskRatio ?? 0) * 100)}%"
							></div>
						</div>
					{/if}
					{#if diskUsage.inodesUsed !== null}
						<div class="mt-1 text-xs text-slate-400 dark:text-slate-500">
							{diskUsage.inodesUsed.toLocaleString()} files{diskUsage.inodeLimit
								? ` of ${diskUsage.inodeLimit.toLocaleString()}`
								: ''}
						</div>
					{/if}
				{:else}
					<div class="mt-1 text-2xl font-semibold text-slate-400">—</div>
				{/if}
			</div>
		</div>

		<!-- Details + host key, side by side once there is room -->
		<div class="grid grid-cols-1 @4xl:grid-cols-2 gap-4">
			<section class={cardClass}>
				<h4 class={sectionTitle}>Connection</h4>
				<dl class="mt-3 flex flex-col gap-2.5 text-sm m-0">
					{#each connectionDetails as detail (detail.label)}
						<div class="flex flex-col @2xl:flex-row @2xl:items-baseline @2xl:gap-4 min-w-0">
							<dt
								class="flex items-center gap-2 text-slate-500 dark:text-slate-400 whitespace-nowrap @2xl:w-36 @2xl:shrink-0"
							>
								<Icon name={detail.icon} class="w-3.5 h-3.5 shrink-0" />
								{detail.label}
							</dt>
							<dd
								class="text-slate-800 dark:text-slate-200 m-0 min-w-0 truncate {detail.mono
									? 'font-mono text-[13px]'
									: ''}"
								title={detail.value}
							>
								{detail.value}
							</dd>
						</div>
					{/each}
				</dl>
			</section>

			<section class={cardClass}>
				<div class="flex items-start justify-between gap-3">
					<div>
						<h4 class={sectionTitle}>Host key</h4>
						<p class="text-xs text-slate-500 dark:text-slate-500 m-0 mt-1">
							{connection.strictHostKey
								? 'Clopen refuses to connect if this key changes.'
								: 'Verification is off for this host — any key is accepted.'}
						</p>
					</div>
					<Icon
						name={connection.strictHostKey ? 'lucide:shield-check' : 'lucide:shield-off'}
						class="w-5 h-5 shrink-0 {connection.strictHostKey ? 'text-emerald-500' : 'text-amber-500'}"
					/>
				</div>

				{#if knownHost}
					<div class="mt-3">
						<div class="font-mono text-xs text-slate-800 dark:text-slate-200 wrap-anywhere">
							{knownHost.fingerprint}
						</div>
						<div class="text-xs text-slate-500 dark:text-slate-400 mt-1">
							{knownHost.keyType} · trusted {new Date(knownHost.addedAt).toLocaleDateString()}
							{#if knownHost.lastSeenAt}
								· last seen {new Date(knownHost.lastSeenAt).toLocaleDateString()}
							{/if}
						</div>
					</div>
				{:else}
					<p class="mt-3 text-sm text-slate-500 dark:text-slate-400 m-0">
						No key recorded yet — the first successful connection records one.
					</p>
				{/if}

				{#if health?.hostKeyChanged && health.hostKeyFingerprint}
					<div
						class="mt-3 px-3 py-2 rounded-md text-xs bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300"
					>
						<div class="font-semibold">The host is now presenting</div>
						<div class="font-mono mt-0.5 wrap-anywhere">{health.hostKeyFingerprint}</div>
					</div>
				{/if}

				<div class="mt-3 flex flex-wrap items-center gap-2">
					{#if health?.hostKeyChanged}
						<button
							type="button"
							class="px-3 py-1.5 text-sm rounded-md bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50"
							onclick={() => (confirmTrust = true)}
							disabled={busy}
						>
							Trust new key
						</button>
					{/if}
					{#if knownHost}
						<button
							type="button"
							class="px-3 py-1.5 text-sm rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
							onclick={() => sshClientStore.forgetHostKey(connection.host, connection.port)}
							disabled={busy}
						>
							Forget key
						</button>
					{/if}
				</div>
			</section>
		</div>
	</div>
</div>

<Dialog
	bind:isOpen={confirmTrust}
	onClose={() => (confirmTrust = false)}
	type="warning"
	title="Trust the new host key"
	message="Only do this if you know why the key changed — a rebuilt server, a reinstalled OS, a rotated key. If you were not expecting it, the connection may be intercepted."
	confirmText="Trust and reconnect"
	onConfirm={trustNewKey}
/>
