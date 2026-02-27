<script lang="ts">
	import { tunnelStore } from '$frontend/lib/stores/features/tunnel.svelte';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import Modal from '$frontend/lib/components/common/Modal.svelte';
	import Checkbox from '$frontend/lib/components/common/Checkbox.svelte';

	let port = $state(9141);
	let autoStopMinutes = $state(60);
	let showWarning = $state(false);
	let dontShowWarningAgain = $state(false);
	let errorDismissed = $state(false);
	let warningMessage = $state<string | null>(null);
	let warningDismissed = $state(false);

	// Info box visibility - load from localStorage
	let showInfoBox = $state(
		typeof window !== 'undefined'
			? localStorage.getItem('tunnel-info-dismissed') !== 'true'
			: true
	);

	async function handleStartTunnel() {
		// Check if tunnel already exists for this port
		if (tunnelStore.getTunnel(port)) {
			warningMessage = `Tunnel already active on port ${port}`;
			warningDismissed = false;
			showWarning = false;
			return;
		}

		// Save "don't show again" preference
		if (dontShowWarningAgain) {
			localStorage.setItem('tunnel-warning-dismissed', 'true');
		}

		// Close modal immediately
		showWarning = false;

		try {
			await tunnelStore.startTunnel(port, autoStopMinutes);
		} catch (error) {
			console.error('Failed to start tunnel:', error);
		}
	}

	// Get loading and progress state for current port
	const isLoading = $derived(tunnelStore.isLoading(port));
	const progress = $derived(tunnelStore.getProgress(port));
	const error = $derived(tunnelStore.getError(port));

	function openWarningModal() {
		// Clear any previous warning messages
		warningMessage = null;

		// Reset error and warning dismissed state when user tries to start again
		errorDismissed = false;
		warningDismissed = false;

		// Check if user has dismissed warning permanently
		const securityWarningDismissed = localStorage.getItem('tunnel-warning-dismissed') === 'true';
		if (securityWarningDismissed) {
			// Skip warning and start tunnel directly
			handleStartTunnel();
		} else {
			showWarning = true;
		}
	}

	function closeInfoBox() {
		showInfoBox = false;
		localStorage.setItem('tunnel-info-dismissed', 'true');
	}

	function dismissError() {
		errorDismissed = true;
	}

	function dismissWarning() {
		warningDismissed = true;
	}
</script>

