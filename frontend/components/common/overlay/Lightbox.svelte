<!--
  Full-screen viewer for chat attachments — the ones in the message box and
  the ones in sent messages. Shows one file at a time through MediaPreview (the
  same viewer as the Files panel) and steps through the rest with the arrows,
  the keyboard or a swipe, each one under the number `@N` refers to.
-->
<script lang="ts" module>
	export interface ViewerItem {
		name: string;
		mediaType: string;
		/** Size in bytes, when known before loading. */
		size?: number;
		/** The attachment's number in its message — what `@N` names. */
		number?: number;
		/** The bytes, for a file held in the browser. */
		base64?: string;
		/** Where the file is on the server, for one saved there. */
		path?: string;
	}
</script>

<script lang="ts">
	import { fade } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import MediaPreview from '$frontend/components/common/media/MediaPreview.svelte';
	import { getAttachmentIcon } from '$frontend/utils/file-icon-mappings';
	import { formatFileSize } from '$frontend/utils/format';
	import { previewKind } from '$frontend/utils/file-type';
	import { base64ToBlob } from '$frontend/utils/base64';
	import { portal } from '$frontend/utils/portal';
	import { debug } from '$shared/utils/logger';
	import ws from '$frontend/utils/ws';

	interface Props {
		isOpen: boolean;
		items: ViewerItem[];
		/** The item on screen. */
		index?: number;
		onClose: () => void;
	}

	let { isOpen = $bindable(), items, index = $bindable(0), onClose }: Props = $props();

	const item = $derived(items[Math.min(Math.max(index, 0), Math.max(items.length - 1, 0))] as ViewerItem | undefined);
	const hasMany = $derived(items.length > 1);

	// Each file is read once, however often it is shown or downloaded.
	const loads = new WeakMap<ViewerItem, Promise<Blob | null>>();

	function blobOf(target: ViewerItem): Promise<Blob | null> {
		let load = loads.get(target);
		if (!load) {
			load = (async () => {
				if (target.base64 !== undefined) return base64ToBlob(target.base64, target.mediaType);
				if (target.path) {
					const response = await ws.http('files:read-content', { path: target.path });
					if (!response.content) return null;
					return base64ToBlob(response.content, target.mediaType || response.contentType);
				}
				return null;
			})().catch((error) => {
				debug.warn('chat', `Could not read ${target.name}:`, error);
				loads.delete(target);
				return null;
			});
			loads.set(target, load);
		}
		return load;
	}

	function step(direction: 1 | -1) {
		if (!hasMany) return;
		index = (index + direction + items.length) % items.length;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (!isOpen) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
		} else if (event.key === 'ArrowRight' && hasMany) {
			event.preventDefault();
			step(1);
		} else if (event.key === 'ArrowLeft' && hasMany) {
			event.preventDefault();
			step(-1);
		}
	}

	// A horizontal swipe over an image moves to the next or previous file.
	// Documents keep their swipes: they scroll and zoom.
	let touchStart: { x: number; y: number } | null = null;
	function handleTouchStart(event: TouchEvent) {
		if (event.touches.length !== 1 || !item || previewKind(item.name, item.mediaType) !== 'image') {
			touchStart = null;
			return;
		}
		touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
	}
	function handleTouchEnd(event: TouchEvent) {
		if (!touchStart) return;
		const touch = event.changedTouches[0];
		const dx = touch.clientX - touchStart.x;
		const dy = touch.clientY - touchStart.y;
		touchStart = null;
		if (Math.abs(dx) > 60 && Math.abs(dy) < 50) step(dx < 0 ? 1 : -1);
	}

	async function download() {
		if (!item) return;
		const target = item;
		const blob = await blobOf(target);
		if (!blob) return;
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = target.name;
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	async function openInNewTab() {
		if (!item) return;
		// Opened before the await, or a mobile browser blocks it as a popup.
		const tab = window.open('', '_blank');
		const blob = await blobOf(item);
		if (!blob) {
			tab?.close();
			return;
		}
		const url = URL.createObjectURL(blob);
		if (tab) tab.location.href = url;
		else window.open(url, '_blank');
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	}

	$effect(() => {
		if (!isOpen) return;
		const previous = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.body.style.overflow = previous;
		};
	});
