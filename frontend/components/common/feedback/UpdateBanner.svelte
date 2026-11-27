<script lang="ts">
	import {
		updateState, runUpdate, dismissUpdate, checkForUpdate, openWhatsNew, releasesBetween
	} from '$frontend/stores/ui/update.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { slide } from 'svelte/transition';

	const showBanner = $derived(
		updateState.pendingRestart ||
		(!updateState.dismissed && (
			updateState.updateAvailable ||
			updateState.updating ||
			updateState.updateSuccess ||
			updateState.error
		))
	);

	const releasesBehind = $derived(
		updateState.releaseNotes && updateState.currentVersion && updateState.latestVersion
			? releasesBetween(updateState.releaseNotes, updateState.currentVersion, updateState.latestVersion).length
			: 0
	);
</script>

{#if showBanner}
	<div
		transition:slide={{ duration: 300 }}
		class="flex items-center justify-center gap-2 px-4 py-1.5 text-sm font-medium
			{updateState.updateSuccess || updateState.pendingRestart
				? 'bg-emerald-600 text-white'
				: updateState.error
					? 'bg-red-600 text-white'
					: updateState.updating
						? 'bg-amber-600 text-white'
						: 'bg-violet-600 text-white'}"
		role="status"
		aria-live="polite"
	>
		{#if updateState.updateSuccess || updateState.pendingRestart}
			<Icon name="lucide:package-check" class="w-4 h-4 shrink-0" />
			<span class="truncate">v{updateState.latestVersion} is installed — restart Clopen to finish</span>
			<button
				onclick={openWhatsNew}
				class="ml-1 shrink-0 px-2 py-0.5 text-xs font-semibold rounded bg-white/20 hover:bg-white/30 transition-colors"
			>
				How to finish
			</button>
		{:else if updateState.error}
			<Icon name="lucide:package-x" class="w-4 h-4 shrink-0" />
			<span class="truncate">{updateState.errorType === 'check' ? 'Unable to check for updates' : 'Update failed'}</span>
			<button
				onclick={updateState.errorType === 'check' ? checkForUpdate : runUpdate}
				class="ml-1 shrink-0 px-2 py-0.5 text-xs font-semibold rounded bg-white/20 hover:bg-white/30 transition-colors"
			>
				{updateState.errorType === 'check' ? 'Check again' : 'Retry'}
			</button>
			<button
				onclick={dismissUpdate}
				class="ml-1 shrink-0 px-1.5 py-0.5 text-xs rounded bg-white/10 hover:bg-white/20 transition-colors"
				aria-label="Dismiss"
			>
				<Icon name="lucide:x" class="w-3 h-3" />
			</button>
		{:else if updateState.updating}
			<Icon name="lucide:loader-circle" class="w-4 h-4 shrink-0 animate-spin" />
			<span class="truncate">Installing v{updateState.latestVersion}…</span>
		{:else}
			<Icon name="lucide:sparkles" class="w-4 h-4 shrink-0" />
			<span class="truncate">
				Clopen v{updateState.latestVersion} is available
				<span class="hidden sm:inline opacity-70 font-normal">
					· {releasesBehind > 1 ? `${releasesBehind} releases since` : 'you have'} v{updateState.currentVersion}
				</span>
			</span>
			<button
				onclick={openWhatsNew}
				class="ml-1 shrink-0 px-2 py-0.5 text-xs font-semibold rounded bg-white/10 hover:bg-white/20 transition-colors"
			>
				What's new
			</button>
			<button
				onclick={runUpdate}
				class="shrink-0 px-2 py-0.5 text-xs font-semibold rounded bg-white/20 hover:bg-white/30 transition-colors"
			>
				Update now
			</button>
			<button
				onclick={dismissUpdate}
				class="ml-1 shrink-0 px-1.5 py-0.5 text-xs rounded bg-white/10 hover:bg-white/20 transition-colors"
				aria-label="Dismiss"
			>
				<Icon name="lucide:x" class="w-3 h-3" />
			</button>
		{/if}
	</div>
{/if}
