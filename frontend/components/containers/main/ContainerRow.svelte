<!--
	Containers — one container.

	The row answers the three questions a list is opened for: is it up, what is
	it, and where can I reach it. Everything else — the mounts, the networks, the
	environment, the full command — lives in the detail pane, so the row stays
	readable on a phone where only the first two columns survive.
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { ContainerEntry } from '$shared/types/containers';

	interface Props {
		entry: ContainerEntry;
		selected: boolean;
		busy: boolean;
		/** Admin: starting and stopping is theirs alone. */
		canManage: boolean;
		onSelect: () => void;
		onToggle: () => void;
		onLogs: () => void;
	}

	const { entry, selected, busy, canManage, onSelect, onToggle, onLogs }: Props = $props();

	const isUp = $derived(entry.state === 'running' || entry.state === 'paused');

	const accent = $derived(
		entry.health === 'unhealthy'
			? 'text-red-600 dark:text-red-400'
			: entry.state === 'running'
				? 'text-emerald-600 dark:text-emerald-400'
				: entry.state === 'paused'
					? 'text-amber-600 dark:text-amber-400'
					: entry.state === 'restarting'
						? 'text-sky-600 dark:text-sky-400'
						: entry.state === 'dead'
							? 'text-red-600 dark:text-red-400'
							: 'text-slate-400 dark:text-slate-500'
	);

	/** Published ports, shortest useful form: the host port is what is reachable. */
	const published = $derived(entry.ports.filter((port) => port.hostPort !== null));
</script>

<div
	class="group flex items-center gap-2.5 sm:gap-3 px-2.5 sm:px-3 py-2 rounded-lg border transition-colors
		{selected
		? 'bg-violet-500/10 border-violet-500/30'
		: 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-violet-500/30'}"
>
	<button
		type="button"
		class="flex items-center gap-2.5 sm:gap-3 flex-1 min-w-0 bg-transparent border-none p-0 text-left cursor-pointer"
		onclick={onSelect}
	>
		<Icon name="lucide:container" class="w-4 h-4 shrink-0 {accent}" />

		<span class="flex flex-col min-w-0 flex-1">
			<span class="flex items-center gap-1.5 min-w-0">
				<span class="truncate text-sm font-medium text-slate-800 dark:text-slate-200">
					{entry.name}
				</span>
				{#if entry.health === 'unhealthy'}
					<span
						class="shrink-0 px-1 py-px rounded text-[9px] font-semibold uppercase tracking-wide bg-red-500/15 text-red-700 dark:text-red-400"
						title="This container's own healthcheck is failing"
					>
						unhealthy
					</span>
				{:else if entry.health === 'healthy'}
					<span
						class="shrink-0 w-1.5 h-1.5 rounded-full bg-emerald-500"
						title="This container's healthcheck is passing"
					></span>
				{:else if entry.health === 'starting'}
					<span
						class="shrink-0 px-1 py-px rounded text-[9px] font-semibold uppercase tracking-wide bg-amber-500/15 text-amber-700 dark:text-amber-400"
						title="The healthcheck has not passed yet"
					>
						starting
					</span>
				{/if}
				{#if entry.composeProject}
					<span
						class="hidden sm:inline shrink-0 px-1 py-px rounded text-[9px] font-semibold uppercase tracking-wide bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
						title="Part of the {entry.composeProject} compose project"
					>
						{entry.composeProject}
					</span>
				{/if}
			</span>
			<span class="truncate text-xs text-slate-500 dark:text-slate-500">
				{entry.image}
			</span>
		</span>

		<span class="hidden md:flex flex-col items-end shrink-0 w-40 lg:w-52">
			<span class="text-[11px] text-slate-500 dark:text-slate-500 truncate max-w-full">
				{entry.statusText}
			</span>
			<span class="font-mono text-[11px] text-slate-400 dark:text-slate-600 truncate max-w-full">
				{#if published.length > 0}
					{published
						.slice(0, 2)
						.map((port) => `${port.hostPort}→${port.containerPort}`)
						.join(' ')}{#if published.length > 2}
						+{published.length - 2}{/if}
				{:else}
					{entry.shortId}
				{/if}
			</span>
		</span>
	</button>

	<!-- On a phone the status has nowhere to live in the row, so it rides here
	     instead of vanishing: it is the one fact the list exists to show. -->
	<span class="md:hidden shrink-0 text-[11px] text-slate-400 dark:text-slate-600 max-w-24 truncate">
		{entry.statusText}
	</span>

	<button
		type="button"
		class="hidden sm:flex shrink-0 items-center justify-center w-7 h-7 rounded-md border-none bg-transparent text-slate-400 cursor-pointer transition-colors hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400"
		onclick={onLogs}
		title="Follow this container's logs"
		aria-label="Follow logs for {entry.name}"
	>
		<Icon name="lucide:scroll-text" class="w-3.5 h-3.5" />
	</button>

	{#if canManage && entry.canManage}
		<button
			type="button"
			class="shrink-0 flex items-center justify-center w-7 h-7 rounded-md border-none bg-transparent cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-wait
				{isUp
				? 'text-slate-400 hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400'
				: 'text-slate-400 hover:bg-emerald-500/10 hover:text-emerald-600 dark:hover:text-emerald-400'}"
			onclick={onToggle}
			disabled={busy}
			title={isUp ? 'Stop this container' : 'Start this container'}
			aria-label={isUp ? `Stop ${entry.name}` : `Start ${entry.name}`}
		>
			<Icon
				name={busy ? 'lucide:loader-circle' : isUp ? 'lucide:square' : 'lucide:play'}
				class="w-3.5 h-3.5 {busy ? 'animate-spin' : ''}"
			/>
		</button>
	{:else if !canManage}
		<span
			class="shrink-0 flex items-center justify-center w-7 h-7 text-slate-300 dark:text-slate-700"
			title="Only an admin can start or stop a container"
		>
			<Icon name="lucide:lock" class="w-3.5 h-3.5" />
		</span>
	{/if}
</div>
