<script lang="ts">
	/**
	 * Storage buckets, read from `storage.buckets`.
	 *
	 * SQL rather than the Management API, and not only for the local-stack
	 * reason: the table carries the size limit and the allowed MIME types, which
	 * the API's bucket listing does not, and those are the two settings anyone
	 * opens this tab to check.
	 *
	 * Objects are NOT listed. Reading them needs the service-role key — a key
	 * that bypasses every policy in the database — and storing one to render a
	 * file browser would be a poor trade for a read-only view.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import InlineError from '$frontend/components/common/display/InlineError.svelte';
	import { dbAccountsStore } from '$frontend/stores/features/db-client-accounts.svelte';

	interface Props {
		connectionId: string;
	}

	const { connectionId }: Props = $props();

	const cell = $derived(dbAccountsStore.bucketsFor(connectionId));
	const buckets = $derived(cell.data ?? []);

	$effect(() => {
		dbAccountsStore.ensureBuckets(connectionId);
	});

	/** Bytes as the unit a size limit is normally written in. */
	function formatSize(bytes: number | null): string | null {
		if (bytes === null) return null;
		const units = ['B', 'KB', 'MB', 'GB'];
		let value = bytes;
		let unit = 0;
		while (value >= 1024 && unit < units.length - 1) {
			value /= 1024;
			unit += 1;
		}
		return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
	}
</script>

<div class="flex flex-col gap-3 p-3">
	{#if cell.loading && buckets.length === 0}
		<div class="flex flex-col gap-1.5">
			{#each [0, 1] as row (row)}
				<div class="h-12 rounded-lg bg-slate-100 dark:bg-slate-800/60 animate-pulse"></div>
			{/each}
		</div>
	{:else if cell.error}
		<InlineError message={cell.error} />
	{:else if buckets.length === 0}
		<div class="flex flex-col items-center gap-2 py-10 text-center">
			<Icon name="lucide:folder" class="w-8 h-8 text-slate-300 dark:text-slate-600" />
			<p class="text-sm text-slate-500 dark:text-slate-400">No storage buckets.</p>
		</div>
	{:else}
		<div class="flex flex-col gap-1">
			{#each buckets as bucket (bucket.id)}
				<div class="flex items-start gap-3 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 min-w-0">
					<Icon
						name={bucket.isPublic ? 'lucide:folder-open' : 'lucide:folder-lock'}
						class="w-4 h-4 mt-0.5 shrink-0 {bucket.isPublic ? 'text-amber-500' : 'text-slate-400'}"
					/>
					<div class="flex flex-col gap-0.5 min-w-0 flex-1">
						<span class="text-sm text-slate-800 dark:text-slate-200 truncate">{bucket.name}</span>
						<span class="text-xs text-slate-500 dark:text-slate-400 truncate">
							{bucket.objectCount ?? 0} {bucket.objectCount === 1 ? 'object' : 'objects'}
							{#if formatSize(bucket.fileSizeLimit)}· max {formatSize(bucket.fileSizeLimit)}{/if}
							{#if bucket.allowedMimeTypes?.length}· {bucket.allowedMimeTypes.join(', ')}{/if}
						</span>
					</div>
					<span
						class="text-3xs px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider shrink-0
							{bucket.isPublic
								? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
								: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'}"
					>
						{bucket.isPublic ? 'Public' : 'Private'}
					</span>
				</div>
			{/each}
		</div>
	{/if}
</div>
