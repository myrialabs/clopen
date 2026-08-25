<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import FileChangeItem from './FileChangeItem.svelte';
	import type { GitFileChange } from '$shared/types/git';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		title: string;
		icon: IconName;
		files: GitFileChange[];
		section: 'staged' | 'unstaged' | 'untracked' | 'conflicted';
		collapsed?: boolean;
		activeFilePath?: string | null;
		activeSection?: string | null;
		onStage?: (path: string) => void;
		onUnstage?: (path: string) => void;
		onDiscard?: (path: string) => void;
		onStageAll?: () => void;
		onUnstageAll?: () => void;
		onDiscardAll?: () => void;
		onStash?: () => void;
		onViewDiff?: (file: GitFileChange, section: string) => void;
		onResolve?: (path: string) => void;
		aiChangesSet?: Set<string>;
	}

	let {
		title, icon, files, section,
		collapsed: isCollapsed = $bindable(false),
		activeFilePath = null,
		activeSection = null,
		onStage, onUnstage, onDiscard,
		onStageAll, onUnstageAll, onDiscardAll,
		onStash,
		onViewDiff, onResolve,
		aiChangesSet = new Set<string>()
	}: Props = $props();

	function isFileActive(filePath: string): boolean {
		if (!activeFilePath || activeFilePath !== filePath) return false;
		// Treat 'unstaged' and 'untracked' as the same group — viewDiff dispatches via 'unstaged'
		if (activeSection === section) return true;
		const unstagedGroup = section === 'unstaged' || section === 'untracked';
		const activeUnstagedGroup = activeSection === 'unstaged' || activeSection === 'untracked';
		return unstagedGroup && activeUnstagedGroup;
	}

	// Virtual scroll — only render visible items when list is large
	const ITEM_HEIGHT = 32;
	const BUFFER = 10;
	const VIRTUALIZE_THRESHOLD = 200;

	let scrollEl = $state<HTMLDivElement>();
	let headerEl = $state<HTMLDivElement>();
	let scrollTop = $state(0);
	let containerHeight = $state(384);
	let panelHeight = $state(0);

	const shouldVirtualize = $derived(files.length > VIRTUALIZE_THRESHOLD);
	const visibleStart = $derived(
		shouldVirtualize ? Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER) : 0
	);
	const visibleEnd = $derived(
		shouldVirtualize
			? Math.min(files.length, Math.ceil((scrollTop + containerHeight) / ITEM_HEIGHT) + BUFFER)
			: files.length
	);
	const visibleFiles = $derived(files.slice(visibleStart, visibleEnd));
	const topPad = $derived(visibleStart * ITEM_HEIGHT);
	const bottomPad = $derived(Math.max(0, (files.length - visibleEnd) * ITEM_HEIGHT));

	// Dynamic max-height: fill panel minus section header — no gap
	const headerH = $derived(headerEl?.offsetHeight ?? 48);
	const scrollMaxH = $derived(panelHeight > 0 ? Math.max(128, panelHeight - headerH) : 384);

	// Track nearest scrollable ancestor size via ResizeObserver
	$effect(() => {
		const el = scrollEl;
		if (!el) return;

		let parent = el.parentElement;
		while (parent && parent !== document.body) {
			const ov = getComputedStyle(parent).overflowY;
			if (ov === 'auto' || ov === 'scroll') break;
			parent = parent.parentElement;
		}
		if (!parent || parent === document.body) return;

		const obs = new ResizeObserver(() => {
			panelHeight = parent!.clientHeight;
			containerHeight = el.clientHeight || 384;
		});
		obs.observe(parent);
		panelHeight = parent.clientHeight;
		containerHeight = el.clientHeight || 384;

		return () => obs.disconnect();
	});

	// Reset scroll position when section is expanded (container remounts)
	$effect(() => {
		if (!isCollapsed) {
			scrollTop = 0;
		}
	});

	function onScroll(e: Event) {
		const el = e.currentTarget as HTMLDivElement;
		scrollTop = el.scrollTop;
		containerHeight = el.clientHeight;
	}
