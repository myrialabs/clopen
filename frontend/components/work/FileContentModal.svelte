<script lang="ts">
	/**
	 * One file's full text, at the revision being reviewed.
	 *
	 * A diff answers "what changed"; this answers "what does the surrounding
	 * code look like", which is the question that usually follows and the one
	 * that otherwise sends the reviewer to a browser tab.
	 *
	 * It is the SAME shell as "Open in Files" — the peek modal that chat and the
	 * Git panel open — rather than a second, poorer viewer with its own header
	 * and its own footer of buttons. The file here happens to come from a
	 * provider instead of from disk, which is a difference in where the text was
	 * read, not in how anyone wants to read it: syntax highlighting, the
	 * markdown/source toggle, search and copy all come from the shared viewer.
	 *
	 * Read-only, because there is nothing on disk to save to: no `onSave` is
	 * passed, and the viewer hides the save affordance when it has none.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import FileViewer from '$frontend/components/files/FileViewer.svelte';
	import { workStore } from '$frontend/stores/features/work.svelte';
	import { debug } from '$shared/utils/logger';
	import type { FileChange } from '$shared/types/work';
	import type { FileNode } from '$shared/types/filesystem';

	interface Props {
		file: FileChange | null;
		onClose: () => void;
	}

	const { file, onClose }: Props = $props();

	let node = $state<FileNode | null>(null);
	let content = $state('');
	let isLoading = $state(false);
	let loadError = $state('');
	/** The provider sent a prefix rather than the file — say so, do not hide it. */
	let truncated = $state(false);

	// A token guards against a slow read landing after the user opened another
	// file — the same guard the file-peek modal uses, for the same reason.
	let loadToken = 0;

	$effect(() => {
		const target = file;
		if (!target) {
			node = null;
			content = '';
			loadError = '';
			truncated = false;
			isLoading = false;
			return;
		}
		const token = ++loadToken;
		void load(target, token);
	});

	async function load(target: FileChange, token: number) {
		isLoading = true;
		loadError = '';
		content = '';
		truncated = false;
		// Named before the text arrives, so the viewer's header — which carries
		// the close button — is on screen while the read is in flight.
		node = {
			name: target.path.split('/').pop() || target.path,
			path: target.path,
			type: 'file',
			size: 0,
			modified: new Date()
		};

		try {
			const result = await workStore.fetchFileContent(target);
			if (token !== loadToken) return;
			if (result === null) {
				loadError = 'This provider cannot read file contents.';
				return;
			}
			content = result.content;
			truncated = result.truncated;
			node = { ...node, size: new TextEncoder().encode(result.content).length };
		} catch (error) {
			if (token !== loadToken) return;
			debug.warn('work', 'Could not read the file:', error);
			loadError = error instanceof Error ? error.message : 'Could not read the file.';
		} finally {
			if (token === loadToken) isLoading = false;
		}
	}
</script>

<Modal
	isOpen={!!file}
	{onClose}
	bare
	mobileFullscreen
	ariaLabelledBy="work-file-title"
	className="flex flex-col w-full max-w-5xl h-[85dvh] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden shadow-2xl"
>
	{#snippet children()}
		<div class="flex flex-col flex-1 min-h-0">
			{#if loadError}
				<div class="h-full flex flex-col items-center justify-center gap-2 p-6 text-center">
					<p class="text-sm text-red-600 dark:text-red-400 m-0">{loadError}</p>
					{#if file?.url}
						<a
							href={file.url}
							target="_blank"
							rel="noreferrer noopener"
							class="text-xs text-slate-500 dark:text-slate-400 underline underline-offset-2"
						>
							Open it on the web instead
						</a>
					{/if}
					<button
						type="button"
						class="h-8 px-3 mt-2 text-xs font-medium bg-transparent border border-slate-300 dark:border-slate-600 rounded-md text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-violet-500/10"
						onclick={onClose}
					>
						Close
					</button>
				</div>
			{:else}
				{#if truncated}
					<div class="flex items-start gap-2 shrink-0 px-4 py-2 border-b border-amber-500/30 bg-amber-500/10">
						<Icon name="lucide:triangle-alert" class="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
						<p class="flex-1 text-xs text-amber-800 dark:text-amber-300 m-0">
							Showing the first 2 MB of this file — the rest was left behind rather
							than sent over the wire.
						</p>
					</div>
				{/if}
				<div class="flex-1 min-h-0">
					<FileViewer
						file={node}
						{content}
						savedContent={content}
						{isLoading}
						error=""
						{onClose}
						titleId="work-file-title"
					/>
				</div>
			{/if}
		</div>
	{/snippet}
</Modal>
