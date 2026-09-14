<script lang="ts">
	/**
	 * Edge functions.
	 *
	 * Read-only, deliberately. Deploying a function means bundling TypeScript and
	 * uploading an archive, which is the CLI's job — offering a button that only
	 * works for the simplest function would be worse than not offering one.
	 *
	 * With an account this lists what is DEPLOYED; without one it lists what is
	 * in `supabase/functions`, which is the only honest answer a local stack can
	 * give. The rows say which they are, because "deployed" and "written" are
	 * different facts and confusing them is how a fix gets declared shipped.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import InlineError from '$frontend/components/common/display/InlineError.svelte';
	import MonacoCodeEditor from '$frontend/components/common/editor/MonacoCodeEditor.svelte';
	import { dbAccountsStore } from '$frontend/stores/features/db-client-accounts.svelte';
	import { shortRelativeTime } from '$frontend/utils/relative-time';
	import type { SupabaseEdgeFunction } from '$shared/types/db-client';

	interface Props {
		connectionId: string;
	}

	const { connectionId }: Props = $props();

	let bodyOpen = $state(false);
	let bodyText = $state('');
	let bodyTitle = $state('');
	let bodyLoading = $state(false);
	let bodyError = $state<string | null>(null);

	const cell = $derived(dbAccountsStore.functionsFor(connectionId));
	const functions = $derived(cell.data ?? []);
	const context = $derived(dbAccountsStore.contextFor(connectionId));

	$effect(() => {
		dbAccountsStore.ensureFunctions(connectionId);
	});

	async function openBody(fn: SupabaseEdgeFunction): Promise<void> {
		bodyTitle = fn.slug;
		bodyText = '';
		bodyError = null;
		bodyLoading = true;
		bodyOpen = true;
		try {
			bodyText = await dbAccountsStore.functionBody(connectionId, fn.slug);
		} catch (error) {
			bodyError = error instanceof Error ? error.message : 'Could not read that function';
		} finally {
			bodyLoading = false;
		}
	}
</script>

<div class="flex flex-col gap-3 p-3">
	{#if cell.loading && functions.length === 0}
		<div class="flex flex-col gap-1.5">
			{#each [0, 1, 2] as row (row)}
				<div class="h-10 rounded-lg bg-slate-100 dark:bg-slate-800/60 animate-pulse"></div>
			{/each}
		</div>
	{:else if cell.error}
		<InlineError message={cell.error} />
	{:else if functions.length === 0}
		<div class="flex flex-col items-center gap-2 py-10 text-center">
			<Icon name="lucide:zap" class="w-8 h-8 text-slate-300 dark:text-slate-600" />
			<p class="text-sm text-slate-500 dark:text-slate-400">
				{#if context?.hasAccount}
					No edge functions deployed to this project.
				{:else}
					No <code>supabase/functions</code> in the open project, and no connected account to ask
					what is deployed.
				{/if}
			</p>
		</div>
	{:else}
		{#if !context?.hasAccount}
			<p class="px-3 py-2 rounded-md text-xs bg-slate-100 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400">
				These are the functions in the working tree. Connect a Supabase account to see what is
				actually deployed.
			</p>
		{/if}

		<div class="flex flex-col gap-1">
			{#each functions as fn (fn.id)}
				<button
					type="button"
					class="flex items-center gap-3 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer min-w-0"
					onclick={() => openBody(fn)}
				>
					<Icon name="lucide:zap" class="w-4 h-4 text-slate-400 shrink-0" />
					<div class="flex flex-col min-w-0 flex-1">
						<span class="text-sm text-slate-800 dark:text-slate-200 truncate">{fn.slug}</span>
						<span class="text-xs text-slate-500 dark:text-slate-400 truncate">
							{#if fn.isLocal}
								Local file
							{:else}
								v{fn.version ?? '?'}
								{#if fn.updatedAt}· updated {shortRelativeTime(fn.updatedAt)}{/if}
								{#if fn.verifyJwt === false}· public{/if}
							{/if}
						</span>
					</div>
					<span
						class="text-3xs px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider shrink-0
							{fn.status === 'ACTIVE'
								? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
								: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'}"
					>
						{fn.status}
					</span>
				</button>
			{/each}
		</div>
	{/if}
</div>

<Modal bind:isOpen={bodyOpen} title={bodyTitle} size="xl" onClose={() => (bodyOpen = false)}>
	<div class="h-[60vh]">
		{#if bodyLoading}
			<div class="flex items-center justify-center h-full text-sm text-slate-500">Loading…</div>
		{:else if bodyError}
			<InlineError message={bodyError} />
		{:else}
			<MonacoCodeEditor value={bodyText} language="typescript" readonly height="100%" />
		{/if}
	</div>
</Modal>
