<!--
	Port manager — everything known about one port.

	The table answers "what is this"; this answers "and how do you know". The
	full command, the working directory, the process lineage and the peers that
	are actually connected all live here, including the fields the host could
	not supply — shown as unknown rather than quietly omitted.
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { portsStore } from '$frontend/stores/features/ports.svelte';
	import { containersStore } from '$frontend/stores/features/containers.svelte';
	import { sshClientStore } from '$frontend/stores/features/ssh-client.svelte';
	import { closePortsDialog, openContainersDialog } from '$frontend/stores/ui/quick-panels.svelte';
	import { LOCAL_PORT_HOST, type PortEntry } from '$shared/types/ports';

	interface Props {
		entry: PortEntry;
		onClose: () => void;
		/** Rendered as a bottom sheet on small screens rather than a side panel. */
		sheet?: boolean;
	}

	const { entry, onClose, sheet = false }: Props = $props();

	const started = $derived(
		entry.process?.startedAt ? new Date(entry.process.startedAt).toLocaleString() : null
	);

	const tier = $derived(
		entry.origin.kind === 'clopen'
			? 'Clopen opened this listener, so this is exact.'
			: entry.origin.kind === 'session'
				? 'Traced through the process tree — the lineage is certain.'
				: entry.origin.kind === 'container'
					? 'The container runtime publishes this port, so the owner is exact. Whatever holds the socket is the runtime’s own proxy, not the server you are looking for.'
					: 'Inferred from the command line. Clopen did not start this, so treat the label as a guess.'
	);

	/**
	 * Jump to this port's container. The panel and the SSH Client tab are the
	 * same view, so which one to open follows from which host the row is on.
	 */
	function openContainer(): void {
		if (!entry.container) return;
		const hostId = portsStore.activeHostId;
		containersStore.focus(hostId, entry.container.id);
		if (hostId === LOCAL_PORT_HOST) {
			closePortsDialog();
			openContainersDialog();
			return;
		}
		sshClientStore.setView(hostId, 'containers');
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
			<p class="m-0 font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
				{entry.protocol}/{entry.port}
			</p>
			<p class="m-0 text-xs text-slate-500 dark:text-slate-500 truncate">{entry.origin.label}</p>
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

	<div class="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
		<section class="flex flex-col gap-1">
			<h4 class="m-0 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
				How this was identified
			</h4>
			<p class="m-0 text-xs text-slate-600 dark:text-slate-400">{tier}</p>
			{#if entry.origin.detail}
				<p class="m-0 text-xs text-slate-500 dark:text-slate-500">{entry.origin.detail}</p>
			{/if}
		</section>

		{#if entry.container}
			<section class="flex flex-col gap-1.5 p-2.5 rounded-lg bg-blue-500/10">
				<h4 class="m-0 text-[11px] font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-400">
					Published by a container
				</h4>
				<p class="m-0 text-xs text-blue-800 dark:text-blue-300 break-all">
					{entry.container.name} · {entry.container.image} · container port
					{entry.container.containerPort}
				</p>
				<button
					type="button"
					class="flex items-center gap-1.5 self-start mt-0.5 px-2 h-7 rounded-md bg-blue-500/15 border-none text-[11px] font-semibold text-blue-800 dark:text-blue-300 cursor-pointer hover:bg-blue-500/25"
					onclick={openContainer}
				>
					<Icon name="lucide:container" class="w-3.5 h-3.5" />
					Open in Containers
				</button>
			</section>
		{/if}

		{#if entry.publicUrl}
			<section class="flex flex-col gap-1 p-2.5 rounded-lg bg-amber-500/10">
				<h4 class="m-0 text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
					Reachable from the internet
				</h4>
				<!-- A tunnel dials this port, it does not own it — so this is stated
				     as exposure, separate from whoever is listening. -->
				<p class="m-0 text-xs text-amber-800 dark:text-amber-300 break-all">{entry.publicUrl}</p>
			</section>
		{/if}

		<section class="flex flex-col gap-1.5">
			<h4 class="m-0 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Binding</h4>
			<dl class="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
				<dt class="text-slate-500 dark:text-slate-500">Addresses</dt>
				<dd class="m-0 font-mono text-slate-700 dark:text-slate-300 break-all">
					{entry.addresses.join(', ')}
				</dd>
				<dt class="text-slate-500 dark:text-slate-500">IP</dt>
				<dd class="m-0 text-slate-700 dark:text-slate-300">
					{entry.ipVersions.map((version) => (version === 'v4' ? 'IPv4' : 'IPv6')).join(' + ')}
				</dd>
			</dl>
		</section>

		<section class="flex flex-col gap-1.5">
			<h4 class="m-0 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Process</h4>
			{#if entry.pid === null && entry.container}
				<p class="m-0 text-xs text-slate-500 dark:text-slate-500">
					Nothing is listening on this port. The runtime forwards it into the
					container through a firewall rule instead, which is why no process
					holds it — the port is still reachable.
				</p>
			{:else if entry.pid === null}
				<p class="m-0 text-xs text-slate-500 dark:text-slate-500">
					This host did not name the owning process. On Linux the kernel only
					reveals it for your own processes.
				</p>
			{:else}
				<dl class="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
					<dt class="text-slate-500 dark:text-slate-500">PID</dt>
					<dd class="m-0 font-mono text-slate-700 dark:text-slate-300">{entry.pid}</dd>

					{#if entry.workerPids.length > 1}
						<dt class="text-slate-500 dark:text-slate-500">Workers</dt>
						<dd class="m-0 font-mono text-slate-700 dark:text-slate-300">
							{entry.workerPids.length} sharing this port
						</dd>
					{/if}

					<dt class="text-slate-500 dark:text-slate-500">User</dt>
					<dd class="m-0 text-slate-700 dark:text-slate-300">
						{entry.process?.user ?? 'unknown'}
					</dd>

					<dt class="text-slate-500 dark:text-slate-500">Started</dt>
					<dd class="m-0 text-slate-700 dark:text-slate-300">{started ?? 'unknown'}</dd>

					<dt class="text-slate-500 dark:text-slate-500">Directory</dt>
					<dd class="m-0 font-mono text-slate-700 dark:text-slate-300 break-all">
						{entry.process?.cwd ?? 'not available on this host'}
					</dd>
				</dl>

				{#if entry.process?.command}
					<p
						class="m-0 mt-1 p-2 rounded-md bg-slate-100 dark:bg-slate-950 font-mono text-[11px] text-slate-600 dark:text-slate-400 break-all"
					>
						{entry.process.command}
					</p>
				{/if}
			{/if}
		</section>

		<section class="flex flex-col gap-1.5">
			<h4 class="m-0 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
				Connected now ({entry.peerCount})
			</h4>
			{#if entry.peers.length === 0}
				<p class="m-0 text-xs text-slate-500 dark:text-slate-500">Nothing is connected to this port.</p>
			{:else}
				<ul class="m-0 p-0 list-none flex flex-col gap-1">
					{#each entry.peers.slice(0, 20) as peer, index (`${peer.address}:${peer.port}:${index}`)}
						<li class="font-mono text-[11px] text-slate-600 dark:text-slate-400 break-all">
							{peer.address}:{peer.port}
						</li>
					{/each}
				</ul>
				{#if entry.peers.length > 20}
					<p class="m-0 text-[11px] text-slate-400 dark:text-slate-600">
						and {entry.peers.length - 20} more
					</p>
				{/if}
			{/if}
		</section>
	</div>
</aside>
