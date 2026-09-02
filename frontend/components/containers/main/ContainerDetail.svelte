<!--
	Containers — everything known about one container.

	The list answers "is it up"; this answers "what is it, where does it write,
	what can reach it, and how do I get inside". It is also where the actions
	live, because a stop that can be reached without opening anything is a stop
	that will eventually be hit by accident.

	Environment values are shown only to an admin, and only after asking: a
	container's env is where its database password lives, and this pane is
	reachable through a shared Remote Access link.
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { containersStore } from '$frontend/stores/features/containers.svelte';
	import { portsStore } from '$frontend/stores/features/ports.svelte';
	import { sshClientStore } from '$frontend/stores/features/ssh-client.svelte';
	import { closeContainersDialog, openPortsDialog } from '$frontend/stores/ui/quick-panels.svelte';
	import type { ContainerAction, ContainerEntry, ContainerPortBinding } from '$shared/types/containers';
	import { LOCAL_HOST_ID } from '$shared/types/host';

	interface Props {
		entry: ContainerEntry;
		canManage: boolean;
		onClose: () => void;
		onAction: (entry: ContainerEntry, action: ContainerAction) => void;
		/** Rendered as a bottom sheet on small screens rather than a side panel. */
		sheet?: boolean;
	}

	const { entry, canManage, onClose, onAction, sheet = false }: Props = $props();

	let showEnv = $state(false);

	const detail = $derived(containersStore.detailFor(entry.id));
	const stats = $derived(containersStore.statsFor(entry.id));
	const statsLoading = $derived(containersStore.statsLoading === entry.id);
	const busy = $derived(containersStore.actingId === entry.id);
	const isUp = $derived(entry.state === 'running' || entry.state === 'paused');
	const isPaused = $derived(entry.state === 'paused');
	const created = $derived(entry.createdAt ? new Date(entry.createdAt).toLocaleString() : null);
	const started = $derived(
		detail?.startedAt ? new Date(detail.startedAt).toLocaleString() : null
	);

	/**
	 * Jump to the port table, at the row this mapping produced.
	 *
	 * The mirror of the Ports panel's link to here, and it opens the same way:
	 * the panel and the SSH Client tab are one view, so which of the two to show
	 * follows from the host. Only a published port has a row to jump to.
	 */
	function openPort(port: ContainerPortBinding): void {
		if (port.hostPort === null) return;
		const hostId = containersStore.activeHostId;
		portsStore.focusPort(hostId, port.protocol, port.hostPort);
		if (hostId === LOCAL_HOST_ID) {
			closeContainersDialog();
			openPortsDialog();
			return;
		}
		sshClientStore.setView(hostId, 'ports');
	}
</script>

<aside
	class="flex flex-col w-full min-h-0 bg-white dark:bg-slate-900
		{sheet
		? 'rounded-t-2xl border-t border-slate-200 dark:border-slate-800'
		: 'border-l border-slate-200 dark:border-slate-800'}"
