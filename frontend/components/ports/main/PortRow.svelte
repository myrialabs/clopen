<!--
	Port manager — one port.

	The origin tier decides how much the row asserts. A port Clopen opened is
	named outright; a guessed one shows its label beside the command it was
	guessed from, so the user can overrule it at a glance.
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { PortEntry } from '$shared/types/ports';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		entry: PortEntry;
		selected: boolean;
		killing: boolean;
		canKill: boolean;
		onSelect: () => void;
		onKill: () => void;
	}

	const { entry, selected, killing, canKill, onSelect, onKill }: Props = $props();

	const icon = $derived<IconName>(
		entry.origin.kind === 'clopen'
			? 'lucide:shield-check'
			: entry.origin.kind === 'session'
				? 'lucide:terminal'
				: 'lucide:circle-question-mark'
	);

	const accent = $derived(
		entry.origin.kind === 'clopen'
			? 'text-violet-600 dark:text-violet-400'
			: entry.origin.kind === 'session'
				? 'text-sky-600 dark:text-sky-400'
				: 'text-slate-400 dark:text-slate-500'
	);

	/** Why the stop button is absent, in the user's terms rather than a code. */
	const blockedReason = $derived(
		entry.killBlockedReason === 'is-clopen-itself'
			? 'This is Clopen itself'
			: entry.killBlockedReason === 'unknown-pid'
				? 'Owner not visible without elevated privileges'
				: entry.killBlockedReason === 'not-permitted'
					? `Owned by ${entry.process?.user ?? 'another user'}`
					: entry.killBlockedReason === 'system-process'
						? 'System process'
						: null
	);
</script>

<div
	class="group flex items-center gap-3 px-3 py-2 rounded-lg border transition-colors
		{selected
		? 'bg-violet-500/10 border-violet-500/30'
		: 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-violet-500/30'}"
>
	<button
		type="button"
		class="flex items-center gap-3 flex-1 min-w-0 bg-transparent border-none p-0 text-left cursor-pointer"
		onclick={onSelect}
	>
		<Icon name={icon} class="w-4 h-4 shrink-0 {accent}" />

		<span class="w-24 shrink-0 font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
			{entry.port}
			<span class="text-[10px] font-normal text-slate-400 dark:text-slate-500 uppercase">
				{entry.protocol}
			</span>
		</span>

		<span class="flex flex-col min-w-0 flex-1">
			<span class="flex items-center gap-1.5 min-w-0">
				<span class="truncate text-sm font-medium text-slate-800 dark:text-slate-200">
					{entry.origin.label}
				</span>
				{#if entry.origin.confidence === 'guess'}
					<!-- Never dress a guess as a fact: the badge is the whole point. -->
					<span
						class="shrink-0 px-1 py-px rounded text-[9px] font-semibold uppercase tracking-wide bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
						title="Inferred from the command line — it may be wrong"
					>
						guess
					</span>
				{/if}
				{#if entry.publicUrl}
					<span
						class="shrink-0 px-1 py-px rounded text-[9px] font-semibold uppercase tracking-wide bg-amber-500/15 text-amber-700 dark:text-amber-400"
						title="Reachable from the public internet via {entry.publicUrl}"
					>
						public
					</span>
				{/if}
			</span>
			{#if entry.origin.detail}
				<span class="truncate text-xs text-slate-500 dark:text-slate-500">
					{entry.origin.detail}
				</span>
			{/if}
		</span>

		<span class="hidden sm:flex flex-col items-end shrink-0 w-28">
			<span class="text-[11px] text-slate-500 dark:text-slate-500 truncate max-w-full">
				{entry.addresses.join(', ')}
			</span>
			<span class="text-[11px] text-slate-400 dark:text-slate-600">
				{#if entry.pid === null}
					owner unknown
				{:else}
					pid {entry.pid}{#if entry.workerPids.length > 1}
						· {entry.workerPids.length} workers{/if}
				{/if}
			</span>
		</span>

		{#if entry.peerCount > 0}
			<span
				class="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-[11px] font-semibold"
				title="{entry.peerCount} connection{entry.peerCount === 1 ? '' : 's'} open to this port"
			>
				<Icon name="lucide:arrow-right-left" class="w-3 h-3" />
				{entry.peerCount}
			</span>
		{/if}
	</button>

	{#if entry.canKill && canKill}
		<button
			type="button"
			class="shrink-0 flex items-center justify-center w-7 h-7 rounded-md border-none bg-transparent text-slate-400 cursor-pointer transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50 disabled:cursor-wait"
			onclick={onKill}
			disabled={killing}
			title="Stop whatever is holding this port"
			aria-label="Stop port {entry.port}"
		>
			<Icon name={killing ? 'lucide:loader-circle' : 'lucide:square'} class="w-3.5 h-3.5 {killing ? 'animate-spin' : ''}" />
		</button>
	{:else if blockedReason}
		<span
			class="shrink-0 flex items-center justify-center w-7 h-7 text-slate-300 dark:text-slate-700"
			title={blockedReason}
		>
			<Icon name="lucide:lock" class="w-3.5 h-3.5" />
		</span>
	{/if}
</div>
