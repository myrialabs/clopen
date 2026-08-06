<script lang="ts">
	/**
	 * Chrome-style permission bubble for the preview.
	 *
	 * The previewed page asked for something only the viewer's device can give —
	 * their location, camera, microphone or clipboard. This is where that ask
	 * surfaces, and the Allow button is load-bearing rather than cosmetic: Safari
	 * and iOS only grant `getUserMedia` and `clipboard.read` when the call
	 * originates inside a user gesture, so the real API call runs from this click.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import type { PendingPermission } from '$frontend/utils/native-ui';
	import type { IconName } from '$shared/types/ui/icons';

	let {
		request = null as PendingPermission | null,
		onAllow = (_request: PendingPermission) => {},
		onDeny = (_request: PendingPermission) => {}
	} = $props();

	const details = $derived.by(() => {
		if (!request) return null;

		switch (request.kind) {
			case 'geolocation':
				return {
					icon: 'lucide:map-pin',
					title: 'wants to know your location',
					note: 'Your device will be asked for a position fix and the page will receive it.',
					confirm: 'Allow',
					cancel: 'Block'
				};
			case 'media-request': {
				const wantsVideo = !!request.payload?.video;
				const wantsAudio = !!request.payload?.audio;

				// Screen sharing rides the same relay as the camera, but asking to
				// record a screen is a very different decision from lending a camera.
				if (request.payload?.display) {
					return {
						icon: 'lucide:monitor-up',
						title: 'wants to share your screen',
						note: 'You choose what to share; the page receives that capture live.',
						confirm: 'Choose…',
						cancel: 'Block'
					};
				}

				const what =
					wantsVideo && wantsAudio ? 'camera and microphone' : wantsVideo ? 'camera' : 'microphone';
				return {
					icon: wantsVideo ? 'lucide:video' : 'lucide:mic',
					title: `wants to use your ${what}`,
					note: `Your ${what} will be streamed into the preview for as long as the page uses it.`,
					confirm: 'Allow',
					cancel: 'Block'
				};
			}
			case 'clipboard-read':
				return {
					icon: 'lucide:clipboard',
					title: 'wants to read your clipboard',
					note: 'The page will receive whatever text you last copied.',
					confirm: 'Allow',
					cancel: 'Block'
				};
			case 'speech-start':
				return {
					icon: 'lucide:audio-lines',
					title: 'wants to listen to your microphone',
					note: 'Speech is recognised by your own browser; only the transcript reaches the page.',
					confirm: 'Allow',
					cancel: 'Block'
				};
			case 'notification-permission':
				return {
					icon: 'lucide:bell',
					title: 'wants to show notifications',
					note: 'Notifications will be delivered by your own browser.',
					confirm: 'Allow',
					cancel: 'Block'
				};
			case 'file-pick':
				return {
					icon: 'lucide:paperclip',
					title: request.payload?.multiple ? 'wants to open files' : 'wants to open a file',
					// The picker has to be opened from a click: browsers refuse to
					// raise one for a page that did not just receive a user gesture.
					note: 'Files are read from your device and uploaded to the page.',
					confirm: 'Choose…',
					cancel: 'Cancel'
				};
			default:
				return {
					icon: 'lucide:shield-question',
					title: 'is requesting a permission',
					note: '',
					confirm: 'Allow',
					cancel: 'Block'
				};
		}
	});
</script>

{#if request && details}
	<div
		class="absolute left-1/2 top-3 z-40 w-[min(24rem,calc(100%-1.5rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-slate-200 bg-white/95 shadow-2xl backdrop-blur dark:border-slate-700 dark:bg-slate-800/95"
		role="alertdialog"
		aria-label="Permission request"
		transition:fly={{ y: -12, duration: 180, easing: cubicOut }}
	>
		<div class="flex items-start gap-3 px-4 pt-3.5">
			<span class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-violet-500">
				<Icon name={details.icon as IconName} class="h-4 w-4" />
			</span>
			<div class="min-w-0 flex-1">
				<p class="text-sm text-slate-800 dark:text-slate-100">
					<span class="font-semibold break-all">{request.origin}</span>
					<span class="text-slate-600 dark:text-slate-300"> {details.title}</span>
				</p>
				{#if details.note}
					<p class="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{details.note}</p>
				{/if}
			</div>
		</div>

		<div class="mt-3 flex justify-end gap-2 bg-slate-50 px-4 py-2.5 dark:bg-slate-900/50">
			<button
				type="button"
				class="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-700"
				onclick={() => onDeny(request)}
			>
				{details.cancel}
			</button>
			<button
				type="button"
				class="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-700"
				onclick={() => onAllow(request)}
			>
				{details.confirm}
			</button>
		</div>
	</div>
{/if}