>
	{#if sheet}
		<div class="flex justify-center pt-2 pb-1 shrink-0">
			<span class="w-9 h-1 rounded-full bg-slate-300 dark:bg-slate-700"></span>
		</div>
	{/if}

	<header
		class="flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0"
	>
		<div class="min-w-0">
			<p class="m-0 text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
				{entry.name}
			</p>
			<p class="m-0 text-xs text-slate-500 dark:text-slate-500 truncate">{entry.statusText}</p>
		</div>
		<button
			type="button"
			class="shrink-0 flex items-center justify-center w-7 h-7 rounded-md border-none bg-transparent text-slate-400 cursor-pointer hover:bg-violet-500/10"
			onclick={onClose}
			aria-label="Close details"
		>
			<Icon name="lucide:x" class="w-4 h-4" />
		</button>
	</header>

	<div class="flex flex-wrap items-center gap-1.5 px-4 py-2.5 shrink-0 border-b border-slate-200 dark:border-slate-800">
		<button
			type="button"
			class="flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs font-semibold cursor-pointer transition-colors bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-violet-500/10 hover:text-violet-700 dark:hover:text-violet-300"
			onclick={() => void containersStore.startLogs(entry)}
		>
			<Icon name="lucide:scroll-text" class="w-3.5 h-3.5" />
			Logs
		</button>

		{#if canManage}
			<button
				type="button"
				class="flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs font-semibold cursor-pointer transition-colors bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-violet-500/10 hover:text-violet-700 dark:hover:text-violet-300 disabled:opacity-40 disabled:cursor-not-allowed"
				onclick={() => containersStore.openShell(entry)}
				disabled={entry.state !== 'running'}
				title={entry.state === 'running'
					? 'Open a shell inside this container'
					: 'A stopped container has nothing to attach to'}
			>
				<Icon name="lucide:terminal" class="w-3.5 h-3.5" />
				Shell
			</button>

			{#if entry.canManage}
				<button
					type="button"
					class="flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs font-semibold cursor-pointer transition-colors bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-violet-500/10 disabled:opacity-40 disabled:cursor-wait"
					onclick={() => onAction(entry, isUp ? 'stop' : 'start')}
					disabled={busy}
				>
					<Icon
						name={busy ? 'lucide:loader-circle' : isUp ? 'lucide:square' : 'lucide:play'}
						class="w-3.5 h-3.5 {busy ? 'animate-spin' : ''}"
					/>
					{isUp ? 'Stop' : 'Start'}
				</button>
				<button
					type="button"
					class="flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs font-semibold cursor-pointer transition-colors bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-violet-500/10 disabled:opacity-40 disabled:cursor-wait"
					onclick={() => onAction(entry, 'restart')}
					disabled={busy}
				>
					<Icon name="lucide:rotate-cw" class="w-3.5 h-3.5" />
					Restart
				</button>

				{#if isUp}
					<!-- Pause freezes the processes without unbinding the ports, which
					     is the one way to stop something eating CPU and keep its port. -->
					<button
						type="button"
						class="flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs font-semibold cursor-pointer transition-colors bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-violet-500/10 disabled:opacity-40 disabled:cursor-wait"
						onclick={() => onAction(entry, isPaused ? 'unpause' : 'pause')}
						disabled={busy}
					>
						<Icon name={isPaused ? 'lucide:play' : 'lucide:pause'} class="w-3.5 h-3.5" />
						{isPaused ? 'Resume' : 'Pause'}
					</button>
				{/if}

				<button
					type="button"
					class="flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs font-semibold cursor-pointer transition-colors bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40 disabled:cursor-wait"
					onclick={() => onAction(entry, isUp ? 'force-remove' : 'remove')}
					disabled={busy}
				>
					<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
					Remove
				</button>
			{/if}
		{/if}
	</div>

	<div class="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
		<section class="flex flex-col gap-1.5">
			<h4 class="m-0 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Container</h4>
			<dl class="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
				<dt class="text-slate-500 dark:text-slate-500">Image</dt>
				<dd class="m-0 text-slate-700 dark:text-slate-300 break-all">{entry.image}</dd>

				<dt class="text-slate-500 dark:text-slate-500">ID</dt>
				<dd class="m-0 font-mono text-slate-700 dark:text-slate-300">{entry.shortId}</dd>

				<dt class="text-slate-500 dark:text-slate-500">State</dt>
				<dd class="m-0 text-slate-700 dark:text-slate-300">
					{entry.state}{entry.health !== 'none' ? ` · ${entry.health}` : ''}
				</dd>

				<dt class="text-slate-500 dark:text-slate-500">Created</dt>
				<dd class="m-0 text-slate-700 dark:text-slate-300">{created ?? 'unknown'}</dd>

				<dt class="text-slate-500 dark:text-slate-500">Started</dt>
				<dd class="m-0 text-slate-700 dark:text-slate-300">{started ?? (isUp ? '…' : 'not running')}</dd>

				{#if entry.composeProject}
					<dt class="text-slate-500 dark:text-slate-500">Compose</dt>
					<dd class="m-0 text-slate-700 dark:text-slate-300">
						{entry.composeProject}{entry.composeService ? ` · ${entry.composeService}` : ''}
					</dd>
				{/if}

				{#if detail?.restartPolicy}
					<dt class="text-slate-500 dark:text-slate-500">Restart</dt>
					<dd class="m-0 text-slate-700 dark:text-slate-300">
						{detail.restartPolicy}{detail.restartCount ? ` · ${detail.restartCount} restarts` : ''}
					</dd>
				{/if}

				{#if detail?.pid}
					<dt class="text-slate-500 dark:text-slate-500">Host PID</dt>
					<dd class="m-0 font-mono text-slate-700 dark:text-slate-300">{detail.pid}</dd>
				{/if}
			</dl>

			{#if entry.command}
				<p
					class="m-0 mt-1 p-2 rounded-md bg-slate-100 dark:bg-slate-950 font-mono text-[11px] text-slate-600 dark:text-slate-400 break-all"
				>
					{entry.command}
				</p>
			{/if}
		</section>

		<section class="flex flex-col gap-1.5">
			<h4 class="m-0 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Ports</h4>
			{#if entry.ports.length === 0}
				<p class="m-0 text-xs text-slate-500 dark:text-slate-500">
					This container publishes nothing to the host.
				</p>
			{:else}
				<ul class="m-0 p-0 list-none flex flex-col gap-1">
					{#each entry.ports as port, index (`${port.protocol}:${port.hostPort}:${port.containerPort}:${index}`)}
						<li class="font-mono text-[11px] text-slate-600 dark:text-slate-400 break-all">
							{#if port.hostPort === null}
								<!-- Exposed but not published: reachable from the container
								     network and nowhere else, which is worth saying. And with
								     no host port there is no row in the port table to open. -->
								{port.containerPort}/{port.protocol} · inside the container network only
							{:else}
								<button
									type="button"
									class="inline-flex items-center gap-1 text-left rounded px-1 -mx-1 py-0.5
										hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900
										dark:hover:text-slate-200 transition-colors cursor-pointer"
									title="Show {port.hostAddress ?? '*'}:{port.hostPort} in the port table"
									onclick={() => openPort(port)}
								>
									{port.hostAddress ?? '*'}:{port.hostPort} → {port.containerPort}/{port.protocol}
									<Icon name="lucide:arrow-up-right" class="w-3 h-3 shrink-0 opacity-60" />
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if isUp}
			<section class="flex flex-col gap-1.5">
				<div class="flex items-center justify-between gap-2">
					<h4 class="m-0 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
						Resource use
					</h4>
					<button
						type="button"
						class="flex items-center gap-1 text-[11px] text-violet-600 dark:text-violet-400 bg-transparent border-none cursor-pointer p-0 disabled:opacity-40"
						onclick={() => void containersStore.loadStats(entry.id)}
						disabled={statsLoading}
					>
						<Icon
							name={statsLoading ? 'lucide:loader-circle' : 'lucide:refresh-cw'}
							class="w-3 h-3 {statsLoading ? 'animate-spin' : ''}"
						/>
						{stats ? 'Refresh' : 'Measure'}
					</button>
				</div>
				{#if stats}
					<dl class="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
						<dt class="text-slate-500 dark:text-slate-500">CPU</dt>
						<dd class="m-0 text-slate-700 dark:text-slate-300">
							{stats.cpuPercent === null ? 'unknown' : `${stats.cpuPercent}%`}
						</dd>
						<dt class="text-slate-500 dark:text-slate-500">Memory</dt>
						<dd class="m-0 text-slate-700 dark:text-slate-300">
							{stats.memoryUsage ?? 'unknown'}{stats.memoryPercent === null
								? ''
								: ` · ${stats.memoryPercent}%`}
						</dd>
						<dt class="text-slate-500 dark:text-slate-500">Network</dt>
						<dd class="m-0 text-slate-700 dark:text-slate-300">{stats.networkIO ?? 'unknown'}</dd>
						<dt class="text-slate-500 dark:text-slate-500">Disk</dt>
						<dd class="m-0 text-slate-700 dark:text-slate-300">{stats.blockIO ?? 'unknown'}</dd>
						<dt class="text-slate-500 dark:text-slate-500">Processes</dt>
						<dd class="m-0 text-slate-700 dark:text-slate-300">{stats.pids ?? 'unknown'}</dd>
					</dl>
				{:else}
					<!-- Sampled on request rather than polled: `stats` measures over a
					     window and takes a second, which a live table cannot afford. -->
					<p class="m-0 text-xs text-slate-500 dark:text-slate-500">
						One sample, taken when you ask for it — it costs the host about a second.
					</p>
				{/if}
			</section>
		{/if}

		{#if detail}
			{#if detail.networks.length > 0}
				<section class="flex flex-col gap-1.5">
					<h4 class="m-0 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
						Networks
					</h4>
					<ul class="m-0 p-0 list-none flex flex-col gap-1">
						{#each detail.networks as network (network.name)}
							<li class="text-[11px] text-slate-600 dark:text-slate-400 break-all">
								{network.name}
								<span class="font-mono text-slate-400 dark:text-slate-600">
									{network.ipAddress ?? 'no address'}
								</span>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			{#if detail.mounts.length > 0}
				<section class="flex flex-col gap-1.5">
					<h4 class="m-0 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
						Mounts
					</h4>
					<ul class="m-0 p-0 list-none flex flex-col gap-1.5">
						{#each detail.mounts as mount (mount.destination)}
							<li class="flex flex-col">
								<span class="font-mono text-[11px] text-slate-600 dark:text-slate-400 break-all">
									{mount.destination}{mount.readOnly ? ' (read-only)' : ''}
								</span>
								<span class="font-mono text-[11px] text-slate-400 dark:text-slate-600 break-all">
									{mount.kind} · {mount.source}
								</span>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			{#if detail.env.length > 0}
				<section class="flex flex-col gap-1.5">
					<div class="flex items-center justify-between gap-2">
						<h4 class="m-0 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
							Environment ({detail.env.length})
						</h4>
						{#if !containersStore.envRedacted}
							<button
								type="button"
								class="text-[11px] text-violet-600 dark:text-violet-400 bg-transparent border-none cursor-pointer p-0"
								onclick={() => (showEnv = !showEnv)}
							>
								{showEnv ? 'Hide values' : 'Show values'}
							</button>
						{/if}
					</div>
					{#if containersStore.envRedacted}
						<p class="m-0 text-xs text-slate-500 dark:text-slate-500">
							Values are hidden. A container's environment is where its credentials live, so only
							an admin can read them.
						</p>
					{/if}
					<ul class="m-0 p-0 list-none flex flex-col gap-0.5">
						{#each detail.env as line, index (`${line}:${index}`)}
							{@const split = line.indexOf('=')}
							{@const key = split > 0 ? line.slice(0, split) : line}
							{@const value = split > 0 ? line.slice(split + 1) : ''}
							<li class="font-mono text-[11px] text-slate-600 dark:text-slate-400 break-all">
								{key}<span class="text-slate-400 dark:text-slate-600">
									= {showEnv && value ? value : value ? '••••••' : ''}
								</span>
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		{:else if containersStore.detailLoading}
			<div class="flex items-center gap-2 text-xs text-slate-400">
				<Icon name="lucide:loader-circle" class="flex-none w-3.5 h-3.5 animate-spin" />
				Reading the container…
			</div>
		{/if}
	</div>
</aside>
