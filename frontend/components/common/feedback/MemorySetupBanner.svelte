<script lang="ts">
	/**
	 * "Memory needs one more thing before it works."
	 *
	 * Shaped after UpdateBanner, deliberately: same strip, same placement, same
	 * grammar of one sentence plus one action. A second banner style would make the
	 * app look like it had two different ideas about how to talk to the user.
	 *
	 * It exists because the failure it reports is INVISIBLE otherwise. Memory
	 * records in the background and recalls without being asked, so an artifact
	 * that never downloaded looks exactly like a workspace with nothing worth
	 * remembering yet — the user has no reason to suspect anything and no page to
	 * check. Everything else in the feature is silent by design, which is what
	 * makes one loud line necessary here.
	 *
	 * Recording is NOT blocked while this shows (see backend/memory/readiness.ts),
	 * so the copy avoids implying the user is losing anything by waiting. What they
	 * are missing is recall, and that arrives complete once the download lands.
	 */
	import { onMount } from 'svelte';
	import { slide } from 'svelte/transition';
	import { memoryReadinessStore } from '$frontend/stores/features/memory-readiness.svelte';
	import { openSettingsModal } from '$frontend/stores/ui/settings-modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';

	onMount(() => memoryReadinessStore.subscribe());

	const readiness = $derived(memoryReadinessStore.readiness);
	const embedding = $derived(readiness?.embedding);
	const show = $derived(memoryReadinessStore.showBanner);

	/** Downloading is its own state: a progress bar, no action, no dismiss. */
	const downloading = $derived(embedding?.phase === 'downloading' || memoryReadinessStore.installing);

	const percent = $derived(
		embedding && embedding.totalBytes > 0
			? Math.min(100, Math.round((embedding.receivedBytes / embedding.totalBytes) * 100))
			: 0
	);

	/**
	 * One sentence saying what is missing, in the user's terms.
	 *
	 * "Embedding artifact" is what the code calls it and means nothing to anyone
	 * else, so it is described by what it does rather than what it is.
	 */
	const message = $derived.by(() => {
		if (!readiness) return '';
		if (downloading) return `Preparing memory · ${percent}%`;

		if (embedding && !embedding.ready) {
			if (embedding.failure === 'unpublished') return 'Memory model unavailable for this build';
			if (embedding.failure === 'corrupt') return 'Memory model failed verification';
			if (embedding.phase === 'waiting') return 'Memory model download failed';
			return 'Memory needs a one-time download to recall';
		}

		if (!readiness.model.configured) return 'Memory has no model set — nothing is being recorded';
		return '';
	});

	/**
	 * Recording keeps working during the download, which is worth saying — but the
	 * banner is one strip of chrome, not a paragraph. Kept to a clause, and dropped
	 * entirely below `sm` where it would wrap the row onto a second line.
	 */
	const reassurance = $derived(
		readiness?.canRecord && !readiness?.canRecall ? 'Recording continues' : null
	);

	function openSettings(): void {
		openSettingsModal('memory-graph');
	}
</script>

{#if show && message}
	<div
		transition:slide={{ duration: 300 }}
		class="flex items-center justify-center gap-2 px-4 py-1.5 text-sm font-medium
			{embedding?.failure === 'corrupt' || embedding?.failure === 'unpublished'
				? 'bg-red-600 text-white'
				: downloading
					? 'bg-sky-600 text-white'
					: 'bg-amber-600 text-white'}"
		role="status"
		aria-live="polite"
	>
		{#if downloading}
			<Icon name="lucide:loader-circle" class="w-4 h-4 animate-spin" />
		{:else}
			<Icon name="lucide:brain" class="w-4 h-4" />
		{/if}

		<span>{message}</span>

		{#if reassurance}
			<span class="hidden sm:inline opacity-70 font-normal">· {reassurance}</span>
		{/if}

		{#if downloading}
			<!-- No action and no dismiss while bytes are moving: the only useful thing
			     the user can do is wait, and offering a button implies otherwise. -->
			<span class="ml-1 h-1 w-24 rounded-full bg-white/25 overflow-hidden" aria-hidden="true">
				<span class="block h-full bg-white transition-all duration-500" style="width: {percent}%"></span>
			</span>
		{:else if embedding && !embedding.ready}
			<button
				onclick={() => memoryReadinessStore.install()}
				class="ml-1 px-2 py-0.5 text-xs font-semibold rounded bg-white/20 hover:bg-white/30 transition-colors"
			>
				{embedding.attempts > 0 ? 'Try again' : 'Download now'}
			</button>
			<button
				onclick={() => memoryReadinessStore.dismiss()}
				class="ml-1 px-1.5 py-0.5 text-xs rounded bg-white/10 hover:bg-white/20 transition-colors"
				aria-label="Dismiss"
			>
				<Icon name="lucide:x" class="w-3 h-3" />
			</button>
		{:else}
			<button
				onclick={openSettings}
				class="ml-1 px-2 py-0.5 text-xs font-semibold rounded bg-white/20 hover:bg-white/30 transition-colors"
			>
				Open settings
			</button>
			<button
				onclick={() => memoryReadinessStore.dismiss()}
				class="ml-1 px-1.5 py-0.5 text-xs rounded bg-white/10 hover:bg-white/20 transition-colors"
				aria-label="Dismiss"
			>
				<Icon name="lucide:x" class="w-3 h-3" />
			</button>
		{/if}
	</div>
{/if}
