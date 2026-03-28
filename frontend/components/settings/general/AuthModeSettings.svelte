<script lang="ts">
	import { systemSettings, updateSystemSettings } from '$frontend/stores/features/settings.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import Icon from '../../common/display/Icon.svelte';
	import Dialog from '../../common/overlay/Dialog.svelte';
	import type { AuthMode } from '$shared/types/stores/settings';
	import { debug } from '$shared/utils/logger';

	const isAdmin = $derived(authStore.isAdmin);
	const currentMode = $derived(systemSettings.authMode);

	// Simple confirmation dialog (required → none)
	let showSimpleConfirm = $state(false);
	let pendingMode = $state<AuthMode>('required');

	// PAT dialog (none → required)
	let showPatDialog = $state(false);
	let generatedPat = $state('');
	let patCopied = $state(false);
	let isPreparingSwitch = $state(false);

	async function requestModeChange(mode: AuthMode) {
		if (mode === currentMode) return;
		pendingMode = mode;

		if (currentMode === 'none' && mode === 'required') {
			// Switching to with-auth: regenerate PAT first, then show dialog
			isPreparingSwitch = true;
			try {
				const pat = await authStore.regeneratePAT();
				generatedPat = pat;
				showPatDialog = true;
			} catch (error) {
				debug.error('settings', 'Failed to regenerate PAT for auth mode switch:', error);
				addNotification({ type: 'error', title: 'Error', message: 'Failed to prepare authentication switch' });
			} finally {
				isPreparingSwitch = false;
			}
		} else {
			showSimpleConfirm = true;
		}
	}

	function confirmSimpleChange() {
		showSimpleConfirm = false;
		updateSystemSettings({ authMode: pendingMode });
	}

	async function confirmWithAuthSwitch() {
		showPatDialog = false;

		// Save auth mode
		await updateSystemSettings({ authMode: 'required' });

		// Logout all sessions (including current) — forces everyone to re-login
		await authStore.logoutAll();

		generatedPat = '';
		patCopied = false;
	}

	function cancelPatDialog() {
		showPatDialog = false;
		generatedPat = '';
		patCopied = false;
	}

	async function copyPat() {
		if (generatedPat) {
			await navigator.clipboard.writeText(generatedPat);
			patCopied = true;
			setTimeout(() => { patCopied = false; }, 2000);
		}
	}
</script>

