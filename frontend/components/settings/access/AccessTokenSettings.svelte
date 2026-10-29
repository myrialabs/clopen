<script lang="ts">
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { copyText } from '$frontend/utils/clipboard';
	import Icon from '../../common/display/Icon.svelte';
	import Dialog from '../../common/overlay/Dialog.svelte';
	import { debug } from '$shared/utils/logger';

	let currentPAT = $state('');
	let isRegenerating = $state(false);
	let showRegenerateConfirm = $state(false);

	async function regeneratePAT() {
		isRegenerating = true;
		try {
			currentPAT = await authStore.regeneratePAT();
			showRegenerateConfirm = false;
			addNotification({ type: 'success', title: 'New token ready', message: 'Copy it now — it is shown only once' });
		} catch (error) {
			debug.error('settings', 'Error regenerating PAT:', error);
			addNotification({ type: 'error', title: 'Error', message: 'Failed to create a new token' });
		} finally {
			isRegenerating = false;
		}
	}

	async function copyPAT() {
		if (await copyText(currentPAT)) {
			addNotification({ type: 'success', title: 'Copied', message: 'Token copied to clipboard' });
		}
	}

	async function handleLogout() {
		await authStore.logout();
	}
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Access Token</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">
		The token you type on the sign-in screen. Adding a device from Remote Access is easier — it never needs the token.
	</p>

	<div class="flex flex-col gap-4">
		<div class="p-4 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
			{#if currentPAT}
				<div class="flex flex-col gap-2 mb-3">
					<div class="flex items-center gap-2">
						<code class="flex-1 py-2.5 px-3.5 bg-slate-50 dark:bg-slate-900/80 border border-emerald-500/30 rounded-lg font-mono text-xs text-slate-700 dark:text-slate-300 break-all select-all">
							{currentPAT}
						</code>
						<button
							type="button"
							onclick={copyPAT}
							class="flex items-center justify-center w-9 h-9 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 transition-all"
							title="Copy token"
						>
							<Icon name="lucide:copy" class="w-4 h-4" />
						</button>
					</div>
					<div class="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
						<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5" />
						<span>Shown only once. Store it somewhere safe.</span>
					</div>
				</div>
			{:else}
				<p class="text-xs text-slate-600 dark:text-slate-500 mb-3">
					The current token is never shown again. Create a new one if you lost it — or run
					<code class="font-mono bg-slate-200/70 dark:bg-slate-900/80 px-1 py-0.5 rounded">clopen reset-pat</code>
					on the machine running Clopen.
				</p>
			{/if}

			<button
				type="button"
				onclick={() => { showRegenerateConfirm = true; }}
				disabled={isRegenerating}
				class="inline-flex items-center gap-1.5 py-2 px-3.5 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-600 dark:text-amber-400 text-xs font-semibold cursor-pointer transition-all duration-150 hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{#if isRegenerating}
					<div class="w-3.5 h-3.5 border-2 border-amber-600/30 border-t-amber-600 rounded-full animate-spin"></div>
					Creating...
				{:else}
					<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5" />
					Create a new token
				{/if}
			</button>
		</div>

		<div>
			<button
				type="button"
				onclick={handleLogout}
				class="inline-flex items-center gap-1.5 py-2.5 px-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-600 dark:text-red-400 text-sm font-semibold cursor-pointer transition-all duration-150 hover:bg-red-500/20 hover:border-red-600/40"
			>
				<Icon name="lucide:log-out" class="w-4 h-4" />
				Sign out of this device
			</button>
		</div>
	</div>
</div>

<Dialog
	bind:isOpen={showRegenerateConfirm}
	onClose={() => { showRegenerateConfirm = false; }}
	title="Create a new access token"
	type="warning"
	message="The old token stops working for new sign-ins. Devices that are already signed in stay signed in."
	confirmText="Create"
	cancelText="Cancel"
	showCancel={true}
	onConfirm={regeneratePAT}
/>
