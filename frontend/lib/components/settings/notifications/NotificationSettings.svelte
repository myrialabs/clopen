<script lang="ts">
	import { addNotification } from '$frontend/lib/stores/ui/notification.svelte';
	import { settings, updateSettings } from '$frontend/lib/stores/features/settings.svelte';
	import { soundNotification, pushNotification } from '$frontend/lib/services/notification';
	import Icon from '../../common/Icon.svelte';

	let isTestingSound = $state(false);
	let isTestingPush = $state(false);

	// Test sound notification
	async function testSoundNotification() {
		isTestingSound = true;
		try {
			soundNotification.initialize();

			const success = await soundNotification.testSound();
			if (success) {
				addNotification({
					type: 'success',
					title: 'Sound Test',
					message: 'Sound notification is working correctly',
					duration: 3000
				});
			} else {
				throw new Error('Sound test failed');
			}
		} catch (error) {
			addNotification({
				type: 'error',
				title: 'Sound Test Failed',
				message: soundNotification.isSupported()
					? 'Unable to play sound notification'
					: 'Sound notifications not supported on this browser',
				duration: 4000
			});
		} finally {
			isTestingSound = false;
		}
	}

	// Test push notification
	async function testPushNotification() {
		isTestingPush = true;
		try {
			const initialized = await pushNotification.initialize();

			if (initialized) {
				const success = await pushNotification.testNotification();
				if (success) {
					addNotification({
						type: 'success',
						title: 'Push Notification Test',
						message: 'Native push notification is working correctly',
						duration: 3000
					});
				} else {
					throw new Error('Push test failed');
				}
			} else {
				throw new Error('Push notification permission denied or not supported');
			}
		} catch (error) {
			const permissionStatus = pushNotification.getPermissionStatus();
			let message = 'Unable to send push notification';

			if (!pushNotification.isSupported()) {
				message = 'Push notifications not supported on this browser';
			} else if (permissionStatus === 'denied') {
				message =
					'Push notification permission denied. Please allow notifications in browser settings.';
			} else if (permissionStatus === 'default') {
				message = 'Push notification permission not granted';
			}

			addNotification({
				type: 'error',
				title: 'Push Notification Test Failed',
				message,
				duration: 5000
			});
		} finally {
			await new Promise((resolve) => setTimeout(resolve, 2000));
			isTestingPush = false;
		}
	}
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Notifications</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">Configure sound and push notification preferences</p>

	<div class="flex flex-col gap-3.5">
		<!-- Sound notifications -->
		<div
			class="p-4 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl transition-all duration-150 hover:border-violet-500/20"
		>
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3.5 flex-1">
					<div
						class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-violet-500/10 dark:bg-violet-500/15 text-violet-600 dark:text-violet-400"
					>
						<Icon name="lucide:volume-2" class="w-5 h-5" />
					</div>
					<div class="flex flex-col gap-0.5 min-w-0">
						<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">
							Sound notifications
						</div>
						<div class="text-xs text-slate-600 dark:text-slate-500">
							Play sound when response is completed
						</div>
					</div>
				</div>
				<label class="relative inline-block w-12 h-6.5 shrink-0">
					<input
						type="checkbox"
						checked={settings.soundNotifications}
						onchange={() => updateSettings({ soundNotifications: !settings.soundNotifications })}
						class="opacity-0 w-0 h-0"
					/>
					<span
						class="absolute cursor-pointer inset-0 bg-slate-600/40 dark:bg-slate-600/40 rounded-3xl transition-all duration-200
						before:absolute before:content-[''] before:h-5 before:w-5 before:left-0.75 before:bottom-0.75 before:bg-white before:rounded-full before:transition-all before:duration-200
						{settings.soundNotifications
							? 'bg-gradient-to-br from-violet-600 to-purple-600 before:translate-x-5.5'
							: ''}"
					></span>
				</label>
			</div>
			<div class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800">
				<button
					type="button"
					class="inline-flex items-center gap-1.5 py-2 px-3.5 bg-violet-500/10 dark:bg-violet-500/10 border border-violet-500/20 dark:border-violet-500/25 rounded-lg text-violet-600 dark:text-violet-400 text-xs font-semibold cursor-pointer transition-all duration-150 hover:bg-violet-500/20 dark:hover:bg-violet-500/20 hover:border-violet-600 dark:hover:border-violet-500/40 disabled:opacity-50 disabled:cursor-not-allowed"
					onclick={testSoundNotification}
					disabled={isTestingSound}
				>
					{#if isTestingSound}
						<div
							class="w-3 h-3 border-2 border-violet-600/30 dark:border-violet-400/30 border-t-violet-600 dark:border-t-violet-400 rounded-full animate-spin"
						></div>
						<span>Testing...</span>
					{:else}
						<Icon name="lucide:play" class="w-3.5 h-3.5" />
						<span>Test Sound</span>
					{/if}
				</button>
			</div>
		</div>

		<!-- Push notifications -->
		<div
			class="p-4 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl transition-all duration-150 hover:border-violet-500/20"
		>
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3.5 flex-1">
					<div
						class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-orange-400/15 text-orange-400"
					>
						<Icon name="lucide:bell" class="w-5 h-5" />
					</div>
					<div class="flex flex-col gap-0.5 min-w-0">
						<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">
							Push notifications
						</div>
						<div class="text-xs text-slate-600 dark:text-slate-500">
							Show native browser notifications when response is completed
						</div>
					</div>
				</div>
				<label class="relative inline-block w-12 h-6.5 shrink-0">
					<input
						type="checkbox"
						checked={settings.pushNotifications}
						onchange={() => updateSettings({ pushNotifications: !settings.pushNotifications })}
						class="opacity-0 w-0 h-0"
					/>
					<span
						class="absolute cursor-pointer inset-0 bg-slate-600/40 dark:bg-slate-600/40 rounded-3xl transition-all duration-200
						before:absolute before:content-[''] before:h-5 before:w-5 before:left-0.75 before:bottom-0.75 before:bg-white before:rounded-full before:transition-all before:duration-200
						{settings.pushNotifications
							? 'bg-gradient-to-br from-violet-600 to-purple-600 before:translate-x-5.5'
							: ''}"
					></span>
				</label>
			</div>
			<div class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800">
				<button
					type="button"
					class="inline-flex items-center gap-1.5 py-2 px-3.5 bg-violet-500/10 dark:bg-violet-500/10 border border-violet-500/20 dark:border-violet-500/25 rounded-lg text-violet-600 dark:text-violet-400 text-xs font-semibold cursor-pointer transition-all duration-150 hover:bg-violet-500/20 dark:hover:bg-violet-500/20 hover:border-violet-600 dark:hover:border-violet-500/40 disabled:opacity-50 disabled:cursor-not-allowed"
					onclick={testPushNotification}
					disabled={isTestingPush}
				>
					{#if isTestingPush}
						<div
							class="w-3 h-3 border-2 border-violet-600/30 dark:border-violet-400/30 border-t-violet-600 dark:border-t-violet-400 rounded-full animate-spin"
						></div>
						<span>Testing...</span>
					{:else}
						<Icon name="lucide:send" class="w-3.5 h-3.5" />
						<span>Test Push</span>
					{/if}
				</button>
			</div>
		</div>
	</div>
</div>
