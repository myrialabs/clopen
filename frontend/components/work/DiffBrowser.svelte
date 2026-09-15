<script lang="ts">
	/**
	 * A set of file changes: a tree on the left, the diff on the right.
	 *
	 * The diff is rendered by the SHARED Monaco diff editor — the same component
	 * the Files panel and the Git panel use. The surface had its own renderer,
	 * which coloured patch lines by their leading character and laid the split
	 * view out as a two-column grid. A grid cannot align two files: one side's
	 * wrapped or overlong line pushes its row taller than the row opposite, and
	 * the columns walk out of step for the rest of the hunk. Monaco already
	 * solves that, along with syntax highlighting, search, folding and the
	 * side-by-side toggle, and using it means a diff reads the same everywhere
	 * in Clopen rather than nearly the same in three places.
	 *
	 * One file at a time, chosen from the tree, because a diff editor per file
	 * in one scroll is a dozen editors competing for the same scroll gesture.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import MonacoDiffEditor from '$frontend/components/common/editor/MonacoDiffEditor.svelte';
	import { detectLanguageFromFilename } from '$frontend/components/common/editor/monaco-languages';
	import { SvelteSet } from 'svelte/reactivity';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { copyText } from '$frontend/utils/clipboard';
	import { showInfo } from '$frontend/stores/ui/notification.svelte';
	import { settings, updateSettings } from '$frontend/stores/features/settings.svelte';
	import { splitUnifiedPatch } from '$frontend/utils/unified-patch';
	import FileContentModal from './FileContentModal.svelte';
	import type { FileChange } from '$shared/types/work';

	interface Props {
		files: FileChange[];
		/** What to say when there is nothing to show. */
		emptyLabel?: string;
	}

	const { files, emptyLabel = 'No file changes to show.' }: Props = $props();

	// This surface's own preference, and it starts at one column: a review diff
	// shares its pane with a tree and a header, so two columns start narrow here
	// in a way they do not in the Git panel — and reading someone else's change
	// is mostly reading the new side.
	const renderSideBySide = $derived(settings.workDiffSideBySide);

	let selectedPath = $state<string | null>(null);
	let viewing = $state<FileChange | null>(null);
	const collapsed = new SvelteSet<string>();

	/**
	 * The file being read.
	 *
	 * Resolved by lookup with a fallback rather than corrected in an effect: a
	 * new set of files (another commit, another pull request) simply stops
	 * matching the remembered path, and the first file answers instead. An
	 * effect that wrote the selection back would be an effect that re-runs on the
	 * state it just wrote.
	 */
	const active = $derived(files.find((file) => file.path === selectedPath) ?? files[0] ?? null);

	const totals = $derived(
		files.reduce(
			(acc, file) => ({
				additions: acc.additions + file.additions,
				deletions: acc.deletions + file.deletions
			}),
			{ additions: 0, deletions: 0 }
		)
	);

	const sides = $derived(splitUnifiedPatch(active?.patch));
	const language = $derived(active ? detectLanguageFromFilename(active.path) : 'plaintext');

	interface TreeNode {
		name: string;
		path: string;
		file: FileChange | null;
		children: TreeNode[];
	}

	/**
	 * Group paths into folders.
	 *
	 * A flat list of `src/pages/Product/components/Thing.tsx` repeated twenty
	 * times is unreadable; the shared prefix is most of every row.
	 */
	const tree = $derived.by(() => {
		const root: TreeNode = { name: '', path: '', file: null, children: [] };

		for (const file of files) {
			const parts = file.path.split('/');
			let node = root;
			parts.forEach((part, index) => {
				const path = parts.slice(0, index + 1).join('/');
				const isLeaf = index === parts.length - 1;
				let next = node.children.find((child) => child.name === part && child.path === path);
				if (!next) {
					next = { name: part, path, file: isLeaf ? file : null, children: [] };
					node.children.push(next);
				}
				node = next;
			});
		}

		// Collapse single-child folder chains: `src > pages > Product` reads
		// better as one row than as three, and it is what every diff view does.
		const squash = (node: TreeNode): TreeNode => {
			let current = node;
			while (current.file === null && current.children.length === 1 && current.children[0].file === null) {
				const only = current.children[0];
				current = { ...only, name: `${current.name}/${only.name}` };
			}
			return { ...current, children: current.children.map(squash) };
		};

		return root.children.map(squash);
	});

	function toggleFolder(path: string) {
		if (collapsed.has(path)) collapsed.delete(path);
		else collapsed.add(path);
	}

	async function copyPath(path: string) {
		const ok = await copyText(path);
		showInfo(ok ? 'Copied' : 'Could not copy', ok ? path : 'The clipboard refused the request.');
	}

	function statusTone(status: string): string {
		if (status === 'added') return 'text-green-600 dark:text-green-400';
		if (status === 'removed') return 'text-red-600 dark:text-red-400';
		if (status === 'renamed') return 'text-violet-600 dark:text-violet-400';
		return 'text-slate-500 dark:text-slate-400';
	}