</script>

<svelte:window onkeydown={handleKeydown} />

{#if isOpen && item}
	<div
		use:portal
		class="fixed inset-0 z-[150] flex flex-col bg-black/85 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
		aria-label="View attachment"
		tabindex="-1"
		in:fade={{ duration: 160, easing: cubicOut }}
		out:fade={{ duration: 120, easing: cubicOut }}
	>
		<!-- Header: which file, where in the set, and what can be done with it -->
		<div class="flex items-center gap-2 px-2 sm:px-4 py-2 text-white shrink-0">
			{#if item.number}
				<span class="inline-flex items-center justify-center min-w-6 h-6 px-1.5 rounded-md bg-violet-600 text-xs font-semibold tabular-nums shrink-0" title="Write @{item.number} to refer to this file">
					@{item.number}
				</span>
			{/if}
			<Icon name={getAttachmentIcon(item.name, item.mediaType)} class="w-5 h-5 shrink-0" />
			<div class="min-w-0 flex-1">
				<div class="text-sm font-medium truncate" title={item.name}>{item.name}</div>
				{#if item.size !== undefined}
					<div class="text-xs text-white/60">{formatFileSize(item.size)}</div>
				{/if}
			</div>

			{#if hasMany}
				<div class="flex items-center gap-0.5 shrink-0">
					<button type="button" onclick={() => step(-1)} class="inline-flex items-center justify-center w-9 h-9 rounded-lg hover:bg-white/15 transition-colors" aria-label="Previous file" title="Previous (←)">
						<Icon name="lucide:chevron-left" class="w-5 h-5" />
					</button>
					<span class="text-xs tabular-nums text-white/80 min-w-10 text-center">{index + 1} / {items.length}</span>
					<button type="button" onclick={() => step(1)} class="inline-flex items-center justify-center w-9 h-9 rounded-lg hover:bg-white/15 transition-colors" aria-label="Next file" title="Next (→)">
						<Icon name="lucide:chevron-right" class="w-5 h-5" />
					</button>
				</div>
				<span class="w-px h-5 bg-white/20 shrink-0"></span>
			{/if}

			<button type="button" onclick={openInNewTab} class="inline-flex items-center justify-center w-9 h-9 rounded-lg hover:bg-white/15 transition-colors shrink-0" aria-label="Open in new tab" title="Open in new tab">
				<Icon name="lucide:external-link" class="w-4.5 h-4.5" />
			</button>
			<button type="button" onclick={download} class="inline-flex items-center justify-center w-9 h-9 rounded-lg hover:bg-white/15 transition-colors shrink-0" aria-label="Download" title="Download">
				<Icon name="lucide:download" class="w-4.5 h-4.5" />
			</button>
			<button type="button" onclick={onClose} class="inline-flex items-center justify-center w-9 h-9 rounded-lg hover:bg-white/15 transition-colors shrink-0" aria-label="Close" title="Close (Esc)">
				<Icon name="lucide:x" class="w-5 h-5" />
			</button>
		</div>

		<!-- The file -->
		<div
			class="flex-1 min-h-0 w-full max-w-6xl mx-auto sm:px-4 sm:pb-4"
			ontouchstart={handleTouchStart}
			ontouchend={handleTouchEnd}
			role="presentation"
		>
			<div class="h-full w-full overflow-hidden sm:rounded-xl bg-white dark:bg-slate-900">
				{#key item}
					{@const shown = item}
					<MediaPreview
						fileName={shown.name}
						filePath={shown.path ?? `attachment:${index}:${shown.name}`}
						mediaType={shown.mediaType}
						loadBlob={() => blobOf(shown)}
						textPreview
						fileActions={false}
					/>
				{/key}
			</div>
		</div>
	</div>
{/if}