{#if isAdmin}
<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Authentication</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">Configure how users access Clopen</p>

	<div class="flex flex-col gap-3.5">
		<!-- No Login -->
		<button
			type="button"
			disabled={isPreparingSwitch}
			class="w-full text-left p-4 bg-slate-100/80 dark:bg-slate-800/80 border rounded-xl transition-all
				{currentMode === 'none'
					? 'border-violet-500/50 ring-1 ring-violet-500/20'
					: 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'}
				disabled:opacity-50 disabled:cursor-not-allowed"
			onclick={() => requestModeChange('none')}
		>
			<div class="flex items-center gap-3.5">
				<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0
					{currentMode === 'none'
						? 'bg-violet-500/15 text-violet-600 dark:text-violet-400'
						: 'bg-slate-200/80 dark:bg-slate-700 text-slate-400'}">
					<Icon name="lucide:lock-open" class="w-5 h-5" />
				</div>
				<div class="flex-1 min-w-0">
					<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">No Login</div>
					<div class="text-xs text-slate-600 dark:text-slate-500">
						No authentication required. Anyone with access to this URL can use Clopen.
					</div>
				</div>
				{#if currentMode === 'none'}
					<div class="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 shrink-0">
						<span class="w-1.5 h-1.5 rounded-full bg-violet-500"></span>
						Active
					</div>
				{/if}
			</div>
		</button>

		<!-- With Login -->
		<button
			type="button"
			disabled={isPreparingSwitch}
			class="w-full text-left p-4 bg-slate-100/80 dark:bg-slate-800/80 border rounded-xl transition-all
				{currentMode === 'required'
					? 'border-violet-500/50 ring-1 ring-violet-500/20'
					: 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'}
				disabled:opacity-50 disabled:cursor-not-allowed"
			onclick={() => requestModeChange('required')}
		>
			<div class="flex items-center gap-3.5">
				<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0
					{currentMode === 'required'
						? 'bg-violet-500/15 text-violet-600 dark:text-violet-400'
						: 'bg-slate-200/80 dark:bg-slate-700 text-slate-400'}">
					<Icon name="lucide:lock" class="w-5 h-5" />
				</div>
				<div class="flex-1 min-w-0">
					<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">With Login</div>
					<div class="text-xs text-slate-600 dark:text-slate-500">
						Authenticate with a Personal Access Token. Supports multiple users and invite links.
					</div>
				</div>
				{#if currentMode === 'required'}
					<div class="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 shrink-0">
						<span class="w-1.5 h-1.5 rounded-full bg-violet-500"></span>
						Active
					</div>
				{/if}
			</div>
		</button>
	</div>

	{#if isPreparingSwitch}
		<div class="flex items-center gap-2 mt-4 text-sm text-slate-500">
			<div class="w-4 h-4 border-2 border-violet-500/20 border-t-violet-600 rounded-full animate-spin"></div>
			<span>Preparing authentication switch...</span>
		</div>
	{/if}
</div>
{/if}

<!-- Simple confirm dialog (required → none) -->
<Dialog
	bind:isOpen={showSimpleConfirm}
	onClose={() => { showSimpleConfirm = false; }}
	type="info"
	title="Change Authentication Mode"
	message="Switching to No Login mode will disable login requirements. Existing users and sessions will be preserved but bypassed."
	confirmText="Confirm"
	cancelText="Cancel"
	showCancel={true}
	onConfirm={confirmSimpleChange}
/>

<!-- PAT dialog (none → required) -->
<Dialog
	bind:isOpen={showPatDialog}
	onClose={cancelPatDialog}
	type="warning"
	title="Change Authentication Mode"
	closable={false}
	confirmText="Confirm"
	cancelText="Cancel"
	showCancel={true}
	onConfirm={confirmWithAuthSwitch}
>
	{#snippet children()}
		<div class="flex items-start space-x-4">
			<div class="bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-700/50 rounded-xl p-3 border">
				<Icon name="lucide:triangle-alert" class="w-6 h-6 text-amber-600 dark:text-amber-400" />
			</div>

			<div class="flex-1 space-y-1">
				<h3 class="text-lg font-semibold text-slate-900 dark:text-slate-100">
					Change Authentication Mode
				</h3>
				<p class="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
					Switching to With Login mode will require authentication. All sessions will be logged out and you will need this token to log in again.
				</p>

				<!-- PAT Display -->
				<div class="mt-3 p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
					<div class="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-200 mb-2">
						<Icon name="lucide:key-round" class="w-4 h-4" />
						<span>Your Personal Access Token</span>
					</div>
					<div class="flex items-center gap-2">
						<code class="flex-1 px-3 py-2 rounded-md bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-700 text-xs font-mono text-slate-900 dark:text-slate-100 select-all break-all">
							{generatedPat}
						</code>
						<button
							type="button"
							onclick={copyPat}
							class="shrink-0 flex items-center justify-center w-9 h-9 rounded-lg transition-all
								{patCopied
									? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'
									: 'bg-amber-100 dark:bg-amber-900 hover:bg-amber-200 dark:hover:bg-amber-800 text-amber-800 dark:text-amber-200'}"
							title="Copy token"
						>
							<Icon name={patCopied ? 'lucide:check' : 'lucide:copy'} class="w-4 h-4" />
						</button>
					</div>
					<div class="flex items-center gap-1.5 mt-2 text-xs text-amber-600 dark:text-amber-400">
						<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5 shrink-0" />
						<span>Copy this token now. It won't be shown again.</span>
					</div>
				</div>
			</div>
		</div>
	{/snippet}
</Dialog>
