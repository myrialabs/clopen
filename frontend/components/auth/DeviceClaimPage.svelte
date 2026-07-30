<script lang="ts">
	import { onMount } from 'svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';

	let error = $state('');
	let isClaiming = $state(true);

	// Rate limit countdown
	let lockoutSeconds = $state(0);
	let countdownInterval: ReturnType<typeof setInterval> | null = null;

	function parseRateLimitSeconds(message: string): number {
		const match = message.match(/Try again in (\d+) seconds/);
		return match ? parseInt(match[1], 10) : 0;
	}

	function startCountdown(seconds: number) {
		stopCountdown();
		lockoutSeconds = seconds;
		countdownInterval = setInterval(() => {
			lockoutSeconds -= 1;
			if (lockoutSeconds <= 0) stopCountdown();
		}, 1000);
	}

	function stopCountdown() {
		lockoutSeconds = 0;
		if (countdownInterval) {
			clearInterval(countdownInterval);
			countdownInterval = null;
		}
	}

	const isLockedOut = $derived(lockoutSeconds > 0);

	const displayError = $derived(
		isLockedOut
			? `Too many attempts. Try again in ${lockoutSeconds} seconds.`
			: error
	);

	// Extract device code from URL hash (#device/<code>)
	const hash = window.location.hash;
	const deviceCode = hash.startsWith('#device/') ? hash.slice(8) : '';

	async function claim() {
		if (!deviceCode) {
			error = 'No device code found in this link.';
			isClaiming = false;
			return;
		}

		error = '';
		isClaiming = true;
		try {
			await authStore.claimDeviceCode(deviceCode);
			// On success the auth store transitions away from the device page.
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to sign in this device';
			error = message;
			const seconds = parseRateLimitSeconds(message);
			if (seconds > 0) startCountdown(seconds);
		} finally {
			isClaiming = false;
		}
	}

	onMount(() => {
		claim();
		return () => stopCountdown();
	});

	function goToLogin() {
		window.location.hash = '';
		window.location.reload();
	}
</script>

<div class="fixed inset-0 z-[9999] bg-white dark:bg-slate-950 flex items-center justify-center">
	<div class="flex flex-col items-center gap-6 text-center px-4 max-w-md w-full">
		<!-- Logo -->
		<div>
			<img src="/favicon.svg" alt="Clopen" class="w-16 h-16 rounded-2xl shadow-xl" />
		</div>

		{#if isClaiming}
			<div class="space-y-2">
				<h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">Signing in this device…</h1>
				<p class="text-sm text-slate-500 dark:text-slate-400">Verifying your access link</p>
			</div>
			<div class="w-6 h-6 border-2 border-violet-500/20 border-t-violet-600 rounded-full animate-spin"></div>
		{:else if displayError}
			<div class="space-y-4">
				<h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">Couldn't sign in</h1>
				<p class="text-sm text-red-500">{displayError}</p>
				<p class="text-xs text-slate-400 dark:text-slate-500">
					Device links are single-use and expire quickly. Ask for a fresh link, or sign in with your access token instead.
				</p>
				<div class="flex items-center justify-center gap-2">
					{#if !isLockedOut}
						<button
							onclick={claim}
							class="py-2 px-4 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium transition-colors"
						>
							Try again
						</button>
					{/if}
					<button
						onclick={goToLogin}
						class="py-2 px-4 rounded-lg bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-sm font-medium transition-colors"
					>
						Go to Login
					</button>
				</div>
			</div>
		{/if}
	</div>
</div>
