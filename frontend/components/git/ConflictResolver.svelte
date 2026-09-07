<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import MonacoDiffEditor from '$frontend/components/common/editor/MonacoDiffEditor.svelte';
	import MonacoCodeEditor from '$frontend/components/common/editor/MonacoCodeEditor.svelte';
	import { detectLanguageFromFilename } from '$frontend/components/common/editor/monaco-languages';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import type { IconName } from '$shared/types/ui/icons';
	import type {
		GitConflictFile,
		GitConflictMarker,
		GitConflictResolution,
		GitOperationState
	} from '$shared/types/git';

	/** Per-marker pick inside the guided editor — narrower than a file resolution. */
	type Resolution = 'ours' | 'theirs' | 'both';

	/** Which two sides the diff editor compares. */
	type CompareMode = 'ours-theirs' | 'base-ours' | 'base-theirs';

	interface MarkerState {
		resolution: Resolution | null;
	}

	interface Props {
		isOpen: boolean;
		conflictFiles: GitConflictFile[];
		isLoading: boolean;
		initialPath?: string | null;
		onResolve: (filePath: string, resolution: GitConflictResolution, customContent?: string) => void;
		/**
		 * The in-progress operation, used to name the two sides. Without it the
		 * resolver can only say "ours"/"theirs", which is actively misleading
		 * during a rebase where those words swap meaning.
		 */
		operation?: GitOperationState | null;
		onResolveWithAI: (filePath: string) => void;
		onResolveAllWithAI: () => void;
		onAbortMerge: () => void;
		onClose: () => void;
		/**
		 * A resolve or abort is already running against this repo. Both are
		 * followed by a full status refresh, slow enough on Windows that the
		 * dialog looks unchanged long enough to invite a second click — which
		 * would resolve against a file the first call is still rewriting.
		 */
		busy?: boolean;
	}

	const {
		isOpen,
		conflictFiles,
		isLoading,
		initialPath = null,
		onResolve,
		operation = null,
		onResolveWithAI,
		onResolveAllWithAI,
		onAbortMerge,
		onClose,
		busy = false
	}: Props = $props();

	let selectedPath = $state<string | null>(null);
	let editMode = $state<'guided' | 'manual'>('guided');
	let currentMarkerIndex = $state(0);
	let manualContent = $state('');
	let showMoreMenu = $state(false);
	let showFileMenu = $state(false);
	let markerStatesMap = $state<Record<string, MarkerState[]>>({});
	let compareMode = $state<CompareMode>('ours-theirs');
	let isWideViewport = $state(true);
	let prevOpen = $state(false);

	$effect(() => {
		if (typeof window === 'undefined') return;
		const mq = window.matchMedia('(min-width: 768px)');
		isWideViewport = mq.matches;
		const handler = (e: MediaQueryListEvent) => {
			isWideViewport = e.matches;
		};
		mq.addEventListener('change', handler);
		return () => mq.removeEventListener('change', handler);
	});

	const selectedFile = $derived<GitConflictFile | null>(
		conflictFiles.find((f) => f.path === selectedPath) ?? null
	);

	const selectedFileMarkerStates = $derived<MarkerState[]>(
		selectedFile ? (markerStatesMap[selectedFile.path] ?? []) : []
	);

	const currentMarker = $derived<GitConflictMarker | null>(
		selectedFile?.markers[currentMarkerIndex] ?? null
	);

	const totalMarkers = $derived(selectedFile?.markers.length ?? 0);

	const resolvedCount = $derived(
		selectedFileMarkerStates.filter((s) => s?.resolution != null).length
	);

	const language = $derived(
		selectedFile ? detectLanguageFromFilename(selectedFile.path) : 'plaintext'
	);

	const allResolved = $derived(totalMarkers > 0 && resolvedCount === totalMarkers);

	// Name the two sides. A rebase replays your commits onto the upstream, so git's
	// `--ours` is the branch you are rebasing ONTO and `--theirs` is your own work —
	// the opposite of a merge. Showing the bare words is how people pick backwards.
	const oursLabel = $derived(operation?.oursLabel || 'HEAD');
	const theirsLabel = $derived(operation?.theirsLabel || 'incoming');
	const isRebase = $derived(operation?.operation === 'rebase');

	const headerTitle = $derived(
		operation?.operation === 'rebase'
			? 'Rebase Conflicts'
			: operation?.operation === 'cherry-pick'
				? 'Cherry-pick Conflicts'
				: operation?.operation === 'revert'
					? 'Revert Conflicts'
					: operation?.stashConflict
						? 'Stash Conflicts'
						: 'Merge Conflicts'
	);

	/**
	 * Only both-modified / both-added conflicts carry inline markers. Everything
	 * else is an add/delete disagreement (or a binary blob) where there is nothing
	 * to edit — those need the structural pane instead of the guided editor.
	 */
	function isEditable(file: GitConflictFile): boolean {
		return !file.contentOmitted && file.markers.length > 0;
	}

	const selectedIsEditable = $derived(Boolean(selectedFile && isEditable(selectedFile)));

	/** True when each side still has a version of the file (vs. deleted it). */
	function sidesPresent(file: GitConflictFile): { ours: boolean; theirs: boolean } {
		switch (file.kind) {
			case 'both-modified':
			case 'both-added':
				return { ours: true, theirs: true };
			case 'added-by-us':
			case 'deleted-by-them':
				return { ours: true, theirs: false };
			case 'added-by-them':
			case 'deleted-by-us':
				return { ours: false, theirs: true };
			case 'both-deleted':
				return { ours: false, theirs: false };
		}
	}

	/** One-line explanation of what the two sides actually did to this path. */
	function describeKind(file: GitConflictFile): string {
		switch (file.kind) {
			case 'both-modified':
				return `Modified on both ${oursLabel} and ${theirsLabel}.`;
			case 'both-added':
				return `Added independently on ${oursLabel} and ${theirsLabel}.`;
			case 'added-by-us':
				return `Added on ${oursLabel} only — ${theirsLabel} has no such file.`;
			case 'added-by-them':
				return `Added on ${theirsLabel} only — ${oursLabel} has no such file.`;
			case 'deleted-by-us':
				return `Deleted on ${oursLabel}, but modified on ${theirsLabel}.`;
			case 'deleted-by-them':
				return `Modified on ${oursLabel}, but deleted on ${theirsLabel}.`;
			case 'both-deleted':
				return 'Deleted on both sides, with conflicting history.';
		}
	}

	/** Why the text is missing, when it is. */
	function describeOmission(file: GitConflictFile): string {
		switch (file.omitReason) {
			case 'binary':
				return 'This is a binary file, so there is no text to merge — pick one side.';
			case 'missing':
				return 'There is no file in the working tree to edit.';
			case 'too-large':
				return 'This file is too large to open in the editor — pick one side, or resolve it outside Clopen.';
			default:
				return '';
		}
	}

	interface StructuralAction {
		id: GitConflictResolution;
		label: string;
		hint: string;
		tone: 'ours' | 'theirs' | 'neutral' | 'danger';
	}

	/**
	 * The answers git will accept for a conflict with no markers. "Use ours" on a
	 * path the other side deleted still resolves — it just resolves as a deletion,
	 * which the hint spells out so the button is never a surprise.
	 */
	function structuralActions(file: GitConflictFile): StructuralAction[] {
		const sides = sidesPresent(file);
		const actions: StructuralAction[] = [
			{
				id: 'ours',
				label: `Use ${oursLabel}`,
				hint: sides.ours ? 'Keep this side\u2019s version of the file' : 'Resolve as deleted',
				tone: 'ours'
			},
			{
				id: 'theirs',
				label: `Use ${theirsLabel}`,
				hint: sides.theirs ? 'Keep this side\u2019s version of the file' : 'Resolve as deleted',
				tone: 'theirs'
			}
		];

		if (file.omitReason !== 'missing') {
			actions.push({
				id: 'keep',
				label: 'Keep working file',
				hint: 'Stage the file exactly as it is on disk right now',
				tone: 'neutral'
			});
		}

		actions.push({
			id: 'delete',
			label: 'Delete file',
			hint: 'Resolve the conflict by removing the file',
			tone: 'danger'
		});

		return actions;
	}

	/** Short status chip for the file list. */
	function fileChip(file: GitConflictFile): { text: string; complete: boolean } {
		if (!isEditable(file)) {
			if (file.omitReason === 'binary') return { text: 'bin', complete: false };
			if (file.omitReason === 'too-large') return { text: 'big', complete: false };
			if (file.kind === 'both-deleted') return { text: 'del', complete: false };
			if (file.kind === 'deleted-by-us' || file.kind === 'deleted-by-them') {
				return { text: 'del', complete: false };
			}
			return { text: 'add', complete: false };
		}
		const stats = getFileStats(file.path);
		return {
			text: `${stats.resolved}/${stats.total}`,
			complete: stats.total > 0 && stats.resolved === stats.total
		};
	}

	/**
	 * Base content only exists when the repo writes diff3-style markers
	 * (`merge.conflictStyle`), so the comparison switcher is hidden otherwise.
	 */
	const abortLabel = $derived(
		operation?.operation === 'rebase'
			? 'Abort Rebase'
			: operation?.operation === 'cherry-pick'
				? 'Abort Cherry-pick'
				: operation?.operation === 'revert'
					? 'Abort Revert'
					: operation?.stashConflict
						? 'Reset Working Tree'
						: 'Abort Merge'
	);

	const hasBase = $derived(currentMarker?.baseContent !== undefined);

	const comparison = $derived.by(() => {
		const marker = currentMarker;
		if (!marker) return null;
		const base = marker.baseContent ?? '';
		if (compareMode === 'base-ours' && marker.baseContent !== undefined) {
			return { original: base, modified: marker.ourContent, left: 'base', right: oursLabel };
		}
		if (compareMode === 'base-theirs' && marker.baseContent !== undefined) {
			return { original: base, modified: marker.theirContent, left: 'base', right: theirsLabel };
		}
		return {
			original: marker.ourContent,
			modified: marker.theirContent,
			left: oursLabel,
			right: theirsLabel
		};
	});

	// On open, prefer the caller-provided initialPath; fall back to first file.
	// We watch the open transition so re-opens from a different list entry land
	// on the right file instead of staying on whatever was selected last time.
	$effect(() => {
		if (isOpen && !prevOpen) {
			if (initialPath && conflictFiles.find((f) => f.path === initialPath)) {
				selectedPath = initialPath;
			} else if (conflictFiles.length > 0) {
				selectedPath = conflictFiles[0].path;
			}
		}
		prevOpen = isOpen;
	});

	$effect(() => {
		if (conflictFiles.length === 0) {
			selectedPath = null;
			return;
		}
		if (!selectedPath || !conflictFiles.find((f) => f.path === selectedPath)) {
			selectedPath = conflictFiles[0].path;
		}
	});

	$effect(() => {
		for (const file of conflictFiles) {
			const existing = markerStatesMap[file.path];
			if (!existing || existing.length !== file.markers.length) {
				markerStatesMap[file.path] = file.markers.map(() => ({ resolution: null }));
			}
		}
	});

	$effect(() => {
		if (selectedPath && selectedFile) {
			currentMarkerIndex = 0;
			manualContent = selectedFile.content;
			editMode = 'guided';
			compareMode = 'ours-theirs';
		}
	});

	function fileBaseName(p: string): string {
		return p.split(/[\\/]/).pop() ?? p;
	}

	function getFileStats(path: string): { resolved: number; total: number } {
		const file = conflictFiles.find((f) => f.path === path);
		if (!file) return { resolved: 0, total: 0 };
		const states = markerStatesMap[file.path] ?? [];
		return {
			resolved: states.filter((s) => s?.resolution != null).length,
			total: file.markers.length
		};
	}

	function setMarkerResolution(index: number, resolution: Resolution) {
		if (!selectedFile) return;
		const states = markerStatesMap[selectedFile.path];
		if (!states || index < 0 || index >= states.length) return;
		states[index] = { resolution };
		markerStatesMap[selectedFile.path] = [...states];
	}

	function nextMarker() {
		if (!selectedFile) return;
		currentMarkerIndex = Math.min(selectedFile.markers.length - 1, currentMarkerIndex + 1);
	}

	function prevMarker() {
		currentMarkerIndex = Math.max(0, currentMarkerIndex - 1);
	}

	function buildResolvedContent(): string | null {
		if (!selectedFile) return null;
		const states = markerStatesMap[selectedFile.path];
		if (!states) return null;
		const lines = selectedFile.content.split('\n');
		for (let i = selectedFile.markers.length - 1; i >= 0; i--) {
			const marker = selectedFile.markers[i];
			const state = states[i];
			if (!state?.resolution) return null;
			let replacement = '';
			if (state.resolution === 'ours') replacement = marker.ourContent;
			else if (state.resolution === 'theirs') replacement = marker.theirContent;
			else if (state.resolution === 'both') {
				const o = marker.ourContent;
				const t = marker.theirContent;
				replacement = o && t ? `${o}\n${t}` : o || t;
			}
			const replacementLines = replacement.length === 0 ? [] : replacement.split('\n');
			lines.splice(marker.ourStart, marker.theirEnd - marker.ourStart + 1, ...replacementLines);
		}
		return lines.join('\n');
	}

	function applyGuidedResolution() {
		if (!selectedFile || !allResolved) return;
		const content = buildResolvedContent();
		if (content === null) return;
		onResolve(selectedFile.path, 'custom', content);
	}

	function applyManualResolution() {
		if (!selectedFile) return;
		onResolve(selectedFile.path, 'custom', manualContent);
	}

	// "All Ours"/"All Theirs" set every marker in the current file to the chosen
	// side but DON'T stage — the user still confirms via "Mark Resolved & Stage".
	// This lets them tweak individual markers afterwards.
	function applyAllOurs() {
		if (!selectedFile) return;
		const states = markerStatesMap[selectedFile.path];
		if (!states) return;
		markerStatesMap[selectedFile.path] = states.map(() => ({ resolution: 'ours' }));
	}

	function applyAllTheirs() {
		if (!selectedFile) return;
		const states = markerStatesMap[selectedFile.path];
		if (!states) return;
		markerStatesMap[selectedFile.path] = states.map(() => ({ resolution: 'theirs' }));
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!isOpen || !selectedFile || editMode !== 'guided') return;
		const target = e.target as HTMLElement | null;
		if (!target) return;
		if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
			return;
		}
		if (target.closest('.monaco-editor')) return;

		switch (e.key) {
			case '1':
				setMarkerResolution(currentMarkerIndex, 'ours');
				e.preventDefault();
				break;
			case '2':
				setMarkerResolution(currentMarkerIndex, 'theirs');
				e.preventDefault();
				break;
			case '3':
				setMarkerResolution(currentMarkerIndex, 'both');
				e.preventDefault();
				break;
			case 'n':
			case 'ArrowDown':
				nextMarker();
				e.preventDefault();
				break;
			case 'p':
			case 'ArrowUp':
				prevMarker();
				e.preventDefault();
				break;
		}
	}
