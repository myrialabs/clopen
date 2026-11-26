<!--
  The files attached to the message being written: one row of equal cards that
  scrolls sideways, so it is as tall with two hundred files as with one and the
  message box below never gets pushed out of view. Each card carries the
  number `@N` refers to; clicking it opens the viewer on that file.
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Lightbox, { type ViewerItem } from '$frontend/components/common/overlay/Lightbox.svelte';
	import { getAttachmentIcon } from '$frontend/utils/file-icon-mappings';
	import { formatFileSize } from '$frontend/utils/format';
	import { mentionToken } from '$shared/utils/attachment-mentions';
	import type { FileAttachment } from '../composables/use-file-handling.svelte';

	interface Props {
		attachedFiles: FileAttachment[];
		/** Files still being read — shown as placeholders where they will land. */
		pendingCount?: number;
		onRemove: (id: string) => void;
		onClearAll: () => void;
	}

	const { attachedFiles, pendingCount = 0, onRemove, onClearAll }: Props = $props();

	const totalSize = $derived(attachedFiles.reduce((sum, attachment) => sum + attachment.file.size, 0));

	// The viewer, over every attached file.
	let viewerOpen = $state(false);
	let viewerIndex = $state(0);
	const viewerItems = $derived<ViewerItem[]>(
		attachedFiles.map((attachment, i) => ({
			name: attachment.file.name,
			mediaType: attachment.file.type,
			size: attachment.file.size,
			number: i + 1,
			base64: attachment.base64
		}))
	);

	function openViewer(i: number) {
		viewerIndex = i;
		viewerOpen = true;
	}

	// Thumbnails the browser couldn't decode (HEIC outside Safari) show the icon.
	let brokenThumbnails = $state(new Set<string>());

	// --- Sideways scrolling ---
	let scroller = $state<HTMLDivElement>();
	let canScrollLeft = $state(false);
	let canScrollRight = $state(false);

	function updateEdges() {
		const el = scroller;
		if (!el) return;
		canScrollLeft = el.scrollLeft > 1;
		canScrollRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
	}

	// A mouse wheel scrolls the row sideways. Registered by hand: it has to be
	// able to stop the page scrolling, which a passive listener can't.
	$effect(() => {
		const el = scroller;
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
			if (el.scrollWidth <= el.clientWidth) return;
			event.preventDefault();
			el.scrollLeft += event.deltaY;
		};
		const resize = new ResizeObserver(updateEdges);
		resize.observe(el);
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => {
			el.removeEventListener('wheel', onWheel);
			resize.disconnect();
		};
	});

	// A newly attached file scrolls into view at the end of the row.
	let lastCount = 0;
	$effect(() => {
		const count = attachedFiles.length + pendingCount;
		const el = scroller;
		if (el && count > lastCount) {
			requestAnimationFrame(() => {
				el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
				updateEdges();
			});
		} else {
			requestAnimationFrame(updateEdges);
		}
		lastCount = count;
	});
</script>

{#if attachedFiles.length > 0 || pendingCount > 0}
	<div class="mb-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
		<div class="flex items-center gap-2 px-3 pt-2 text-xs text-slate-500 dark:text-slate-400">
			<span class="min-w-0 truncate">
				{attachedFiles.length} {attachedFiles.length === 1 ? 'file' : 'files'}{#if attachedFiles.length > 0}&nbsp;· {formatFileSize(totalSize)}{/if}{#if pendingCount > 0}&nbsp;· reading {pendingCount}…{/if}
				<span class="hidden sm:inline">&nbsp;· type <span class="font-mono text-violet-600 dark:text-violet-400">@</span> to mention one</span>
			</span>
			{#if attachedFiles.length > 1}
				<button
					type="button"
					onclick={onClearAll}
					class="ml-auto shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
				>
					<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
					Clear all
				</button>
			{/if}
		</div>

		<div class="relative">
			<div
				bind:this={scroller}
				onscroll={updateEdges}
				class="flex gap-2 overflow-x-auto px-2 pt-1.5 pb-2 attachment-row"
				role="list"
				aria-label="Attached files"
			>
				{#each attachedFiles as attachment, i (attachment.id)}
					<div
						role="listitem"
						class="group relative flex items-center shrink-0 w-48 h-14 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
					>
						<button
							type="button"
							onclick={() => openViewer(i)}
							disabled={!attachment.base64}
							class="flex items-center gap-2 min-w-0 flex-1 h-full pl-1.5 pr-1 rounded-l-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:cursor-default disabled:hover:bg-transparent text-left"
							title="Preview {attachment.file.name}"
							aria-label="Preview attachment {mentionToken(i + 1)}, {attachment.file.name}"
						>
							<span class="relative flex items-center justify-center w-10 h-10 shrink-0 rounded-md overflow-hidden bg-slate-100 dark:bg-slate-800">
								{#if attachment.type === 'image' && attachment.previewUrl && !brokenThumbnails.has(attachment.id)}
									<img
										src={attachment.previewUrl}
										alt=""
										class="w-full h-full object-cover"
										onerror={() => (brokenThumbnails = new Set(brokenThumbnails).add(attachment.id))}
									/>
								{:else}
									<Icon name={getAttachmentIcon(attachment.file.name, attachment.file.type)} class="w-6 h-6" />
								{/if}
								<span class="absolute top-0 left-0 px-1 rounded-br-md bg-violet-600 text-white text-3xs font-semibold leading-4 tabular-nums">
									{mentionToken(i + 1)}
								</span>
							</span>
							<span class="flex flex-col min-w-0">
								<span class="text-xs font-medium text-slate-700 dark:text-slate-200 truncate">{attachment.file.name}</span>
								<span class="text-3xs text-slate-500 dark:text-slate-400">{formatFileSize(attachment.file.size)}</span>
							</span>
						</button>
						<button
							type="button"
							onclick={() => onRemove(attachment.id)}
							class="flex items-center justify-center w-8 h-full shrink-0 rounded-r-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
							title="Remove"
							aria-label="Remove {attachment.file.name}"
						>
							<Icon name="lucide:x" class="w-3.5 h-3.5" />
						</button>
					</div>
				{/each}
				{#each { length: pendingCount } as _, i (i)}
					<div
						role="listitem"
						class="flex items-center gap-2 shrink-0 w-48 h-14 px-1.5 rounded-lg border border-dashed border-slate-300 dark:border-slate-600 bg-white/60 dark:bg-slate-900/60"
						aria-label="Reading a file"
					>
						<span class="flex items-center justify-center w-10 h-10 rounded-md bg-slate-100 dark:bg-slate-800">
							<Icon name="lucide:loader-circle" class="w-4 h-4 text-violet-500 animate-spin" />
						</span>
						<span class="text-xs text-slate-500">Reading…</span>
					</div>
				{/each}
			</div>

			<!-- Fades say there is more to either side -->
			{#if canScrollLeft}
				<div class="pointer-events-none absolute inset-y-0 left-0 w-6 rounded-bl-xl bg-gradient-to-r from-slate-50 dark:from-slate-800 to-transparent"></div>
			{/if}
			{#if canScrollRight}
				<div class="pointer-events-none absolute inset-y-0 right-0 w-6 rounded-br-xl bg-gradient-to-l from-slate-50 dark:from-slate-800 to-transparent"></div>
			{/if}
		</div>
	</div>
{/if}

<Lightbox bind:isOpen={viewerOpen} bind:index={viewerIndex} items={viewerItems} onClose={() => (viewerOpen = false)} />

<style>
	.attachment-row {
		scrollbar-width: thin;
		overscroll-behavior-x: contain;
	}
</style>
