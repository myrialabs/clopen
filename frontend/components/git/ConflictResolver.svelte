<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import MonacoDiffEditor from '$frontend/components/common/editor/MonacoDiffEditor.svelte';
	import MonacoCodeEditor from '$frontend/components/common/editor/MonacoCodeEditor.svelte';
	import { detectLanguageFromFilename } from '$frontend/components/common/editor/monaco-languages';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import type { IconName } from '$shared/types/ui/icons';
	import type { GitConflictFile, GitConflictMarker } from '$shared/types/git';

	type Resolution = 'ours' | 'theirs' | 'both';

	interface MarkerState {
		resolution: Resolution | null;
	}

	interface Props {
		isOpen: boolean;
		conflictFiles: GitConflictFile[];
		isLoading: boolean;
		initialPath?: string | null;
		onResolve: (filePath: string, resolution: 'ours' | 'theirs' | 'custom', customContent?: string) => void;
		onResolveWithAI: (filePath: string) => void;
		onResolveAllWithAI: () => void;
		onAbortMerge: () => void;
		onClose: () => void;
	}

	const {
		isOpen,
		conflictFiles,
		isLoading,
		initialPath = null,
		onResolve,
		onResolveWithAI,
		onResolveAllWithAI,
		onAbortMerge,
		onClose
	}: Props = $props();

	let selectedPath = $state<string | null>(null);
	let editMode = $state<'guided' | 'manual'>('guided');
	let currentMarkerIndex = $state(0);
	let manualContent = $state('');
	let showMoreMenu = $state(false);
	let markerStatesMap = $state<Record<string, MarkerState[]>>({});
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
				Merge Conflicts
			</h2>
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
					title="Abort the merge and discard all conflict resolutions"
				>
					<Icon name="lucide:octagon-x" class="w-4 h-4" />
					Abort Merge
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
							Abort Merge
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
				{@const stats = getFileStats(file.path)}
				{@const isSelected = selectedPath === file.path}
				{@const isComplete = stats.total > 0 && stats.resolved === stats.total}
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
							{stats.resolved}/{stats.total}
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
					{@const stats = getFileStats(file.path)}
					{@const isSelected = selectedPath === file.path}
					{@const isComplete = stats.total > 0 && stats.resolved === stats.total}
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
								{stats.resolved}/{stats.total}
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
							{#if editMode === 'guided'}
								<button
									type="button"
									class="px-2 py-1 text-xs md:text-sm font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 rounded-md hover:bg-emerald-500/20 transition-colors cursor-pointer border-none shrink-0"
									onclick={applyAllOurs}
									title="Mark every marker in this file as Ours (you still need to Stage)"
								>
									All Ours
								</button>
								<button
									type="button"
									class="px-2 py-1 text-xs md:text-sm font-medium text-blue-700 dark:text-blue-300 bg-blue-500/10 rounded-md hover:bg-blue-500/20 transition-colors cursor-pointer border-none shrink-0"
									onclick={applyAllTheirs}
									title="Mark every marker in this file as Theirs (you still need to Stage)"
								>
									All Theirs
								</button>
							{/if}
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

					{#if editMode === 'guided'}
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
										title="Take ours for this marker"
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
										title="Take theirs for this marker"
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
									disabled={!allResolved}
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
										<span class="truncate">Ours (HEAD)</span>
									</div>
									<div
										class="flex-1 px-3 md:px-4 py-1.5 bg-blue-500/10 text-blue-700 dark:text-blue-300 flex items-center gap-1.5 md:gap-2"
									>
										<Icon name="lucide:arrow-right-to-line" class="w-3.5 h-3.5 md:w-4 md:h-4 shrink-0" />
										<span class="truncate">Theirs (incoming)</span>
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
										<span class="truncate">Ours (HEAD)</span>
									</div>
									<div
										class="flex-1 px-3 py-1 bg-blue-500/10 text-blue-700 dark:text-blue-300 flex items-center gap-1"
									>
										<Icon name="lucide:plus" class="w-3 h-3 shrink-0" />
										<span class="truncate">Theirs (incoming)</span>
									</div>
								</div>
							{/if}

							<!-- Diff viewer for current marker -->
							<div class="flex-1 overflow-hidden min-h-0">
								{#key `${selectedFile.path}:${currentMarkerIndex}:${language}:${isWideViewport}`}
									<MonacoDiffEditor
										original={currentMarker.ourContent}
										modified={currentMarker.theirContent}
										{language}
										originalPath={`ours/${selectedFile.path}`}
										modifiedPath={`theirs/${selectedFile.path}`}
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
