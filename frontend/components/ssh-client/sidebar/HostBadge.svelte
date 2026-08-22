<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { SshConnection, SshHealth } from '$shared/types/ssh';

	interface Props {
		connection: SshConnection;
		health?: SshHealth;
		active?: boolean;
		onClick?: () => void;
	}

	const { connection, health, active = false, onClick }: Props = $props();

	// Grey until probed, red when the probe failed, amber for the one failure the
	// user can act on: a host key that no longer matches.
	const dotClass = $derived.by(() => {
		if (!health) return 'bg-slate-400';
		if (health.ok) return 'bg-emerald-500';
		if (health.hostKeyChanged) return 'bg-amber-500';
		return 'bg-red-500';
	});

	const authLabel = $derived({
		password: 'password',
		key: 'key',
		'key-file': 'key file',
		agent: 'agent'
	}[connection.authMethod]);

	const subtitle = $derived(
		`${connection.username}@${connection.host}:${connection.port} • ${authLabel}`
	);
</script>

<!--
	Background-less on purpose: the active and hover fills live on the row wrapper
	in HostList, so the highlight spans the row's whole width including the edit
	and delete buttons rather than stopping short of them.
-->
<button
	type="button"
	class="flex items-center gap-2 w-full px-2 py-1.5 text-left cursor-pointer transition-colors
		{active ? 'text-violet-700 dark:text-violet-300' : 'text-slate-700 dark:text-slate-300'}"
	onclick={onClick}
>
	<div class="relative shrink-0">
		<Icon
			name="lucide:server"
			class="w-4 h-4 {active ? 'text-violet-600 dark:text-violet-400' : 'text-slate-500 dark:text-slate-400'}"
		/>
		<span
			class="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border-2 border-white dark:border-slate-900 {dotClass}"
		></span>
	</div>
	<div class="flex-1 min-w-0">
		<div class="flex items-center gap-1.5">
			<span
				class="text-sm font-medium {active
					? 'text-violet-700 dark:text-violet-300'
					: 'text-slate-900 dark:text-slate-100'} truncate">{connection.name}</span
			>
			{#if connection.jumpConnectionId}
				<span class="text-3xs text-slate-500 dark:text-slate-400 uppercase tracking-wider shrink-0">
					jump
				</span>
			{/if}
		</div>
		<div class="text-[11px] text-slate-500 dark:text-slate-400 truncate">{subtitle}</div>
	</div>
</button>