</script>

{#snippet treeRows(nodes: TreeNode[], depth: number)}
	{#each nodes as node (node.path)}
		{#if node.file}
			<button
				type="button"
				class="flex items-center gap-1.5 w-full h-7 shrink-0 pr-2 text-left text-xs rounded-md cursor-pointer transition-colors duration-150
					{node.path === active?.path
					? 'bg-violet-500/10 text-slate-900 dark:text-slate-100'
					: 'text-slate-600 dark:text-slate-400 hover:bg-violet-500/5'}"
				style="padding-left: {depth * 0.75 + 0.5}rem"
				onclick={() => (selectedPath = node.path)}
				title={node.path}
			>
				<Icon name={getFileIcon(node.name)} class="w-3.5 h-3.5 shrink-0" />
				<span class="flex-1 min-w-0 truncate">{node.name}</span>
				<span class="shrink-0 text-[0.65rem] text-green-600 dark:text-green-400">+{node.file.additions}</span>
				<span class="shrink-0 text-[0.65rem] text-red-600 dark:text-red-400">−{node.file.deletions}</span>
			</button>
		{:else}
			<button
				type="button"
				class="flex items-center gap-1.5 w-full h-7 shrink-0 pr-2 text-left text-xs text-slate-500 dark:text-slate-400 rounded-md cursor-pointer hover:bg-violet-500/5"
				style="padding-left: {depth * 0.75 + 0.5}rem"
				onclick={() => toggleFolder(node.path)}
			>
				<Icon
					name={collapsed.has(node.path) ? 'lucide:chevron-right' : 'lucide:chevron-down'}
					class="w-3 h-3 shrink-0"
				/>
				<Icon name="lucide:folder" class="w-3.5 h-3.5 shrink-0" />
				<span class="flex-1 min-w-0 truncate font-medium">{node.name}</span>
			</button>
			{#if !collapsed.has(node.path)}
				{@render treeRows(node.children, depth + 1)}
			{/if}
		{/if}
	{/each}
{/snippet}

{#if files.length === 0}
	<p class="text-sm text-slate-500 dark:text-slate-500 m-0 px-1 py-6 text-center">{emptyLabel}</p>
{:else}
	<div class="flex h-full min-h-0">
		<aside class="hidden md:flex flex-col w-56 shrink-0 border-r border-slate-200 dark:border-slate-800">
			<div class="flex items-center gap-1.5 px-2 py-1.5 shrink-0 text-[0.7rem] text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
				<span>{files.length} file{files.length === 1 ? '' : 's'}</span>
				<span class="text-green-600 dark:text-green-400">+{totals.additions}</span>
				<span class="text-red-600 dark:text-red-400">−{totals.deletions}</span>
			</div>
			<div class="flex flex-col gap-0.5 flex-1 min-h-0 overflow-y-auto p-1">
				{@render treeRows(tree, 0)}
			</div>
		</aside>

		<div class="flex flex-col flex-1 min-w-0 min-h-0">
			{#if active}
				<!--
					Narrow screens get the same choice the tree offers, as a native
					select: the tree costs 14rem this layout does not have, and
					"one file, no way to reach the others" is not a mobile view.
				-->
				<div class="flex md:hidden items-center gap-2 px-3 py-1.5 shrink-0 border-b border-slate-200 dark:border-slate-800">
					<Icon name="lucide:files" class="w-3.5 h-3.5 shrink-0 text-slate-500" />
					<select
						class="flex-1 min-w-0 h-8 px-2 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
						value={active.path}
						onchange={(event) => (selectedPath = event.currentTarget.value)}
						aria-label="Pick a file"
					>
						{#each files as file (file.path)}
							<option value={file.path}>{file.path} (+{file.additions} −{file.deletions})</option>
						{/each}
					</select>
				</div>

				<header class="flex items-center gap-2 px-3 py-1.5 shrink-0 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
					<Icon name={getFileIcon(active.path)} class="w-3.5 h-3.5 shrink-0" />
					<span class="flex-1 min-w-0 truncate text-xs font-mono text-slate-800 dark:text-slate-200" title={active.path}>
						{active.path}
					</span>
					<span class="shrink-0 text-[0.65rem] capitalize {statusTone(active.status)}">{active.status}</span>
					<span class="shrink-0 text-xs text-green-600 dark:text-green-400">+{active.additions}</span>
					<span class="shrink-0 text-xs text-red-600 dark:text-red-400">−{active.deletions}</span>
					<button
						type="button"
						class="flex items-center justify-center w-6 h-6 shrink-0 bg-transparent border-none rounded text-slate-500 cursor-pointer hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
						onclick={() => updateSettings({ workDiffSideBySide: !settings.workDiffSideBySide })}
						title={renderSideBySide ? 'Switch to inline (1 column)' : 'Switch to side-by-side (2 columns)'}
						aria-label="Toggle diff layout"
					>
						<Icon name={renderSideBySide ? 'lucide:rows-2' : 'lucide:columns-2'} class="w-3 h-3" />
					</button>
					<button
						type="button"
						class="flex items-center justify-center w-6 h-6 shrink-0 bg-transparent border-none rounded text-slate-500 cursor-pointer hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
						onclick={() => copyPath(active.path)}
						title="Copy the path"
						aria-label="Copy the path"
					>
						<Icon name="lucide:copy" class="w-3 h-3" />
					</button>
					<button
						type="button"
						class="flex items-center justify-center w-6 h-6 shrink-0 bg-transparent border-none rounded text-slate-500 cursor-pointer hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
						onclick={() => (viewing = active)}
						title="View the whole file"
						aria-label="View the whole file"
					>
						<Icon name="lucide:file-search" class="w-3 h-3" />
					</button>
					{#if active.url}
						<a
							href={active.url}
							target="_blank"
							rel="noreferrer noopener"
							class="flex items-center justify-center w-6 h-6 shrink-0 rounded text-slate-500 no-underline hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
							title="Open the file on the web"
						>
							<Icon name="lucide:external-link" class="w-3 h-3" />
						</a>
					{/if}
				</header>

				{#if sides.isEmpty}
					<div class="flex flex-col items-center justify-center gap-2 flex-1 px-6 text-center">
						<Icon name="lucide:file-diff" class="w-8 h-8 text-slate-300 dark:text-slate-700" />
						<p class="text-sm text-slate-600 dark:text-slate-400 m-0">No inline diff for this file</p>
						<p class="text-xs text-slate-500 dark:text-slate-500 m-0">
							It is binary, or its patch was too large to send. The whole file still opens.
						</p>
						<button
							type="button"
							class="flex items-center gap-1.5 h-8 px-3 text-xs font-medium bg-transparent border border-slate-300 dark:border-slate-600 rounded-md text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-violet-500/10"
							onclick={() => (viewing = active)}
						>
							<Icon name="lucide:file-search" class="w-3.5 h-3.5" />
							View the whole file
						</button>
					</div>
				{:else}
					<div class="flex-1 min-h-0 overflow-hidden">
						<!-- Keyed on the path: a diff editor is rebuilt per file rather
						     than having two models swapped underneath it. -->
						{#key active.path}
							<MonacoDiffEditor
								original={sides.original}
								modified={sides.modified}
								originalLineNumbers={sides.originalLineNumbers}
								modifiedLineNumbers={sides.modifiedLineNumbers}
								{language}
								originalPath={active.previousPath ?? active.path}
								modifiedPath={active.path}
								{renderSideBySide}
								fontScale={0.78}
							/>
						{/key}
					</div>
				{/if}
			{/if}
		</div>
	</div>
{/if}

<FileContentModal file={viewing} onClose={() => (viewing = null)} />