<div class="space-y-6">
	<!-- Info Card -->
	{#if showInfoBox}
		<div
			class="p-4 bg-violet-500/5 dark:bg-violet-500/10 border border-violet-500/20 rounded-xl"
		>
			<div class="flex gap-3">
				<Icon name="lucide:info" class="w-5 h-5 text-violet-600 dark:text-violet-400 flex-shrink-0 mt-0.5" />
				<div class="flex-1 text-sm text-slate-700 dark:text-slate-300">
					<p class="font-semibold mb-1">What is Public Tunnel?</p>
					<p class="text-slate-600 dark:text-slate-400">
						Create a secure HTTPS tunnel to share your local development server with anyone on the
						internet.
					</p>
				</div>
				<button
					onclick={closeInfoBox}
					class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors flex-shrink-0"
					title="Dismiss"
				>
					<Icon name="lucide:x" class="w-5 h-5" />
				</button>
			</div>
		</div>
	{/if}

	<!-- Input Fields -->
	<div class="space-y-4">
		<!-- Port Input -->
		<div class="space-y-2">
			<label for="port" class="block text-sm font-semibold text-slate-700 dark:text-slate-300">
				Local Port
			</label>
			<input
				id="port"
				type="number"
				bind:value={port}
				min="1"
				max="65535"
				placeholder="3000"
				class="block w-full px-3 py-3 border border-slate-300 dark:border-slate-600 rounded-lg transition-colors duration-200 focus:outline-none text-sm font-medium focus:border-violet-500 focus:ring-2 focus:ring-violet-200 dark:focus:ring-violet-900/20 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500"
			/>
			<!-- <p class="text-xs text-slate-500 dark:text-slate-400">
				Port number where your app is running (e.g., 3000 for Vite, 8080 for API)
			</p> -->
		</div>

		<!-- Auto-Stop Timer -->
		<div class="space-y-2">
			<label for="autoStop" class="block text-sm font-semibold text-slate-700 dark:text-slate-300">
				Auto-Stop After
			</label>
			<select
				id="autoStop"
				bind:value={autoStopMinutes}
				class="block w-full px-3 py-3 border border-slate-300 dark:border-slate-600 rounded-lg transition-colors duration-200 focus:outline-none text-sm font-medium focus:border-violet-500 focus:ring-2 focus:ring-violet-200 dark:focus:ring-violet-900/20 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
			>
				<option value={30}>30 minutes</option>
				<option value={60}>1 hour</option>
				<option value={120}>2 hours</option>
				<option value={180}>3 hours</option>
			</select>
			<!-- <p class="text-xs text-slate-500 dark:text-slate-400">
				Tunnel will automatically stop after this duration
			</p> -->
		</div>

		<!-- Start Button -->
		<button
			onclick={openWarningModal}
			disabled={isLoading}
			class="inline-flex items-center justify-center font-semibold transition-colors duration-200 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed w-full px-3 md:px-4 py-2.5 text-sm rounded-lg bg-violet-600 hover:bg-violet-700 text-white gap-2"
		>
			{#if isLoading}
				<div
					class="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent"
				></div>
				<span>
					{#if progress.stage === 'checking-binary'}
						Checking binary...
					{:else if progress.stage === 'downloading-binary'}
						Downloading binary...
					{:else if progress.stage === 'binary-ready'}
						Binary ready
					{:else if progress.stage === 'starting-tunnel'}
						Starting tunnel...
					{:else if progress.stage === 'generating-url'}
						Generating URL...
					{:else if progress.stage === 'connected'}
						Connected!
					{:else}
						Setting up tunnel...
					{/if}
				</span>
			{:else}
				<Icon name="lucide:cloud-upload" class="w-4 h-4" />
				<span>Start Public Tunnel</span>
			{/if}
		</button>

		<!-- Warning Message (e.g., tunnel already active) -->
		{#if warningMessage && !warningDismissed}
			<div
				class="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4 text-sm"
			>
				<div class="flex items-start gap-2 text-yellow-600 dark:text-yellow-400">
					<Icon name="lucide:triangle-alert" class="w-5 h-5 flex-shrink-0 mt-0.5" />
					<div class="flex-1 space-y-1">
						<div class="font-semibold">Warning</div>
						<div class="text-yellow-500 dark:text-yellow-300">
							{warningMessage}
						</div>
					</div>
					<button
						onclick={dismissWarning}
						class="text-yellow-400 hover:text-yellow-600 dark:hover:text-yellow-300 transition-colors flex-shrink-0"
						title="Dismiss"
					>
						<Icon name="lucide:x" class="w-5 h-5" />
					</button>
				</div>
			</div>
		{/if}

		{#if (error || progress.stage === 'failed') && !errorDismissed}
			<div
				class="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-sm space-y-3"
			>
				<div class="flex items-start gap-2 text-red-600 dark:text-red-400">
					<Icon name="lucide:circle-alert" class="w-5 h-5 flex-shrink-0 mt-0.5" />
					<div class="flex-1 space-y-1">
						<div class="font-semibold">Tunnel Failed</div>
						<div class="text-red-500 dark:text-red-300">
							{error}
						</div>
					</div>
					<button
						onclick={dismissError}
						class="text-red-400 hover:text-red-600 dark:hover:text-red-300 transition-colors flex-shrink-0"
						title="Dismiss"
					>
						<Icon name="lucide:x" class="w-5 h-5" />
					</button>
				</div>

				<!-- Common solutions -->
				<div class="text-xs text-slate-700 dark:text-slate-300 space-y-1 pt-2 border-t border-red-500/20">
					<div class="font-semibold">Common solutions:</div>
					<ul class="list-disc list-inside space-y-0.5 text-slate-600 dark:text-slate-400">
						<li>Ensure your app is running on port {port}</li>
						<li>Check your internet connection</li>
						<li>Temporarily disable firewall/antivirus</li>
					</ul>
				</div>
			</div>
		{/if}
	</div>
</div>

<!-- Warning Modal -->
{#if showWarning}
	<Modal isOpen={showWarning} onClose={() => (showWarning = false)} title="Security Warning">
		<div class="space-y-4">
			<div class="flex items-start gap-3">
				<Icon name="lucide:triangle-alert" class="w-8 h-8 text-yellow-500 flex-shrink-0" />
				<div class="text-sm text-slate-700 dark:text-slate-300">
					<p class="mb-3">Your project will be publicly accessible on the internet.</p>
					<p class="font-semibold mb-2">Please ensure:</p>
					<ul class="list-disc list-inside space-y-1 text-slate-600 dark:text-slate-400">
						<li>No sensitive data is exposed</li>
						<li>Environment variables are properly configured</li>
						<li>This is for <strong class="text-slate-900 dark:text-slate-100">testing only</strong>, not production</li>
					</ul>
				</div>
			</div>

			<!-- Don't show again checkbox -->
			<div class="pt-2">
				<Checkbox
					id="dontShowWarning"
					bind:checked={dontShowWarningAgain}
					label="Don't show this warning again"
				/>
			</div>

			<div class="flex gap-2 justify-end pt-2">
				<button
					onclick={() => (showWarning = false)}
					class="inline-flex items-center justify-center font-semibold transition-colors duration-200 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed px-3 md:px-4 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
				>
					Cancel
				</button>
				<button
					onclick={handleStartTunnel}
					class="inline-flex items-center justify-center font-semibold transition-colors duration-200 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed px-3 md:px-4 py-2.5 text-sm rounded-lg bg-violet-600 hover:bg-violet-700 text-white"
				>
					I Understand, Continue
				</button>
			</div>
		</div>
	</Modal>
{/if}
