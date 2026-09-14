<script lang="ts">
	/**
	 * Row-level security: which tables have it, what the policies say, and what
	 * Supabase's own advisor thinks.
	 *
	 * Tables come first and policies hang under them, because the dangerous
	 * states are properties of a TABLE rather than of a policy: RLS off in a
	 * public schema, and RLS on with no policy at all (which locks everyone out
	 * and looks like a broken app rather than a security setting). A flat policy
	 * list cannot show either — neither has a policy row to show.
	 *
	 * The advisor is the only account-only part, and it degrades on its own: its
	 * failure never takes the policy list with it.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import InlineError from '$frontend/components/common/display/InlineError.svelte';
	import { dbAccountsStore } from '$frontend/stores/features/db-client-accounts.svelte';
	import type { SupabaseAdvisorLint, SupabasePolicy, SupabaseTableRls } from '$shared/types/db-client';

	interface Props {
		connectionId: string;
	}

	const { connectionId }: Props = $props();

	let expanded = $state<Record<string, boolean>>({});
	let showLints = $state(true);

	const cell = $derived(dbAccountsStore.rlsFor(connectionId));
	const report = $derived(cell.data);

	$effect(() => {
		dbAccountsStore.ensureRls(connectionId);
	});

	function key(table: SupabaseTableRls): string {
		return `${table.schema}.${table.table}`;
	}

	const policiesByTable = $derived.by(() => {
		const map = new Map<string, SupabasePolicy[]>();
		for (const policy of report?.policies ?? []) {
			const id = `${policy.schema}.${policy.table}`;
			const list = map.get(id) ?? [];
			list.push(policy);
			map.set(id, list);
		}
		return map;
	});

	/**
	 * Tables worth worrying about, listed first.
	 *
	 * Sorting by risk rather than alphabetically is the point of the tab: a
	 * hundred tables in name order buries the two that are exposed.
	 */
	const tables = $derived.by(() => {
		const list = [...(report?.tables ?? [])];
		const risk = (table: SupabaseTableRls): number => {
			if (!table.rlsEnabled) return 0;
			if (table.policyCount === 0) return 1;
			return 2;
		};
		return list.sort((a, b) => risk(a) - risk(b) || key(a).localeCompare(key(b)));
	});

	const lintClass: Record<string, string> = {
		ERROR: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
		WARN: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
		INFO: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
	};

	function lintTone(lint: SupabaseAdvisorLint): string {
		return lintClass[lint.level.toUpperCase()] ?? lintClass.INFO;
	}
</script>

<div class="flex flex-col gap-3 p-3">
	{#if cell.loading && !report}
		<div class="flex flex-col gap-1.5">
			{#each [0, 1, 2, 3] as row (row)}
				<div class="h-10 rounded-lg bg-slate-100 dark:bg-slate-800/60 animate-pulse"></div>
			{/each}
		</div>
	{:else if cell.error}
		<InlineError message={cell.error} />
	{:else if report}
		<!-- Advisor -->
		{#if report.lints.length > 0}
			<div class="flex flex-col gap-1.5">
				<button
					type="button"
					class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 cursor-pointer"
					onclick={() => (showLints = !showLints)}
				>
					<Icon name={showLints ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3.5 h-3.5" />
					Security advisor · {report.lints.length}
				</button>
				{#if showLints}
					<div class="flex flex-col gap-1">
						{#each report.lints as lint, index (`${lint.name}-${lint.target ?? index}`)}
							<div class="flex items-start gap-2 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800">
								<span class="text-3xs px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider shrink-0 {lintTone(lint)}">
									{lint.level}
								</span>
								<div class="flex flex-col gap-0.5 min-w-0">
									<span class="text-sm text-slate-800 dark:text-slate-200">
										{lint.title}{lint.target ? ` — ${lint.target}` : ''}
									</span>
									{#if lint.detail}
										<span class="text-xs text-slate-500 dark:text-slate-400">{lint.detail}</span>
									{/if}
									{#if lint.remediation}
										<a
											href={lint.remediation}
											target="_blank"
											rel="noopener noreferrer"
											class="text-xs text-violet-600 dark:text-violet-400 hover:underline"
										>
											How to fix this
										</a>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{:else if report.advisorError}
			<p class="px-3 py-2 rounded-md text-xs bg-slate-100 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400">
				{report.advisorError}
			</p>
		{/if}

		<!-- Tables -->
		{#if tables.length === 0}
			<div class="flex flex-col items-center gap-2 py-10 text-center">
				<Icon name="lucide:shield" class="w-8 h-8 text-slate-300 dark:text-slate-600" />
				<p class="text-sm text-slate-500 dark:text-slate-400">No user tables in this database.</p>
			</div>
		{:else}
			<div class="flex flex-col gap-1">
				{#each tables as table (key(table))}
					{@const policies = policiesByTable.get(key(table)) ?? []}
					{@const isOpen = expanded[key(table)] ?? false}
					<div class="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
						<button
							type="button"
							class="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer min-w-0"
							onclick={() => (expanded = { ...expanded, [key(table)]: !isOpen })}
						>
							<Icon
								name={isOpen ? 'lucide:chevron-down' : 'lucide:chevron-right'}
								class="w-3.5 h-3.5 text-slate-400 shrink-0 {policies.length === 0 ? 'opacity-30' : ''}"
							/>
							<span class="text-sm text-slate-800 dark:text-slate-200 truncate">
								<span class="text-slate-400">{table.schema}.</span>{table.table}
							</span>

							{#if !table.rlsEnabled}
								<span class="ml-auto text-3xs px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider shrink-0 bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
									RLS off
								</span>
							{:else if table.policyCount === 0}
								<span class="ml-auto text-3xs px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider shrink-0 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
									No policies
								</span>
							{:else}
								<span class="ml-auto text-3xs uppercase tracking-wider text-slate-400 shrink-0">
									{table.policyCount} {table.policyCount === 1 ? 'policy' : 'policies'}
								</span>
							{/if}
						</button>

						{#if isOpen && policies.length > 0}
							<div class="flex flex-col divide-y divide-slate-100 dark:divide-slate-800 border-t border-slate-100 dark:border-slate-800">
								{#each policies as policy (policy.name)}
									<div class="flex flex-col gap-1 px-3 py-2 bg-slate-50/60 dark:bg-slate-900/40">
										<div class="flex items-center gap-2 min-w-0">
											<span class="text-xs font-semibold text-slate-700 dark:text-slate-300 truncate">
												{policy.name}
											</span>
											<span class="text-3xs px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 shrink-0">
												{policy.command}
											</span>
											{#if policy.permissive === 'RESTRICTIVE'}
												<span class="text-3xs px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 shrink-0">
													restrictive
												</span>
											{/if}
											{#if policy.roles.length > 0}
												<span class="text-3xs text-slate-400 truncate">{policy.roles.join(', ')}</span>
											{/if}
										</div>
										{#if policy.using}
											<code class="text-xs font-mono text-slate-600 dark:text-slate-400 wrap-anywhere">
												USING {policy.using}
											</code>
										{/if}
										{#if policy.withCheck}
											<code class="text-xs font-mono text-slate-600 dark:text-slate-400 wrap-anywhere">
												WITH CHECK {policy.withCheck}
											</code>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>