</script>

{#if files.length > 0}
	<div class="mb-1">
		<!-- Section header -->
		<div
			bind:this={headerEl}
			onclick={() => isCollapsed = !isCollapsed}
			class="group flex items-center gap-2 py-3 px-2 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800/40 rounded-md transition-colors">
			<div
				class="flex items-center gap-2 flex-1 min-w-0 bg-transparent border-none text-left cursor-pointer p-0"
			>
				<Icon
					name={isCollapsed ? 'lucide:chevron-right' : 'lucide:chevron-down'}
					class="w-4 h-4 text-slate-500 shrink-0"
				/>
				<!-- <Icon name={icon} class="w-4 h-4 text-slate-500 shrink-0" /> -->
				<span class="text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
					{title}
				</span>
				<span class="text-xs font-medium text-slate-400 dark:text-slate-600 ml-0.5">
					{files.length}
				</span>
			</div>

			<!-- Bulk actions (hidden until hover) -->
			<div class="flex items-center gap-0.5 shrink-0 -my-2">
				{#if onStash}
					<button
						type="button"
						class="flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-violet-500/10 hover:text-violet-500 transition-colors bg-transparent border-none cursor-pointer"
						onclick={(e) => { e.stopPropagation(); onStash?.(); }}
						title="Stash changes"
					>
						<Icon name="lucide:archive" class="w-3.5 h-3.5" />
					</button>
				{/if}
				{#if section === 'staged' && onUnstageAll}
					<button
						type="button"
						class="flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-red-500/10 hover:text-red-500 transition-colors bg-transparent border-none cursor-pointer"
						onclick={(e) => { e.stopPropagation(); onUnstageAll?.(); }}
						title="Unstage All"
					>
						<Icon name="lucide:minus" class="w-4 h-4" />
					</button>
				{:else if (section === 'unstaged' || section === 'untracked') && onStageAll}
					{#if onDiscardAll}
						<button
							type="button"
							class="flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-red-500/10 hover:text-red-500 transition-colors bg-transparent border-none cursor-pointer"
							onclick={(e) => { e.stopPropagation(); onDiscardAll?.(); }}
							title="Discard All"
						>
							<Icon name="lucide:undo-2" class="w-4 h-4" />
						</button>
					{/if}
					<button
						type="button"
						class="flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-emerald-500/10 hover:text-emerald-500 transition-colors bg-transparent border-none cursor-pointer"
						onclick={(e) => { e.stopPropagation(); onStageAll?.(); }}
						title="Stage All"
					>
						<Icon name="lucide:plus" class="w-4 h-4" />
					</button>
				{/if}
			</div>
		</div>

		<!-- Files list -->
		{#if !isCollapsed}
			{#if shouldVirtualize}
				<div
					class="ml-2 overflow-y-auto"
					style="max-height: {scrollMaxH}px"
					bind:this={scrollEl}
					onscroll={onScroll}
				>
					<div style="padding-top: {topPad}px; padding-bottom: {bottomPad}px;">
						{#each visibleFiles as file (file.path)}
							<div style="height: {ITEM_HEIGHT}px" class="overflow-hidden">
								<FileChangeItem
									{file}
									{section}
									isActive={isFileActive(file.path)}
									{onStage}
									{onUnstage}
									{onDiscard}
									{onViewDiff}
									{onResolve}
									{aiChangesSet}
								/>
							</div>
						{/each}
					</div>
				</div>
			{:else}
				<div class="ml-2">
					{#each files as file (file.path)}
						<FileChangeItem
							{file}
							{section}
							isActive={isFileActive(file.path)}
							{onStage}
							{onUnstage}
							{onDiscard}
							{onViewDiff}
							{onResolve}
							{aiChangesSet}
						/>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
{/if}
