<script lang="ts">
	import { updateState, runUpdate, dismissUpdate, checkForUpdate, showRestartModal } from '$frontend/stores/ui/update.svelte';
	import { systemSettings, updateSystemSettings } from '$frontend/stores/features/settings.svelte';
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

	function handleUpdate() {
		runUpdate();
	}

	function handleDismiss() {
		dismissUpdate();
	}

	function toggleAutoUpdate() {
		updateSystemSettings({ autoUpdate: !systemSettings.autoUpdate });
	}

	function handleRetry() {
		checkForUpdate();
	}

	function handleShowRestart() {
		showRestartModal();
	}
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
			<Icon name="lucide:package-check" class="w-4 h-4" />
			<span>Updated to v{updateState.latestVersion} — restart required</span>
			<button
				onclick={handleShowRestart}
				class="ml-1 px-2 py-0.5 text-xs font-semibold rounded bg-white/20 hover:bg-white/30 transition-colors"
			>
				How to restart
			</button>
		{:else if updateState.error}
			<Icon name="lucide:package-x" class="w-4 h-4" />
			<span>{updateState.errorType === 'check' ? 'Unable to check for updates' : 'Update failed'}</span>
			<button
				onclick={handleRetry}
				class="ml-1 px-2 py-0.5 text-xs font-semibold rounded bg-white/20 hover:bg-white/30 transition-colors"
			>
				{updateState.errorType === 'check' ? 'Check again' : 'Retry'}
			</button>
			<button
				onclick={handleDismiss}
				class="ml-1 px-1.5 py-0.5 text-xs rounded bg-white/10 hover:bg-white/20 transition-colors"
			>
				<Icon name="lucide:x" class="w-3 h-3" />
			</button>
		{:else if updateState.updating}
			<Icon name="lucide:loader-circle" class="w-4 h-4 animate-spin" />
			<span>Updating to v{updateState.latestVersion}...</span>
		{:else}
			<Icon name="lucide:package" class="w-4 h-4" />
			<span>
				v{updateState.latestVersion} available
				<span class="opacity-70">(current: v{updateState.currentVersion})</span>
			</span>
			<button
				onclick={handleUpdate}
				class="ml-1 px-2 py-0.5 text-xs font-semibold rounded bg-white/20 hover:bg-white/30 transition-colors"
			>
				Update now
			</button>
			<button
				onclick={handleDismiss}
				class="ml-1 px-1.5 py-0.5 text-xs rounded bg-white/10 hover:bg-white/20 transition-colors"
			>
				<Icon name="lucide:x" class="w-3 h-3" />
			</button>
		{/if}
	</div>
{/if}
