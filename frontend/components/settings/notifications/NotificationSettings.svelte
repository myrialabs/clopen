<script lang="ts">
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { settings, updateSettings } from '$frontend/stores/features/settings.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { soundNotification, pushNotification } from '$frontend/services/notification';
	import {
		NOTIFICATION_SOUND_PRESETS,
		NOTIFICATION_SOUND_CUSTOM,
		NOTIFICATION_SOUND_ALLOWED_EXTS,
		NOTIFICATION_SOUND_MAX_BYTES,
		isValidNotificationSoundExt
	} from '$shared/constants/notification-sounds';
	import Icon from '../../common/display/Icon.svelte';
	import { onMount } from 'svelte';

	let isTestingSound = $state(false);
	let isTestingPush = $state(false);
	let isUploading = $state(false);
	let hasCustomSound = $state(false);
	let customFileInput: HTMLInputElement | null = $state(null);

	const customSelected = $derived(settings.notificationSound === NOTIFICATION_SOUND_CUSTOM);

	const ACCEPT_ATTR = NOTIFICATION_SOUND_ALLOWED_EXTS.map((e) => `.${e}`).join(',');
	const MAX_KB = Math.round(NOTIFICATION_SOUND_MAX_BYTES / 1024);

	function volumePercent(): number {
		return Math.round((settings.notificationVolume ?? 1) * 100);
	}

	function handleVolumeChange(e: Event) {
		const pct = Number((e.target as HTMLInputElement).value);
		const next = Math.max(0, Math.min(1, pct / 100));
		updateSettings({ notificationVolume: next });
	}

	function selectSound(id: string) {
		updateSettings({ notificationSound: id });
	}

	async function checkCustomSound(): Promise<void> {
		const token = authStore.sessionToken;
		if (!token) {
			hasCustomSound = false;
			return;
		}
		try {
			const res = await fetch('/api/audio/custom/meta', {
				headers: { Authorization: `Bearer ${token}` }
			});
			if (!res.ok) {
				hasCustomSound = false;
				return;
			}
			const data = (await res.json()) as { exists?: boolean };
			hasCustomSound = !!data.exists;
		} catch {
			hasCustomSound = false;
		}
	}

	onMount(() => {
		checkCustomSound();
	});

	async function previewPreset(id: string, event: Event) {
		event.stopPropagation();
		await soundNotification.previewPreset(id);
	}

	async function previewCustom(event: Event) {
		event.stopPropagation();
		const ok = await soundNotification.previewCustom();
		if (!ok) {
			addNotification({
				type: 'error',
				title: 'Preview Failed',
				message: 'Custom sound is not available. Try uploading again.',
				duration: 3000
			});
		}
	}

	function pickCustomFile() {
		customFileInput?.click();
	}

	async function handleCustomFileChange(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;

		const ext = (file.name.split('.').pop() || '').toLowerCase();
		if (!isValidNotificationSoundExt(ext)) {
			addNotification({
				type: 'error',
				title: 'Unsupported Format',
				message: `Allowed formats: ${NOTIFICATION_SOUND_ALLOWED_EXTS.join(', ')}`,
				duration: 4000
			});
			return;
		}
		if (file.size > NOTIFICATION_SOUND_MAX_BYTES) {
			addNotification({
				type: 'error',
				title: 'File Too Large',
				message: `Max ${MAX_KB} KB.`,
				duration: 4000
			});
			return;
		}

		const token = authStore.sessionToken;
		if (!token) {
			addNotification({
				type: 'error',
				title: 'Upload Failed',
				message: 'Not authenticated.',
				duration: 3000
			});
			return;
		}

		isUploading = true;
		try {
			const params = new URLSearchParams({ ext, fileSize: String(file.size) });
			const res = await fetch(`/api/audio/upload?${params.toString()}`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
				body: file
			});
			if (!res.ok) {
				const msg = (await res.text()).trim() || `Upload failed (HTTP ${res.status})`;
				throw new Error(msg);
			}
			hasCustomSound = true;
			soundNotification.invalidateCustomCache();
			updateSettings({ notificationSound: NOTIFICATION_SOUND_CUSTOM });
			addNotification({
				type: 'success',
				title: 'Sound Uploaded',
				message: 'Custom notification sound saved.',
				duration: 3000
			});
		} catch (error) {
			addNotification({
				type: 'error',
				title: 'Upload Failed',
				message: error instanceof Error ? error.message : 'Unknown error',
				duration: 4000
			});
		} finally {
			isUploading = false;
		}
	}

	async function removeCustomSound() {
		const token = authStore.sessionToken;
		if (!token) return;
		try {
			const res = await fetch('/api/audio/custom', {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${token}` }
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			hasCustomSound = false;
			soundNotification.invalidateCustomCache();
			if (settings.notificationSound === NOTIFICATION_SOUND_CUSTOM) {
				updateSettings({ notificationSound: 'default' });
			}
			addNotification({
				type: 'success',
				title: 'Sound Removed',
				message: 'Custom notification sound deleted.',
				duration: 3000
			});
		} catch (error) {
			addNotification({
				type: 'error',
				title: 'Remove Failed',
				message: error instanceof Error ? error.message : 'Unknown error',
				duration: 4000
			});
		}
	}

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
		} catch {
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
		} catch {
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
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">
		Configure sound and push notification preferences
	</p>

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

			<!-- Sound picker + volume -->
			<div
				class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-col gap-3 transition-opacity duration-150"
				class:opacity-50={!settings.soundNotifications}
				class:pointer-events-none={!settings.soundNotifications}
			>
				<div class="text-xs font-semibold text-slate-700 dark:text-slate-300">Sound</div>

				<div class="grid grid-cols-3 gap-1.5">
					{#each NOTIFICATION_SOUND_PRESETS as preset (preset.id)}
						{@const selected = settings.notificationSound === preset.id}
						<div
							role="radio"
							tabindex="0"
							aria-checked={selected}
							aria-label={preset.label}
							onclick={() => selectSound(preset.id)}
							onkeydown={(e) => {
								if (e.key === ' ' || e.key === 'Enter') {
									e.preventDefault();
									selectSound(preset.id);
								}
							}}
							class="flex items-center gap-2 px-2.5 py-2 rounded-lg border text-left cursor-pointer transition-all duration-150 min-w-0
								{selected
									? 'bg-violet-500/10 dark:bg-violet-500/15 border-violet-500/30 dark:border-violet-500/40'
									: 'bg-white/40 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800 hover:border-violet-500/20'}"
						>
							<span
								class="flex items-center justify-center w-4 h-4 rounded-full border-2 shrink-0 transition-colors
									{selected
										? 'border-violet-500 dark:border-violet-400'
										: 'border-slate-400 dark:border-slate-600'}"
							>
								{#if selected}
									<span class="w-2 h-2 rounded-full bg-violet-500 dark:bg-violet-400"></span>
								{/if}
							</span>
							<span class="flex-1 text-sm text-slate-900 dark:text-slate-100 truncate">
								{preset.label}
							</span>
							<button
								type="button"
								onclick={(e) => previewPreset(preset.id, e)}
								class="inline-flex items-center justify-center w-6 h-6 rounded-md text-slate-600 dark:text-slate-400 hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400 transition-colors shrink-0"
								aria-label="Preview {preset.label}"
							>
								<Icon name="lucide:play" class="w-3 h-3" />
							</button>
						</div>
					{/each}
				</div>

				<div
					class="flex items-center gap-3 px-3 py-2 rounded-lg border transition-all duration-150
						{customSelected
							? 'bg-violet-500/10 dark:bg-violet-500/15 border-violet-500/30 dark:border-violet-500/40'
							: 'bg-white/40 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800'}"
				>
						<button
							type="button"
							onclick={() => hasCustomSound && selectSound(NOTIFICATION_SOUND_CUSTOM)}
							disabled={!hasCustomSound}
							class="flex items-center gap-3 flex-1 min-w-0 text-left disabled:cursor-not-allowed"
						>
							<span
								class="flex items-center justify-center w-4 h-4 rounded-full border-2 shrink-0 transition-colors
									{customSelected
										? 'border-violet-500 dark:border-violet-400'
										: 'border-slate-400 dark:border-slate-600'}"
							>
								{#if customSelected}
									<span class="w-2 h-2 rounded-full bg-violet-500 dark:bg-violet-400"></span>
								{/if}
							</span>
							<span class="flex flex-col min-w-0">
								<span class="text-sm text-slate-900 dark:text-slate-100">Custom</span>
								<span class="text-xs text-slate-500 dark:text-slate-500 truncate">
									{hasCustomSound
										? 'Your uploaded sound'
										: `Upload your own (${NOTIFICATION_SOUND_ALLOWED_EXTS.join('/')}, max ${MAX_KB} KB)`}
								</span>
							</span>
						</button>

						{#if hasCustomSound}
							<button
								type="button"
								onclick={previewCustom}
								class="inline-flex items-center justify-center w-7 h-7 rounded-md text-slate-600 dark:text-slate-400 hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
								aria-label="Preview custom sound"
							>
								<Icon name="lucide:play" class="w-3.5 h-3.5" />
							</button>
							<button
								type="button"
								onclick={pickCustomFile}
								disabled={isUploading}
								class="inline-flex items-center justify-center w-7 h-7 rounded-md text-slate-600 dark:text-slate-400 hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400 transition-colors disabled:opacity-50"
								aria-label="Replace custom sound"
							>
								<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5" />
							</button>
							<button
								type="button"
								onclick={removeCustomSound}
								class="inline-flex items-center justify-center w-7 h-7 rounded-md text-slate-600 dark:text-slate-400 hover:bg-red-500/10 hover:text-red-500 transition-colors"
								aria-label="Remove custom sound"
							>
								<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
							</button>
						{:else}
							<button
								type="button"
								onclick={pickCustomFile}
								disabled={isUploading}
								class="inline-flex items-center gap-1.5 py-1.5 px-2.5 rounded-md text-xs font-semibold text-violet-600 dark:text-violet-400 bg-violet-500/10 dark:bg-violet-500/15 border border-violet-500/20 dark:border-violet-500/25 hover:bg-violet-500/20 transition-colors disabled:opacity-50"
							>
								{#if isUploading}
									<div
										class="w-3 h-3 border-2 border-violet-600/30 dark:border-violet-400/30 border-t-violet-600 dark:border-t-violet-400 rounded-full animate-spin"
									></div>
									<span>Uploading…</span>
								{:else}
									<Icon name="lucide:upload" class="w-3.5 h-3.5" />
									<span>Upload</span>
								{/if}
							</button>
						{/if}

					<input
						bind:this={customFileInput}
						type="file"
						accept={ACCEPT_ATTR}
						onchange={handleCustomFileChange}
						class="hidden"
					/>
				</div>

				<!-- Volume -->
				<div class="flex flex-col gap-2 pt-1">
					<div class="flex items-center justify-between">
						<div class="text-xs font-semibold text-slate-700 dark:text-slate-300">Volume</div>
						<div class="text-xs font-semibold text-violet-600 dark:text-violet-400 w-10 text-right">
							{volumePercent()}%
						</div>
					</div>
					<div class="flex items-center gap-2.5 px-0.5">
						<Icon name="lucide:volume" class="w-3.5 h-3.5 text-slate-500 dark:text-slate-500 shrink-0" />
						<div class="relative flex-1 h-1.5">
							<div class="absolute inset-0 bg-slate-300 dark:bg-slate-700 rounded-full"></div>
							<div
								class="absolute inset-y-0 left-0 bg-gradient-to-r from-violet-500 to-purple-500 rounded-full"
								style="width: calc({volumePercent()}% - {(volumePercent() / 100) * 16 - 8}px)"
							></div>
							<input
								type="range"
								min="0"
								max="100"
								step="1"
								value={volumePercent()}
								oninput={handleVolumeChange}
								class="absolute inset-0 w-full opacity-0 cursor-pointer h-full"
							/>
							<div
								class="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white border-2 border-violet-500 rounded-full shadow-sm pointer-events-none"
								style="left: calc({volumePercent()}% - {(volumePercent() / 100) * 16}px)"
							></div>
						</div>
						<Icon name="lucide:volume-2" class="w-4 h-4 text-slate-500 dark:text-slate-500 shrink-0" />
					</div>
				</div>

				<!-- Test button -->
				<div>
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