</script>

<svelte:window on:keydown={handleKeydown} />

<Modal
	{isOpen}
	{onClose}
	bare
	closable
	mobileFullscreen
	className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xl w-full max-w-[95vw] xl:max-w-[1280px] h-[95vh] md:h-[90vh] flex flex-col overflow-hidden"
>
	<!-- Header -->
	<div
		class="flex items-center justify-between px-3 py-2 md:px-4 md:py-2.5 border-b border-slate-200 dark:border-slate-800 shrink-0 gap-2"
	>
		<div class="flex items-center gap-2 min-w-0">
			<h2 class="text-sm md:text-base font-bold text-slate-900 dark:text-slate-100 truncate">
				{headerTitle}
			</h2>
			{#if operation?.step && operation.total}
				<span
					class="shrink-0 rounded px-1.5 py-0.5 text-3xs font-semibold bg-amber-500/20 text-amber-700 dark:text-amber-300"
				>
					{operation.step} / {operation.total}
				</span>
			{/if}
		</div>
		<div class="flex items-center gap-1 md:gap-2 shrink-0">
			{#if conflictFiles.length > 0}
				<button
					type="button"
					class="hidden md:flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-violet-600 hover:bg-violet-700 rounded-lg transition-colors cursor-pointer border-none"
					onclick={onResolveAllWithAI}
					title="Send all conflicts to AI chat for resolution"
				>
					<Icon name="lucide:wand-sparkles" class="w-4 h-4" />
					Resolve All with AI
				</button>
				<button
					type="button"
					class="hidden md:flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-red-600 dark:text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded-lg transition-colors cursor-pointer border-none"
					onclick={onAbortMerge}
					disabled={busy}
					title="Abort this operation and discard all conflict resolutions"
				>
					<Icon name="lucide:octagon-x" class="w-4 h-4" />
					{abortLabel}
				</button>
			{/if}
			<!-- Mobile-only overflow menu -->
			<div class="relative md:hidden">
				<button
					type="button"
					class="flex p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-violet-500/10 transition-colors cursor-pointer bg-transparent border-none"
					onclick={() => (showMoreMenu = !showMoreMenu)}
					aria-label="More actions"
					title="More actions"
				>
					<Icon name="lucide:ellipsis-vertical" class="w-4 h-4" />
				</button>
				{#if showMoreMenu}
					<button
						type="button"
						class="fixed inset-0 z-10 cursor-default bg-transparent border-none"
						aria-label="Close menu"
						onclick={() => (showMoreMenu = false)}
					></button>
					<div
						class="absolute right-0 top-full mt-1 z-20 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl min-w-[220px] py-1"
						role="menu"
					>
						{#if conflictFiles.length > 0}
							<button
								type="button"
								class="flex items-center gap-2 w-full px-3 py-2 text-sm text-violet-700 dark:text-violet-300 hover:bg-violet-500/10 cursor-pointer bg-transparent border-none text-left transition-colors"
								onclick={() => {
									showMoreMenu = false;
									onResolveAllWithAI();
								}}
							>
								<Icon name="lucide:wand-sparkles" class="w-4 h-4" />
								Resolve All with AI
							</button>
							<div class="h-px bg-slate-200 dark:bg-slate-700 my-1"></div>
						{/if}
						<button
							type="button"
							class="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-500/10 cursor-pointer bg-transparent border-none text-left transition-colors"
							onclick={() => {
								showMoreMenu = false;
								onAbortMerge();
							}}
						>
							<Icon name="lucide:octagon-x" class="w-4 h-4" />
							{abortLabel}
						</button>
					</div>
				{/if}
			</div>
			<button
				type="button"
				class="flex p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-violet-500/10 transition-colors cursor-pointer bg-transparent border-none"
				onclick={onClose}
				aria-label="Close"
			>
				<Icon name="lucide:x" class="w-4 h-4 md:w-5 md:h-5" />
			</button>
		</div>
	</div>

	{#if isRebase}
		<!-- The single most useful sentence in this dialog. During a rebase git
			replays your commits onto the upstream, so "ours" is the branch you are
			rebasing onto and "theirs" is your own commit. -->
		<div
			class="flex items-start gap-2 px-3 py-1.5 md:px-4 border-b border-amber-500/30 bg-amber-500/10 text-3xs md:text-xs text-amber-800 dark:text-amber-200 shrink-0"
		>
			<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5 mt-px shrink-0" />
			<span class="min-w-0">
				Rebase: the sides are swapped from a normal merge —
				<strong class="font-semibold">ours = {oursLabel}</strong> (what you are rebasing onto) and
				<strong class="font-semibold">theirs = {theirsLabel}</strong>.
			</span>
		</div>
	{/if}

	{#if isLoading}
		<div class="flex-1 flex items-center justify-center">
			<div
				class="w-7 h-7 border-2 border-slate-200 dark:border-slate-700 border-t-violet-600 rounded-full animate-spin"
			></div>
		</div>
	{:else if conflictFiles.length === 0}
		<div
			class="flex-1 flex flex-col items-center justify-center gap-3 text-slate-500 dark:text-slate-400"
		>
			<Icon name="lucide:circle-check" class="w-12 h-12 text-emerald-500" />
			<p class="text-sm">No merge conflicts. Everything is resolved.</p>
		</div>
	{:else}
		<!-- Mobile: horizontal file chip strip -->
		<div
			class="md:hidden flex gap-1.5 px-3 py-2 border-b border-slate-200 dark:border-slate-800 overflow-x-auto shrink-0 bg-slate-50/50 dark:bg-slate-900/40"
		>
			{#each conflictFiles as file (file.path)}
				{@const chip = fileChip(file)}
				{@const isSelected = selectedPath === file.path}
				{@const isComplete = chip.complete}
				<button
					type="button"
					class="flex items-center gap-1.5 shrink-0 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer border
						{isSelected
						? 'bg-violet-500/10 border-violet-500/40 text-violet-700 dark:text-violet-300'
						: 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'}"
					onclick={() => (selectedPath = file.path)}
					title={file.path}
				>
					<Icon
						name={getFileIcon(fileBaseName(file.path)) as IconName}
						class="w-3.5 h-3.5 shrink-0"
					/>
					<span class="truncate max-w-[120px]">{fileBaseName(file.path)}</span>
					<span
						class="flex items-center justify-center min-w-[24px] h-4 px-1 rounded text-3xs font-mono
							{isComplete
							? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
							: 'bg-orange-500/15 text-orange-600 dark:text-orange-400'}"
					>
						{#if isComplete}
							<Icon name="lucide:check" class="w-3 h-3" />
						{:else}
							{chip.text}
						{/if}
					</span>
				</button>
			{/each}
		</div>

		<div class="flex flex-1 overflow-hidden">
			<!-- Tablet/Desktop: file list sidebar -->
			<div
				class="hidden md:block w-56 lg:w-64 xl:w-72 border-r border-slate-200 dark:border-slate-800 overflow-y-auto shrink-0 bg-slate-50/50 dark:bg-slate-900/40 py-1"
			>
				{#each conflictFiles as file (file.path)}
					{@const chip = fileChip(file)}
					{@const isSelected = selectedPath === file.path}
					{@const isComplete = chip.complete}
					<button
						type="button"
						class="flex items-center gap-2 w-full px-3 py-2 text-left bg-transparent border-none cursor-pointer transition-colors
							{isSelected
							? 'bg-violet-500/10 text-violet-700 dark:text-violet-300 font-medium'
							: 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/50'}"
						onclick={() => (selectedPath = file.path)}
						title={file.path}
					>
						<Icon
							name={getFileIcon(fileBaseName(file.path)) as IconName}
							class="w-4 h-4 shrink-0"
						/>
						<div class="flex-1 min-w-0">
							<div class="truncate text-xs md:text-sm leading-tight">{fileBaseName(file.path)}</div>
							{#if file.path !== fileBaseName(file.path)}
								<div class="truncate text-2xs md:text-xs text-slate-500 dark:text-slate-500 mt-0.5">
									{file.path}
								</div>
							{/if}
						</div>
						<span
							class="shrink-0 flex items-center justify-center min-w-[32px] h-5 px-1.5 rounded-md text-xs font-medium
								{isComplete
								? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
								: 'bg-orange-500/15 text-orange-600 dark:text-orange-400'}"
						>
							{#if isComplete}
								<Icon name="lucide:check" class="w-3.5 h-3.5" />
							{:else}
								{chip.text}
							{/if}
						</span>
					</button>
				{/each}
			</div>

			<!-- Main content -->
			<div class="flex-1 flex flex-col overflow-hidden min-w-0">
				{#if selectedFile}
					<!-- File toolbar -->
					<div
						class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-3 py-1.5 md:px-4 md:py-2 bg-slate-50 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-800 shrink-0"
					>
						<div class="flex items-center gap-1.5 min-w-0">
							<Icon
								name={getFileIcon(fileBaseName(selectedFile.path)) as IconName}
								class="w-4 h-4 shrink-0"
							/>
							<span
								class="text-xs md:text-sm text-slate-700 dark:text-slate-300 min-w-0"
								title={selectedFile.path}
							>
								<span class="md:hidden">{fileBaseName(selectedFile.path)}</span>
								<span class="hidden md:inline">{selectedFile.path}</span>
							</span>
						</div>
						<div class="flex flex-wrap items-center gap-1.5 shrink-0">
							{#if selectedIsEditable && editMode === 'guided'}
								<button
									type="button"
									class="px-2 py-1 text-xs md:text-sm font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 rounded-md hover:bg-emerald-500/20 transition-colors cursor-pointer border-none shrink-0"
									onclick={applyAllOurs}
									title="Mark every marker in this file as {oursLabel} (you still need to Stage)"
								>
									All Ours
								</button>
								<button
									type="button"
									class="px-2 py-1 text-xs md:text-sm font-medium text-blue-700 dark:text-blue-300 bg-blue-500/10 rounded-md hover:bg-blue-500/20 transition-colors cursor-pointer border-none shrink-0"
									onclick={applyAllTheirs}
									title="Mark every marker in this file as {theirsLabel} (you still need to Stage)"
								>
									All Theirs
								</button>
							{/if}

							<!-- Whole-file answers. These call git directly
								(`checkout --ours/--theirs`, `checkout --merge`) rather than
								rewriting the text, so they also work on files the guided
								editor cannot open. -->
							<div class="relative shrink-0" use:clickOutside={() => (showFileMenu = false)}>
								<button
									type="button"
									class="flex items-center gap-1 px-2 py-1 text-xs md:text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-200/60 dark:bg-slate-700/50 rounded-md hover:bg-slate-300/60 dark:hover:bg-slate-700 transition-colors cursor-pointer border-none"
									onclick={() => (showFileMenu = !showFileMenu)}
									aria-haspopup="menu"
									aria-expanded={showFileMenu}
									title="Whole-file actions"
								>
									<Icon name="lucide:file-cog" class="w-3.5 h-3.5" />
									<span class="hidden md:inline">File</span>
								</button>
								{#if showFileMenu}
									<div
										class="absolute right-0 top-full mt-1 z-30 min-w-[240px] rounded-lg border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-slate-800"
										role="menu"
									>
										{#each structuralActions(selectedFile) as action (action.id)}
											<button
												type="button"
												role="menuitem"
												class="flex w-full flex-col items-start gap-0.5 border-none bg-transparent px-3 py-1.5 text-left transition-colors cursor-pointer
													{action.tone === 'danger'
													? 'text-red-600 hover:bg-red-500/10 dark:text-red-400'
													: 'text-slate-700 hover:bg-violet-500/10 dark:text-slate-200'}"
												onclick={() => {
													showFileMenu = false;
													onResolve(selectedFile.path, action.id);
												}}
												disabled={busy}
											>
												<span class="text-xs font-medium">{action.label}</span>
												<span class="text-3xs text-slate-500 dark:text-slate-400">{action.hint}</span>
											</button>
										{/each}
										<div class="my-1 h-px bg-slate-200 dark:bg-slate-700"></div>
										<button
											type="button"
											role="menuitem"
											class="flex w-full flex-col items-start gap-0.5 border-none bg-transparent px-3 py-1.5 text-left text-slate-700 transition-colors cursor-pointer hover:bg-violet-500/10 dark:text-slate-200"
											onclick={() => {
												showFileMenu = false;
												onResolve(selectedFile.path, 'reset');
											}}
											disabled={busy}
										>
											<span class="text-xs font-medium">Reset to conflict</span>
											<span class="text-3xs text-slate-500 dark:text-slate-400">
												Put the conflict markers back and start over
											</span>
										</button>
									</div>
								{/if}
							</div>

							{#if selectedIsEditable}
							<div
								class="flex items-center gap-0.5 bg-slate-200/60 dark:bg-slate-700/50 rounded-lg p-0.5 shrink-0"
							>
								<button
									type="button"
									class="px-2 py-1 text-xs md:text-sm font-medium rounded-md transition-colors cursor-pointer border-none
										{editMode === 'guided'
										? 'bg-white dark:bg-slate-900 text-violet-600 dark:text-violet-300 shadow-sm'
										: 'bg-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'}"
									onclick={() => (editMode = 'guided')}
									title="Guided per-marker resolution"
								>
									Guided
								</button>
								<button
									type="button"
									class="px-2 py-1 text-xs md:text-sm font-medium rounded-md transition-colors cursor-pointer border-none
										{editMode === 'manual'
										? 'bg-white dark:bg-slate-900 text-violet-600 dark:text-violet-300 shadow-sm'
										: 'bg-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'}"
									onclick={() => (editMode = 'manual')}
									title="Manual full-file edit"
								>
									Manual
								</button>
							</div>
							{/if}
							<button
								type="button"
								class="flex items-center gap-1.5 px-2.5 py-1 text-xs md:text-sm font-medium text-white bg-violet-600 hover:bg-violet-700 rounded-md transition-colors cursor-pointer border-none shrink-0"
								onclick={() => onResolveWithAI(selectedFile.path)}
								title="Send this file's conflicts to AI chat"
							>
								<Icon name="lucide:wand-sparkles" class="w-3.5 h-3.5" />
								Resolve with AI
							</button>
						</div>
					</div>

					{#if !selectedIsEditable}
						<!-- Structural conflict: git recorded a disagreement about whether
							the file should exist (or it is binary/oversized), so there are no
							markers to walk. These paths used to be dropped or shown as an
							unresolvable 0/0 file with no way forward. -->
						<div class="flex-1 overflow-y-auto p-4 md:p-6">
							<div class="mx-auto max-w-xl">
								<div class="flex items-start gap-3">
									<Icon
										name={selectedFile.omitReason === 'binary'
											? 'lucide:binary'
											: selectedFile.kind === 'both-deleted'
												? 'lucide:file-x'
												: 'lucide:file-question-mark'}
										class="w-6 h-6 shrink-0 text-amber-600 dark:text-amber-400"
									/>
									<div class="min-w-0">
										<h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">
											Nothing to merge line by line
										</h3>
										<p class="mt-1 text-xs md:text-sm text-slate-600 dark:text-slate-300">
											{describeKind(selectedFile)}
										</p>
										{#if describeOmission(selectedFile)}
											<p class="mt-1 text-xs md:text-sm text-slate-500 dark:text-slate-400">
												{describeOmission(selectedFile)}
											</p>
										{/if}
									</div>
								</div>

								<div class="mt-5 flex flex-col gap-2">
									{#each structuralActions(selectedFile) as action (action.id)}
										<button
											type="button"
											class="flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50
												{action.tone === 'ours'
												? 'border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20'
												: action.tone === 'theirs'
													? 'border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/20'
													: action.tone === 'danger'
														? 'border-red-500/40 bg-red-500/10 hover:bg-red-500/20'
														: 'border-slate-200 bg-slate-50 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/50 dark:hover:bg-slate-800'}"
											onclick={() => onResolve(selectedFile.path, action.id)}
											disabled={busy}
										>
											<span class="min-w-0">
												<span
													class="block truncate text-sm font-semibold
														{action.tone === 'ours'
														? 'text-emerald-700 dark:text-emerald-300'
														: action.tone === 'theirs'
															? 'text-blue-700 dark:text-blue-300'
															: action.tone === 'danger'
																? 'text-red-600 dark:text-red-400'
																: 'text-slate-700 dark:text-slate-200'}"
												>
													{action.label}
												</span>
												<span class="block truncate text-xs text-slate-500 dark:text-slate-400">
													{action.hint}
												</span>
											</span>
											<Icon name="lucide:chevron-right" class="w-4 h-4 shrink-0 text-slate-400" />
										</button>
									{/each}
								</div>

								<p class="mt-4 text-3xs text-slate-500 dark:text-slate-400">
									Either answer stages the file, which is what git needs before the
									operation can continue.
								</p>
							</div>
						</div>
					{:else if editMode === 'guided'}
						<!-- Combined navigator + pick + stage row.
							Layout: [prev next chips] | [Ours Theirs Both, Mark Resolved & Stage]
							Pick + Stage live on the right so the user's eye flows naturally
							from "where am I" (left) to "what do I do" (right). On small
							screens the right group wraps to its own line. -->
						<div
							class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-3 py-1.5 md:px-4 md:py-2 bg-slate-50/50 dark:bg-slate-900/40 border-b border-slate-200 dark:border-slate-800 shrink-0"
						>
							<div class="flex items-center gap-1.5 md:gap-2 min-w-0 flex-1">
								<button
									type="button"
									class="flex items-center justify-center w-6 h-6 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer bg-transparent border-none shrink-0"
									onclick={prevMarker}
									disabled={currentMarkerIndex === 0}
									aria-label="Previous conflict"
									title="Previous conflict (P / ↑)"
								>
									<Icon name="lucide:chevron-up" class="w-4 h-4" />
								</button>
								<button
									type="button"
									class="flex items-center justify-center w-6 h-6 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer bg-transparent border-none shrink-0"
									onclick={nextMarker}
									disabled={currentMarkerIndex >= totalMarkers - 1}
									aria-label="Next conflict"
									title="Next conflict (N / ↓)"
								>
									<Icon name="lucide:chevron-down" class="w-4 h-4" />
								</button>
								<div class="flex gap-1 overflow-x-auto py-0.5 min-w-0">
									{#each selectedFile.markers as _, idx}
										{@const st = selectedFileMarkerStates[idx]?.resolution}
										{@const isCurrent = idx === currentMarkerIndex}
										<button
											type="button"
											class="shrink-0 min-w-[24px] h-6 px-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer border-2 flex items-center justify-center
												{isCurrent
												? 'border-violet-500'
												: st === 'ours'
													? 'border-emerald-500/40'
													: st === 'theirs'
														? 'border-blue-500/40'
														: st === 'both'
															? 'border-violet-500/40'
															: 'border-slate-300 dark:border-slate-600'}
												{st === 'ours'
												? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'
												: st === 'theirs'
													? 'bg-blue-500/20 text-blue-700 dark:text-blue-300'
													: st === 'both'
														? 'bg-violet-500/20 text-violet-700 dark:text-violet-300'
														: 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-400'}"
											onclick={() => (currentMarkerIndex = idx)}
											title="Conflict {idx + 1}{st ? ` — ${st}` : ''}"
										>
											{idx + 1}
										</button>
									{/each}
								</div>
							</div>
							<div class="flex flex-wrap items-center gap-1.5 md:gap-2 shrink-0">
								<div class="flex items-center gap-1 shrink-0">
									<button
										type="button"
										class="px-2 py-1 text-xs md:text-sm font-medium rounded-md transition-colors cursor-pointer border
											{selectedFileMarkerStates[currentMarkerIndex]?.resolution === 'ours'
											? 'bg-emerald-600 border-emerald-600 text-white'
											: 'bg-emerald-500/10 border-transparent text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20'}"
										onclick={() => setMarkerResolution(currentMarkerIndex, 'ours')}
										title="Take {oursLabel} for this conflict (1)"
									>
										Ours
									</button>
									<button
										type="button"
										class="px-2 py-1 text-xs md:text-sm font-medium rounded-md transition-colors cursor-pointer border
											{selectedFileMarkerStates[currentMarkerIndex]?.resolution === 'theirs'
											? 'bg-blue-600 border-blue-600 text-white'
											: 'bg-blue-500/10 border-transparent text-blue-700 dark:text-blue-300 hover:bg-blue-500/20'}"
										onclick={() => setMarkerResolution(currentMarkerIndex, 'theirs')}
										title="Take {theirsLabel} for this conflict (2)"
									>
										Theirs
									</button>
									<button
										type="button"
										class="px-2 py-1 text-xs md:text-sm font-medium rounded-md transition-colors cursor-pointer border
											{selectedFileMarkerStates[currentMarkerIndex]?.resolution === 'both'
											? 'bg-violet-600 border-violet-600 text-white'
											: 'bg-violet-500/10 border-transparent text-violet-700 dark:text-violet-300 hover:bg-violet-500/20'}"
										onclick={() => setMarkerResolution(currentMarkerIndex, 'both')}
										title="Take both — ours then theirs"
									>
										Both
									</button>
								</div>
								<button
									type="button"
									class="flex items-center gap-1.5 px-3 py-1 text-xs md:text-sm font-semibold rounded-md transition-colors border-none shrink-0
										{allResolved
										? 'bg-violet-600 text-white hover:bg-violet-700 cursor-pointer'
										: 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400 cursor-not-allowed'}"
									onclick={applyGuidedResolution}
									disabled={!allResolved || busy}
									title={allResolved
										? 'Apply resolutions and stage file'
										: 'Resolve all conflicts first'}
								>
									<Icon name="lucide:check" class="w-3.5 h-3.5 md:w-4 md:h-4" />
									Mark Resolved &amp; Stage
								</button>
							</div>
						</div>

						{#if currentMarker}
							<!-- Section headers -->
							{#if isWideViewport}
								<div
									class="flex border-b border-slate-200 dark:border-slate-800 shrink-0 text-xs md:text-sm font-semibold"
								>
									<div
										class="flex-1 px-3 md:px-4 py-1.5 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5 md:gap-2"
									>
										<Icon name="lucide:arrow-left-to-line" class="w-3.5 h-3.5 md:w-4 md:h-4 shrink-0" />
										<span class="truncate" title="Ours — {comparison?.left ?? oursLabel}">
											{comparison?.left ?? oursLabel}
										</span>
									</div>
									<div
										class="flex-1 px-3 md:px-4 py-1.5 bg-blue-500/10 text-blue-700 dark:text-blue-300 flex items-center gap-1.5 md:gap-2"
									>
										<Icon name="lucide:arrow-right-to-line" class="w-3.5 h-3.5 md:w-4 md:h-4 shrink-0" />
										<span class="truncate" title="Theirs — {comparison?.right ?? theirsLabel}">
											{comparison?.right ?? theirsLabel}
										</span>
									</div>
								</div>
							{:else}
								<div
									class="flex border-b border-slate-200 dark:border-slate-800 shrink-0 text-xs font-semibold"
								>
									<div
										class="flex-1 px-3 py-1 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 flex items-center gap-1"
									>
										<Icon name="lucide:minus" class="w-3 h-3 shrink-0" />
										<span class="truncate">{comparison?.left ?? oursLabel}</span>
									</div>
									<div
										class="flex-1 px-3 py-1 bg-blue-500/10 text-blue-700 dark:text-blue-300 flex items-center gap-1"
									>
										<Icon name="lucide:plus" class="w-3 h-3 shrink-0" />
										<span class="truncate">{comparison?.right ?? theirsLabel}</span>
									</div>
								</div>
							{/if}

							{#if hasBase}
								<!-- The merge base is only recorded when the repo writes diff3
									markers. When it is there, comparing each side against the base
									is what tells you which side actually changed a given line. -->
								<div
									class="flex items-center gap-1.5 px-3 py-1 md:px-4 border-b border-slate-200 dark:border-slate-800 shrink-0 overflow-x-auto"
								>
									<span class="text-3xs text-slate-500 dark:text-slate-400 shrink-0">Compare</span>
									{#each [{ id: 'ours-theirs', label: 'Ours ↔ Theirs' }, { id: 'base-ours', label: `Base ↔ ${oursLabel}` }, { id: 'base-theirs', label: `Base ↔ ${theirsLabel}` }] as option (option.id)}
										<button
											type="button"
											class="shrink-0 rounded-md px-2 py-0.5 text-3xs font-medium transition-colors cursor-pointer border-none
												{compareMode === option.id
												? 'bg-violet-600 text-white'
												: 'bg-slate-200/60 text-slate-600 hover:bg-slate-300/60 dark:bg-slate-700/50 dark:text-slate-300 dark:hover:bg-slate-700'}"
											onclick={() => (compareMode = option.id as CompareMode)}
										>
											{option.label}
										</button>
									{/each}
								</div>
							{/if}

							<!-- Diff viewer for current marker -->
							<div class="flex-1 overflow-hidden min-h-0">
								{#key `${selectedFile.path}:${currentMarkerIndex}:${compareMode}:${language}:${isWideViewport}`}
									<MonacoDiffEditor
										original={comparison?.original ?? currentMarker.ourContent}
										modified={comparison?.modified ?? currentMarker.theirContent}
										{language}
										originalPath={`${comparison?.left ?? 'ours'}/${selectedFile.path}`}
										modifiedPath={`${comparison?.right ?? 'theirs'}/${selectedFile.path}`}
										readonly
										renderSideBySide={isWideViewport}
									/>
								{/key}
							</div>
						{:else}
							<div class="flex-1 flex items-center justify-center text-sm text-slate-500">
								No conflicts found in this file.
							</div>
						{/if}
					{:else}
						<!-- Manual edit mode: warning + Reset + Save share a single row so
							the editor itself gets the full remaining height. -->
						<div
							class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-3 py-1.5 md:px-4 md:py-2 bg-amber-500/10 border-b border-amber-500/30 text-xs md:text-sm text-amber-700 dark:text-amber-300 shrink-0"
						>
							<div class="flex items-center gap-2 min-w-0 flex-1">
								<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5 md:w-4 md:h-4 shrink-0" />
								<span class="min-w-0 flex-1 truncate">
									Manual mode — remove all conflict markers
									(<code class="font-mono text-xs">&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code>,
									<code class="font-mono text-xs">=======</code>,
									<code class="font-mono text-xs">&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code>) before
									saving.
								</span>
							</div>
							<div class="flex flex-wrap items-center gap-1.5 shrink-0">
								<button
									type="button"
									class="px-2 py-1 text-xs md:text-sm font-medium text-slate-600 dark:text-slate-300 bg-transparent rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer border border-slate-200 dark:border-slate-700"
									onclick={() => (manualContent = selectedFile.content)}
									title="Reset to original content with markers"
								>
									Reset
								</button>
								<button
									type="button"
									class="flex items-center gap-1.5 px-3 py-1 text-xs md:text-sm font-semibold bg-violet-600 text-white rounded-md hover:bg-violet-700 transition-colors cursor-pointer border-none"
									onclick={applyManualResolution}
									disabled={busy}
								>
									<Icon name="lucide:check" class="w-3.5 h-3.5 md:w-4 md:h-4" />
									Save &amp; Stage
								</button>
							</div>
						</div>
						<div class="flex-1 overflow-hidden min-h-0">
							{#key `${selectedFile.path}:manual:${language}`}
								<MonacoCodeEditor
									bind:value={manualContent}
									{language}
									path={selectedFile.path}
								/>
							{/key}
						</div>
					{/if}
				{:else}
					<div class="flex-1 flex items-center justify-center text-sm text-slate-500">
						Select a file to view conflicts.
					</div>
				{/if}
			</div>
		</div>
	{/if}
</Modal>
