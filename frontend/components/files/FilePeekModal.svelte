<script lang="ts">
	// Transient single-file viewer shown as a modal when a file link is activated
	// while the Files panel isn't part of the layout. Deliberately lightweight —
	// no tree, no tabs, no panel header — just the clicked file, viewable and
	// editable (Ctrl+S / the FileViewer toolbar save through to disk). Uses the
	// shared Modal so it goes fullscreen on small screens, like Settings.
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import FileViewer from '$frontend/components/files/FileViewer.svelte';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { filePeekState, closeFilePeek } from '$frontend/stores/ui/file-peek.svelte';
	import ws from '$frontend/utils/ws';
	import type { FileNode } from '$shared/types/filesystem';
	import type { IconName } from '$shared/types/ui/icons';

	const projectPath = $derived(projectState.currentProject?.path || '');
	const projectId = $derived(projectState.currentProject?.id || '');

	let file = $state<FileNode | null>(null);
	let content = $state('');
	let savedContent = $state('');
	let isLoading = $state(false);
	let isBinary = $state(false);
	let loadError = $state('');
	// Disk mtime the loaded content is based on — passed to write-file as an
	// optimistic-concurrency token so a save can't clobber a newer on-disk copy.
	let savedMtime = $state<string | undefined>(undefined);

	const fileName = $derived(filePeekState.path?.split(/[\\/]/).pop() || '');
	const fileIcon = $derived((fileName ? getFileIcon(fileName) : 'lucide:file') as IconName);
	const relativePath = $derived.by(() => {
		const p = filePeekState.path;
		if (!p) return '';
		if (projectPath && p.startsWith(projectPath)) {
			return p.slice(projectPath.length).replace(/^[/\\]/, '');
		}
		return p;
	});

	// Load the target file whenever the peek path changes. A token guards against
	// a slow load resolving after the user already peeked a different file.
	let loadToken = 0;
	$effect(() => {
		const path = filePeekState.path;
		if (!path) {
			file = null;
			content = '';
			savedContent = '';
			isBinary = false;
			loadError = '';
			savedMtime = undefined;
			return;
		}
		const token = ++loadToken;
		void loadFile(path, token);
	});

	async function loadFile(path: string, token: number) {
		isLoading = true;
		loadError = '';
		try {
			const data = await ws.http('files:read-file', { file_path: path });
			if (token !== loadToken) return; // superseded by a newer peek
			const text = data.content || '';
			content = text;
			savedContent = text;
			isBinary = data.isBinary || false;
			savedMtime = data.modified;
			file = {
				name: path.split(/[\\/]/).pop() || path,
				path,
				type: 'file',
				size: typeof data.size === 'number' ? data.size : 0,
				modified: data.modified ? new Date(data.modified) : new Date()
			};
		} catch (err) {
			if (token !== loadToken) return;
			loadError = err instanceof Error ? err.message : 'Failed to open file';
			file = null;
		} finally {
			if (token === loadToken) isLoading = false;
		}
	}

	async function handleSave(filePath: string, newContent: string) {
		const res = await ws.http('files:write-file', {
			filePath,
			content: newContent,
			baseModified: savedMtime
		});
		savedContent = newContent;
		savedMtime = res?.modified;
	}
</script>

<Modal
	isOpen={!!filePeekState.path}
	onClose={closeFilePeek}
	bare
	mobileFullscreen
	ariaLabelledBy="file-peek-title"
	className="flex flex-col w-full max-w-5xl h-[85dvh] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden shadow-2xl"
>
	{#snippet children()}
		<!-- Slim header: file identity + close (no panel chrome) -->
		<div
			class="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-700"
		>
			<Icon name={fileIcon} class="w-4 h-4 shrink-0" />
			<span
				id="file-peek-title"
				class="text-sm font-medium text-slate-800 dark:text-slate-200 truncate"
			>
				{fileName}
			</span>
			{#if relativePath && relativePath !== fileName}
				<span
					class="text-2xs text-slate-400 dark:text-slate-500 truncate min-w-0"
					dir="rtl"
				>{relativePath}</span>
			{/if}
			<button
				type="button"
				class="ml-auto flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-300 transition-colors bg-transparent border-none cursor-pointer"
				onclick={closeFilePeek}
				title="Close (Esc)"
			>
				<Icon name="lucide:x" class="w-4 h-4" />
			</button>
		</div>

		<!-- Body: the clicked file, viewable + editable -->
		<div class="flex-1 min-h-0">
			{#if loadError}
				<div
					class="h-full flex items-center justify-center p-6 text-center text-sm text-red-600 dark:text-red-400"
				>
					{loadError}
				</div>
			{:else}
				<FileViewer
					{file}
					{content}
					{savedContent}
					{isLoading}
					error=""
					onSave={handleSave}
					{isBinary}
					{projectPath}
					{projectId}
				/>
			{/if}
		</div>
	{/snippet}
</Modal>
