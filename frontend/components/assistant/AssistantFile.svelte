<script lang="ts">
	/**
	 * A file Clopen sent the owner: an image inline that opens large in place
	 * (never a new tab — the owner stays in Clopen), anything else as a
	 * download. Fetched with the session token (the route is signed-in only),
	 * so it works the same over Remote Access as on this computer.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';

	interface Props {
		file: { url: string; filename: string; mime: string; size?: number };
		compact?: boolean;
	}

	const { file, compact = false }: Props = $props();
	let objectUrl = $state<string | null>(null);
	let failed = $state(false);
	let open = $state(false);
	const isImage = $derived(file.mime.startsWith('image/') && file.mime !== 'image/svg+xml');

	$effect(() => {
		const url = file.url;
		let revoked: string | null = null;
		void fetch(url, { headers: { Authorization: `Bearer ${authStore.sessionToken ?? ''}` } })
			.then(async (response) => {
				if (!response.ok) throw new Error(String(response.status));
				revoked = URL.createObjectURL(await response.blob());
				objectUrl = revoked;
			})
			.catch(() => (failed = true));
		return () => {
			if (revoked) URL.revokeObjectURL(revoked);
		};
	});
</script>

{#if isImage && objectUrl}
	<button type="button" class="block p-0 border-none bg-transparent cursor-zoom-in" onclick={() => (open = true)} aria-label="Open {file.filename}">
		<img src={objectUrl} alt={file.filename} class="rounded-lg border border-slate-200 dark:border-slate-800 {compact ? 'max-h-40' : 'max-h-80'} max-w-full object-contain" />
	</button>
	<Modal isOpen={open} onClose={() => (open = false)} bare className="relative flex flex-col items-center gap-3 max-w-[92vw] max-h-[92dvh]">
		{#snippet children()}
			<img src={objectUrl} alt={file.filename} class="max-w-[92vw] max-h-[82dvh] object-contain rounded-lg shadow-2xl" />
			<div class="flex items-center gap-2">
				<a href={objectUrl} download={file.filename} class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/90 dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-100 no-underline">
					<Icon name="lucide:download" class="w-4 h-4" /> Download
				</a>
				<button type="button" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/90 dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-100 border-none cursor-pointer" onclick={() => (open = false)}>
					<Icon name="lucide:x" class="w-4 h-4" /> Close
				</button>
			</div>
		{/snippet}
	</Modal>
{:else}
	<a
		href={objectUrl ?? undefined}
		download={file.filename}
		class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-300 {objectUrl ? 'hover:border-violet-500/40' : 'opacity-60 pointer-events-none'}"
	>
		<Icon name={failed ? 'lucide:file-x' : 'lucide:file'} class="w-3.5 h-3.5" />
		{file.filename}
	</a>
{/if}
