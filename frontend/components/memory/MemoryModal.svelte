<script lang="ts">
	/**
	 * Memory — a global modal, opened from More Tools.
	 *
	 * It lives here rather than in the workspace dock because the graph is not
	 * project-scoped: it spans every project and holds preferences that belong to
	 * the user. Same shape as DB Client: centred on a wide screen, fullscreen on a
	 * small one.
	 *
	 * One header row, not two. Everything that steers the view — search, project,
	 * kind — belongs to the same act of looking, and splitting it across a title
	 * bar and a toolbar made the modal feel like two stacked apps.
	 *
	 * Search highlights inside the graph rather than filtering it down: the point
	 * of searching here is to find a foothold and then look at what surrounds it,
	 * which a filtered graph destroys.
	 */
	import { onMount } from 'svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import LoadingSpinner from '$frontend/components/common/feedback/LoadingSpinner.svelte';
	import MemoryGraphCanvas from './MemoryGraphCanvas.svelte';
	import MemoryNodeInspector from './MemoryNodeInspector.svelte';
	import MemoryStatus from './MemoryStatus.svelte';
	import MemoryPopover from './MemoryPopover.svelte';
	import MemoryComposer from './MemoryComposer.svelte';
	import SearchableMultiSelect from '$frontend/components/common/form/SearchableMultiSelect.svelte';
	import { settingsModalState } from '$frontend/stores/ui/settings-modal.svelte';
	import { memoryGraphStore } from '$frontend/stores/features/memory-graph.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import { showAlert, showConfirm } from '$frontend/stores/ui/dialog.svelte';
	import {
		EPISODIC_SUBKINDS,
		STRUCTURAL_SUBKINDS
	} from '$frontend/stores/features/memory-graph.svelte';
	import type { GraphNodeKind, GraphRegion, GraphSource } from '$shared/types/memory';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(), onClose }: Props = $props();

	let canvas = $state<ReturnType<typeof MemoryGraphCanvas> | null>(null);
	let searchInput = $state('');
	let searchDebounce: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Whether the graph is allowed to mount yet.
	 *
	 * The modal's opening animation is two hundred milliseconds of the main
	 * thread, and building a graph is the single most expensive thing this app
	 * mounts. Doing both in the same flush is what made opening Memory stutter
	 * once there was a lot of it: the store keeps the last view, so every open
	 * after the first found data already there and built the whole canvas inside
	 * the first frame of the animation.
	 *
	 * The fetch still starts immediately — the network is not the main thread.
	 * Only the drawing waits.
	 */
	let canvasReady = $state(false);
	let readyFallback: ReturnType<typeof setTimeout> | null = null;

	/** Which secondary panel is open over the graph, if any. */
	let panel = $state<'none' | 'filters' | 'forgotten'>('none');
	let purging = $state(false);
	let composerOpen = $state(false);

	/**
	 * Visited nodes, so the inspector has Back/Forward.
	 *
	 * Following a connection is the main way to move through the graph, and
	 * without history every hop is one-way — you land somewhere and cannot get
	 * back to what sent you there.
	 */
	let history = $state<string[]>([]);
	let historyIndex = $state(-1);

	let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
	let sidebarWidth = $state(320);
	let dragging = $state(false);
	let body = $state<HTMLDivElement | null>(null);
	let bodyHeight = $state(0);

	/**
	 * The destructive corner, behind two doors.
	 *
	 * `deleteAllOpen` is the chooser — which scope — and `purgeDialogOpen` is the
	 * typed confirmation for whichever was chosen. Splitting them is what replaced
	 * the old "Danger zone" footer: two permanently visible red links under a list
	 * the user opened to REVIEW things read as an invitation, and the more
	 * destructive of the two sat closest to the everyday controls.
	 */
	let deleteAllOpen = $state(false);
	let purgeDialogOpen = $state(false);
	let purgeScope = $state<'selection' | 'all'>('all');
	let purgeTyped = $state('');

	const isMobile = $derived(windowWidth < 768);
	const canEdit = $derived(authStore.isAdmin);
	const view = $derived(memoryGraphStore.view);
	const stats = $derived(memoryGraphStore.stats);
	const selected = $derived(memoryGraphStore.selected);
	const hits = $derived(memoryGraphStore.searchHits);
	/**
	 * Hits always highlight, at either resolution. A memory that survived the grid
	 * as its own mark lights up exactly as it always did; one that was merged into
	 * a crowd simply has no mark of its own to light, and the results list is where
	 * it is reached from. That degrades quietly, which the community grouping did
	 * not — there every hit was invisible.
	 */
	const highlightIds = $derived(hits.map(hit => hit.node.id));
	const region = $derived(memoryGraphStore.region);
	/** Marks on the canvas: memories drawn individually, plus the merged ones. */
	const drawnCount = $derived(view.nodes.length + view.bins.length);
	/** How many memories the merged marks stand for, for the header's tooltip. */
	const mergedCount = $derived(view.bins.reduce((sum, bin) => sum + bin.members, 0));
	const kinds = $derived(memoryGraphStore.filter.kinds);
	const filter = $derived(memoryGraphStore.filter);
	const forgotten = $derived(memoryGraphStore.forgotten);
	const forgottenSelection = $derived(memoryGraphStore.forgottenSelection);
	/** Any narrowing beyond the default, so the filter button can say so. */
	const activeFilterCount = $derived(
		(kinds.length < 2 ? 1 : 0) + filter.subkinds.length + filter.sources.length
	);
	/** Projects offered by the multi-select, with their path to tell namesakes apart. */
	const projectOptions = $derived(
		projectState.projects.map(project => ({
			id: project.id as string,
			label: project.name as string,
			hint: (project.path as string | undefined) ?? undefined
		}))
	);
	/** Ticked in the Forgotten list AND restorable (everything there is). */
	const forgottenSelectionCount = $derived(forgottenSelection.size);
	const selectedId = $derived(history[historyIndex] ?? null);
	const canGoBack = $derived(historyIndex > 0);
	const canGoForward = $derived(historyIndex < history.length - 1);
	/**
	 * The inspector sheet covers the bottom 62% of the body on a phone, so the
	 * canvas has to be told that much of it is not drawable. On a wide screen the
	 * inspector is a sibling column and flex already shrinks the canvas, so there is
	 * nothing to compensate for.
	 */
	const canvasBottomInset = $derived(isMobile && selected ? Math.round(bodyHeight * 0.62) : 0);

	onMount(() => {
		const onResize = () => { windowWidth = window.innerWidth; };
		window.addEventListener('resize', onResize);
		return () => window.removeEventListener('resize', onResize);
	});

	// Opening or closing the inspector changes how much room the canvas has. On a
	// wide screen flex resizes the element but sigma does not notice on its own, and
	// every camera operation — fit, zoom, centring on a search result — is computed
	// against the size it last measured.
	$effect(() => {
		void selected;
		void sidebarWidth;
		// After the DOM has actually reflowed, not before.
		scheduleResize();
	});

	// Load on EVERY open, but never on mount: the modal mounts with the navigator,
	// so fetching there would pull the whole graph for every user who never opens
	// it.
	//
	// "Every open" rather than "the first one" is the load-bearing part. The live
	// subscription below only exists while the modal is open, so everything a
	// conversation recorded while it was closed was missed — and a one-shot loader
	// meant reopening redrew that stale snapshot. Reloading the browser was the
	// only way to see the graph as it actually stood, which is precisely the bug
	// the live refresh was meant to have fixed.
	$effect(() => {
		if (!isOpen) return;
		void memoryGraphStore.refresh();
		void memoryGraphStore.refreshStats();
		void memoryGraphStore.refreshStatus();
		// The composer needs to know whether a model is available to tidy a draft
		// with, and it is the only thing here that reads the config.
		void memoryGraphStore.fetchConfig();
	});

	// Closing has to put the gate back, because the modal is never unmounted — it
	// lives in the navigator — so without this the second open would mount the
	// canvas immediately again, which is precisely the case this exists for.
	$effect(() => {
		if (isOpen) return;
		canvasReady = false;
		if (readyFallback) {
			clearTimeout(readyFallback);
			readyFallback = null;
		}
	});

	/**
	 * The animation is over; the graph may have the thread.
	 *
	 * The timer is a safety net, not a duplicate: `introend` does not fire if the
	 * transition is skipped — a browser that honours reduced motion, or a modal
	 * reopened mid-outro — and a canvas that never mounts is a worse bug than one
	 * that mounts a beat early.
	 */
	function handleOpened(): void {
		if (readyFallback) {
			clearTimeout(readyFallback);
			readyFallback = null;
		}
		canvasReady = true;
	}

	$effect(() => {
		if (!isOpen || canvasReady || readyFallback) return;
		readyFallback = setTimeout(() => {
			readyFallback = null;
			canvasReady = true;
		}, 320);
	});

	// Follow the graph while it is open. Memory is written by conversations
	// happening in other tabs and by background consolidation, so a view that only
	// loaded once was stale within a turn — and the only way to see the new state
	// was to reload the browser.
	$effect(() => {
		if (!isOpen) return;
		return memoryGraphStore.subscribeToChanges();
	});

	// The forgotten list is fetched when its panel opens, not with the graph:
	// most sessions never look at it, and it is a second query over the same table.
	$effect(() => {
		if (panel !== 'forgotten') return;
		void memoryGraphStore.refreshForgotten();
	});

	/** `bin:12:34` — a crowd of memories rather than one of them. */
	function binRegionOf(nodeId: string): GraphRegion | null {
		if (!nodeId.startsWith('bin:')) return null;
		return view.bins.find(bin => bin.id === nodeId)?.region ?? null;
	}

	function visit(nodeId: string | null): void {
		if (!nodeId) {
			history = [];
			historyIndex = -1;
			void memoryGraphStore.select(null);
			return;
		}

		// A merged mark has nothing to inspect — it stands for several memories
		// rather than being one — so choosing it zooms into the patch of the map it
		// covers.
		const binRegion = binRegionOf(nodeId);
		if (binRegion) {
			history = [];
			historyIndex = -1;
			// The inspector is showing a memory from wherever the user was before.
			// Leaving it open next to a patch that does not contain it is the kind of
			// stale panel that makes a view feel like it lost track of itself.
			void memoryGraphStore.select(null);
			memoryGraphStore.focusRegion(binRegion);
			return;
		}

		if (nodeId === selectedId) return;

		// Truncate the forward entries: navigating somewhere new from the middle of
		// the history abandons what came after, the way a browser does.
		history = [...history.slice(0, historyIndex + 1), nodeId];
		historyIndex = history.length - 1;
		void memoryGraphStore.select(nodeId);
	}

	function step(delta: number): void {
		const next = historyIndex + delta;
		if (next < 0 || next >= history.length) return;
		historyIndex = next;
		void memoryGraphStore.select(history[next]);
		canvas?.focusNode(history[next]);
	}

	function handleSearchInput(): void {
		if (searchDebounce) clearTimeout(searchDebounce);
		// Retrieval is milliseconds server-side, but each keystroke is a round trip.
		searchDebounce = setTimeout(() => void memoryGraphStore.search(searchInput), 220);
	}

	function clearSearch(): void {
		searchInput = '';
		memoryGraphStore.clearSearch();
	}

	/**
	 * Go to a node AND bring the camera to it.
	 *
	 * Used by every list — search results and the inspector's own connections —
	 * because in all of those the node being chosen is somewhere off screen or
	 * buried, and selecting it without moving the view leaves the user to hunt for
	 * what they just clicked. Clicking a node ON the canvas deliberately does not
	 * recentre: it is already in view, and yanking the camera on every click makes
	 * the graph feel like it is fighting the pointer.
	 */
	function visitAndFocus(nodeId: string): void {
		visit(nodeId);
		canvas?.focusNode(nodeId);
	}

	function toggleKind(kind: GraphNodeKind): void {
		const next = kinds.includes(kind) ? kinds.filter(k => k !== kind) : [...kinds, kind];
		// Never allow both off — an empty graph reads as a bug, not a filter choice.
		if (next.length === 0) return;
		memoryGraphStore.setFilter({ kinds: next });
	}

	/**
	 * Subkind and source filters are ADDITIVE narrowings: empty means "everything",
	 * not "nothing". A filter that starts by excluding all of its own options would
	 * open onto a blank graph, which reads as a broken view rather than a choice
	 * not yet made.
	 */
	function toggleSubkind(subkind: string): void {
		const current = filter.subkinds;
		memoryGraphStore.setFilter({
			subkinds: current.includes(subkind) ? current.filter(s => s !== subkind) : [...current, subkind]
		});
	}

	function toggleSource(source: GraphSource): void {
		const current = filter.sources;
		memoryGraphStore.setFilter({
			sources: current.includes(source) ? current.filter(s => s !== source) : [...current, source]
		});
	}

	function resetFilters(): void {
		memoryGraphStore.setFilter({ kinds: ['episodic', 'structural'], subkinds: [], sources: [] });
	}

	// ── Forgotten list ──────────────────────────────────────────────────────

	async function deleteSelected(): Promise<void> {
		const count = forgottenSelection.size;
		if (count === 0) return;

		const confirmed = await showConfirm({
			title: 'Delete permanently',
			message: `${count} memory/memories will be removed for good, along with their connections. They have already been forgotten, so nothing that is still recalled is affected — but this cannot be undone.`,
			type: 'error',
			confirmText: `Delete ${count}`,
			cancelText: 'Keep'
		});
		if (!confirmed) return;

		await memoryGraphStore.deleteSelectedForgotten();
	}

	/**
	 * Bring memories back — one, or a whole selection.
	 *
	 * Confirmed, because restoring is not a neutral undo: a restored memory is
	 * handed to every agent on every future turn, and something that was forgotten
	 * was usually forgotten for a reason. The wording says which reason, because
	 * "forgotten" and "replaced" are different claims and undoing them has
	 * different consequences — putting back a memory that something newer
	 * contradicts means the graph is holding both again.
	 */
	async function restore(nodeIds: string[]): Promise<void> {
		if (nodeIds.length === 0) return;
		const nodes = forgotten.filter(node => nodeIds.includes(node.id));
		const replaced = nodes.filter(node => node.supersededBy).length;

		const confirmed = await showConfirm({
			title: nodeIds.length === 1 ? 'Restore this memory' : `Restore ${nodeIds.length} memories`,
			message:
				(nodeIds.length === 1
					? 'It will be recalled again, and handed to agents on future turns.'
					: `They will be recalled again, and handed to agents on future turns.`) +
				(replaced > 0
					? `\n${replaced === nodeIds.length ? (nodeIds.length === 1 ? 'This one was' : 'These were') : `${replaced} of them were`} replaced by something newer rather than forgotten. Restoring means the graph holds both versions again, and whichever ranks higher is what an agent sees.`
					: ''),
			type: replaced > 0 ? 'warning' : 'info',
			confirmText: 'Restore',
			cancelText: 'Leave it'
		});
		if (!confirmed) return;

		await memoryGraphStore.restoreNodes(nodeIds);
	}

	/**
	 * Empty the graph, for one project or for all of them.
	 *
	 * Typing the word is the confirmation rather than a single OK, because this is
	 * the one action here with no undo at all — archived memories can be restored,
	 * and these will not exist to restore. `Dialog` already supports an input and a
	 * disabled confirm button, so the safety does not cost a native prompt.
	 */
	function askToPurge(scope: 'selection' | 'all'): void {
		purgeScope = scope;
		purgeTyped = '';
		deleteAllOpen = false;
		purgeDialogOpen = true;
	}

	const purgeTargetLabel = $derived.by(() => {
		if (purgeScope === 'all') return 'every project';
		const ids = filter.projectIds ?? [];
		if (ids.length === 1) {
			return projectState.projects.find(project => project.id === ids[0])?.name ?? 'this project';
		}
		return `${ids.length} selected project(s)`;
	});

	async function confirmPurge(): Promise<void> {
		if (purgeTyped.trim() !== 'DELETE') return;

		purging = true;
		try {
			const result = await memoryGraphStore.purge(
				purgeScope === 'selection' ? (filter.projectIds ?? []) : undefined
			);
			visit(null);
			await showAlert({
				title: 'Memory cleared',
				message: `Removed ${result.nodes} memory node(s) and ${result.edges} connection(s).`,
				type: 'success'
			});
		} catch (error) {
			await showAlert({
				title: 'Could not clear memory',
				message: error instanceof Error ? error.message : String(error),
				type: 'error'
			});
		} finally {
			purging = false;
		}
	}

	/** Leave Memory and land on its settings, rather than stacking two modals. */
	function openMemorySettings(): void {
		onClose();
		settingsModalState.activeSection = 'memory-graph';
		settingsModalState.isOpen = true;
	}

	// ── Divider drag ────────────────────────────────────────────────────────
	function startDrag(event: PointerEvent): void {
		if (isMobile) return;
		event.preventDefault();
		dragging = true;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	/**
	 * Pointer moves arrive far faster than frames, and a resize is the one canvas
	 * operation that has to rebuild sigma's indices. Coalescing to one per frame
	 * is what keeps dragging the divider smooth on a large graph.
	 */
	let resizeFrame: number | null = null;

	function scheduleResize(): void {
		if (resizeFrame !== null) return;
		resizeFrame = requestAnimationFrame(() => {
			resizeFrame = null;
			canvas?.resize();
		});
	}

	function onDrag(event: PointerEvent): void {
		if (!dragging || !body) return;
		const rect = body.getBoundingClientRect();
		sidebarWidth = Math.max(260, Math.min(rect.width - 320, rect.right - event.clientX));
		scheduleResize();
	}

	function endDrag(event: PointerEvent): void {
		if (!dragging) return;
		dragging = false;
		(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
	}
</script>

<Modal
	bind:isOpen
	{onClose}
	onOpened={handleOpened}
	bare
	mobileFullscreen
	ariaLabelledBy="memory-title"
	className="flex flex-col w-full max-w-[1100px] h-[82dvh] max-h-[820px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]"
>
	{#snippet children()}
		<header
			class="flex items-center gap-2 px-3 py-2.5 border-b border-slate-200 dark:border-slate-800 flex-wrap"
		>
			<div class="flex items-center gap-2 pr-1">
				<Icon name="lucide:brain" class="w-4 h-4 text-violet-500 shrink-0" />
				<h2 id="memory-title" class="text-sm font-semibold text-slate-900 dark:text-slate-100">Memory</h2>
			</div>

			<div class="relative w-[240px] max-w-full">
				<Icon
					name="lucide:search"
					class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none"
				/>
				<input
					bind:value={searchInput}
					oninput={handleSearchInput}
					placeholder="Search memory"
					class="w-full pl-8 pr-7 py-1.5 text-xs rounded-md bg-slate-50 dark:bg-slate-800/70
					       border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100
					       placeholder:text-slate-400 outline-none focus:border-violet-500"
				/>
				{#if searchInput}
					<button
						onclick={clearSearch}
						class="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-400
						       hover:text-slate-600 dark:hover:text-slate-200"
						aria-label="Clear search"
					>
						<Icon name="lucide:x" class="w-3.5 h-3.5" />
					</button>
				{/if}

				<!--
					Anchored to the input rather than floated at the top-left of the canvas.
					A results list that appears somewhere unrelated to where you typed reads
					as a separate panel that happened to open, not as the answer to the
					query — which is how the previous placement felt.

					Hovering a row hovers its node, so scanning the list and scanning the
					graph are the same gesture.
				-->
				{#if searchInput.trim() && !memoryGraphStore.searching}
					<MemoryPopover class="absolute left-0 right-0 top-[calc(100%+4px)] max-h-[320px] overflow-y-auto">
					<div
						role="listbox"
						tabindex="-1"
						onmouseleave={() => memoryGraphStore.setHovered(null)}
					>
						{#if hits.length === 0}
							<p class="px-3 py-2.5 text-[11px] text-slate-400">Nothing matched “{searchInput.trim()}”</p>
						{:else}
							<div class="px-3 py-1.5 border-b border-slate-100 dark:border-slate-800">
								<span class="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
									{hits.length} match{hits.length === 1 ? '' : 'es'}
								</span>
							</div>
							<ul class="py-1">
								{#each hits as hit (hit.node.id)}
									<li>
										<button
											onclick={() => visitAndFocus(hit.node.id)}
											onmouseenter={() => memoryGraphStore.setHovered(hit.node.id)}
											onfocus={() => memoryGraphStore.setHovered(hit.node.id)}
											class="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800
											       transition-colors"
										>
											<span class="block text-[11px] leading-snug break-words text-slate-700 dark:text-slate-200">
												{hit.node.label}
											</span>
											<span class="block text-[9px] uppercase tracking-wide text-slate-400 mt-0.5">
												{hit.node.subkind}{hit.node.projectId === null ? ' · global' : ''}
											</span>
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
					</MemoryPopover>
				{/if}
			</div>

			<!--
				Searchable and multiple, because a native select stops working at about a
				dozen options and "these two repositories" is an ordinary thing to want of
				a store that spans every project. There is no "Global" entry: clearing the
				selection already means it, since nothing selected is a narrowing rather
				than the absence of one.
			-->
			<SearchableMultiSelect
				class="w-[170px] max-w-[45vw]"
				options={projectOptions}
				selected={filter.projectIds}
				onChange={(projectIds) => memoryGraphStore.setFilter({ projectIds })}
				allLabel="All projects"
				emptyLabel="Global only"
				placeholder="Find a project…"
			/>

			<button
				onclick={() => (panel = panel === 'filters' ? 'none' : 'filters')}
				class="flex items-center gap-1.5 px-2 py-1.5 text-[11px] rounded-md border transition-colors
				       {activeFilterCount > 0 || panel === 'filters'
					? 'border-violet-500/40 bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300'
					: 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}"
			>
				<Icon name="lucide:sliders-horizontal" class="w-3.5 h-3.5" />
				Filter
				{#if activeFilterCount > 0}
					<span class="px-1 rounded bg-violet-500 text-white text-[9px] leading-4">{activeFilterCount}</span>
				{/if}
			</button>

			<button
				onclick={() => (panel = panel === 'forgotten' ? 'none' : 'forgotten')}
				class="flex items-center gap-1.5 px-2 py-1.5 text-[11px] rounded-md border transition-colors
				       {panel === 'forgotten'
					? 'border-violet-500/40 bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300'
					: 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}"
			>
				<Icon name="lucide:archive" class="w-3.5 h-3.5" />
				Forgotten
			</button>

			<div class="ml-auto flex items-center gap-2">
				<!-- Only speaks up when something is happening; see MemoryStatus. -->
				<MemoryStatus variant="bar" />

				<!--
					A bare number in a header is a riddle. This one said "142 of 310" with
					nothing to say what was being counted or why the two differed — it is
					how many nodes are DRAWN against how many match the filter, which
					matters precisely when the graph is too large to draw. Now it carries an
					icon, a unit and a title that explains the gap.
				-->
				{#if drawnCount > 0}
					<span
						class="hidden sm:inline-flex items-center gap-1 px-1.5 py-1 rounded-md
						       text-[10px] text-slate-500 dark:text-slate-400 bg-slate-100/70 dark:bg-slate-800/70"
						title={view.level === 'binned'
							? `${view.totalNodes} memories and code entities, all of them in the picture. ${mergedCount} sit close enough together to share ${view.bins.length} marks — click one to zoom in.`
							: view.truncated
								? `Showing the ${view.nodes.length} most reinforced of ${view.totalNodes} matching memories. Narrow the filter to see the rest.`
								: `${view.nodes.length} memories and code entities`}
					>
						<Icon name="lucide:circle-dot" class="w-3 h-3 opacity-70" />
						{#if view.level === 'binned'}
							{view.totalNodes}
						{:else}
							{view.nodes.length}{view.truncated ? ` / ${view.totalNodes}` : ''}
						{/if}
					</span>
				{/if}
				{#if stats && !stats.embedding.ready}
					<span class="hidden sm:inline text-[10px] text-amber-600 dark:text-amber-400" title="The local search model is still installing. Search matches keywords only until it lands.">
						preparing search
					</span>
				{/if}

				{#if canEdit}
					<button
						onclick={() => (composerOpen = true)}
						class="flex items-center gap-1.5 px-2 py-1.5 text-[11px] rounded-md border
						       border-violet-500/40 bg-violet-50 dark:bg-violet-500/10
						       text-violet-700 dark:text-violet-300 hover:bg-violet-100 dark:hover:bg-violet-500/20"
						title="Write a memory yourself, without going through a conversation"
					>
						<Icon name="lucide:plus" class="w-3.5 h-3.5" />
						<span class="hidden sm:inline">Remember</span>
					</button>
				{/if}

				<button
					onclick={openMemorySettings}
					class="flex p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200
					       hover:bg-slate-100 dark:hover:bg-slate-800"
					aria-label="Memory settings"
					title="Settings → Infrastructure → Memory"
				>
					<Icon name="lucide:settings" class="w-4 h-4" />
				</button>

				<button
					onclick={onClose}
					class="flex p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200
					       hover:bg-slate-100 dark:hover:bg-slate-800"
					aria-label="Close"
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</div>
		</header>

		<div bind:this={body} bind:clientHeight={bodyHeight} class="flex-1 min-h-0 flex relative">
			<div class="flex-1 min-w-0 flex flex-col relative">
				{#if !canvasReady || (memoryGraphStore.loading && drawnCount === 0)}
					<!-- Held back until the modal has finished opening; see `canvasReady`. -->
					<div class="flex-1 flex items-center justify-center"><LoadingSpinner /></div>
				{:else if drawnCount === 0}
					<div class="flex-1 flex flex-col items-center justify-center gap-2 text-slate-400 px-6 text-center">
						<Icon name="lucide:brain" class="w-10 h-10 opacity-25" />
						<span class="text-sm font-medium">No memories yet</span>
						<span class="text-xs max-w-[260px] leading-relaxed">
							This fills itself as you work — what gets decided, what breaks and the files involved
							are recorded after each conversation.
						</span>
					</div>
				{:else}
					<MemoryGraphCanvas
						bind:this={canvas}
						{selectedId}
						{highlightIds}
						bottomInset={canvasBottomInset}
						onSelect={visit}
					/>
				{/if}

				{#if canvasReady && region}
					<button
						onclick={() => memoryGraphStore.clearRegion()}
						class="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-2.5 py-1
						       rounded-full border border-slate-200 dark:border-slate-800
						       bg-white/90 dark:bg-slate-900/90 text-[10px] text-slate-500 dark:text-slate-400
						       hover:text-slate-800 dark:hover:text-slate-100 shadow-sm backdrop-blur-sm
						       whitespace-nowrap"
					>
						<Icon name="lucide:arrow-left" class="w-3 h-3" />
						Back to everything
					</button>
				{:else if canvasReady && view.level === 'binned'}
					<!--
						Said once, quietly, at the bottom of the canvas rather than as a
						banner. The whole graph is already on screen — this only explains
						the larger marks, which are the one thing that is not literal.
					-->
					<div
						class="absolute bottom-3 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-full
						       border border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90
						       text-[10px] text-slate-500 dark:text-slate-400 shadow-sm backdrop-blur-sm
						       pointer-events-none whitespace-nowrap"
					>
						{view.bins.length} crowded spots · click one to zoom in
					</div>
				{/if}


				{#if panel === 'filters'}
					<!--
						A popover rather than more buttons in the header. There are now
						thirteen possible narrowings, and a row of thirteen toggles is not a
						filter, it is a wall.
					-->
					<MemoryPopover class="absolute left-3 top-3 w-[280px]">
					<div class="p-3">
						<div class="flex items-center justify-between mb-2.5">
							<span class="text-[11px] font-semibold text-slate-700 dark:text-slate-200">Filter</span>
							<button
								onclick={resetFilters}
								class="text-[10px] text-slate-400 hover:text-violet-600 dark:hover:text-violet-400"
							>
								Reset
							</button>
						</div>

						<span class="block text-[9px] uppercase tracking-wide text-slate-400 mb-1.5">Show</span>
						<div class="flex flex-wrap gap-1 mb-3">
							{#each [{ kind: 'episodic' as GraphNodeKind, label: 'Memories' }, { kind: 'structural' as GraphNodeKind, label: 'Code' }] as option (option.kind)}
								<button
									onclick={() => toggleKind(option.kind)}
									class="px-2 py-1 text-[10px] rounded border transition-colors {kinds.includes(option.kind)
										? 'border-violet-500/40 bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300'
										: 'border-slate-200 dark:border-slate-700 text-slate-400'}"
								>
									{option.label}
								</button>
							{/each}
						</div>

						{#if kinds.includes('episodic')}
							<span class="block text-[9px] uppercase tracking-wide text-slate-400 mb-1.5">Kind of memory</span>
							<div class="flex flex-wrap gap-1 mb-3">
								{#each EPISODIC_SUBKINDS as subkind (subkind)}
									<button
										onclick={() => toggleSubkind(subkind)}
										class="px-2 py-1 text-[10px] rounded border capitalize transition-colors {filter.subkinds.includes(subkind)
											? 'border-violet-500/40 bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300'
											: 'border-slate-200 dark:border-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}"
									>
										{subkind}
									</button>
								{/each}
							</div>
						{/if}

						{#if kinds.includes('structural')}
							<span class="block text-[9px] uppercase tracking-wide text-slate-400 mb-1.5">Kind of code</span>
							<div class="flex flex-wrap gap-1 mb-3">
								{#each STRUCTURAL_SUBKINDS as subkind (subkind)}
									<button
										onclick={() => toggleSubkind(subkind)}
										class="px-2 py-1 text-[10px] rounded border capitalize transition-colors {filter.subkinds.includes(subkind)
											? 'border-violet-500/40 bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300'
											: 'border-slate-200 dark:border-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}"
									>
										{subkind}
									</button>
								{/each}
							</div>
						{/if}

						<span class="block text-[9px] uppercase tracking-wide text-slate-400 mb-1.5">Written by</span>
						<div class="flex flex-wrap gap-1">
							{#each [{ source: 'agent' as GraphSource, label: 'Recorded for you' }, { source: 'user' as GraphSource, label: 'Written by you' }] as option (option.source)}
								<button
									onclick={() => toggleSource(option.source)}
									class="px-2 py-1 text-[10px] rounded border transition-colors {filter.sources.includes(option.source)
										? 'border-violet-500/40 bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300'
										: 'border-slate-200 dark:border-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}"
								>
									{option.label}
								</button>
							{/each}
						</div>
					</div>
					</MemoryPopover>
				{/if}

				{#if panel === 'forgotten'}
					<MemoryPopover class="absolute left-3 top-3 bottom-3 w-[320px] max-w-[85vw] flex flex-col">
					<div class="flex-1 min-h-0 flex flex-col">
						<div class="flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-800">
							<div>
								<span class="text-[11px] font-semibold text-slate-700 dark:text-slate-200">Forgotten</span>
								<span class="text-[10px] text-slate-400 ml-1.5">{memoryGraphStore.forgottenTotal}</span>
							</div>
							<button
								onclick={() => (panel = 'none')}
								class="flex p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
								aria-label="Close forgotten list"
							>
								<Icon name="lucide:x" class="w-3.5 h-3.5" />
							</button>
						</div>

						{#if memoryGraphStore.forgottenLoading}
							<div class="flex-1 flex items-center justify-center"><LoadingSpinner /></div>
						{:else if forgotten.length === 0}
							<p class="flex-1 flex items-center justify-center px-4 text-[11px] text-slate-400 text-center">
								Nothing has been forgotten. Memories archived here can be restored, or removed for good.
							</p>
						{:else}
							{#if canEdit}
								<div class="flex items-center gap-2 px-3 py-1.5 border-b border-slate-100 dark:border-slate-800">
									<button
										onclick={() => memoryGraphStore.selectAllForgotten(forgottenSelection.size !== forgotten.length)}
										class="text-[10px] text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400"
									>
										{forgottenSelection.size === forgotten.length ? 'Clear selection' : 'Select all'}
									</button>
									{#if forgottenSelection.size > 0}
										<button
											onclick={deleteSelected}
											class="ml-auto text-[10px] font-medium text-red-600 dark:text-red-400 hover:underline"
										>
											Delete {forgottenSelection.size} permanently
										</button>
									{/if}
								</div>
							{/if}

							<ul class="flex-1 overflow-y-auto py-1">
								{#each forgotten as node (node.id)}
									<li class="flex items-start gap-2 px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/60">
										{#if canEdit}
											<input
												type="checkbox"
												checked={forgottenSelection.has(node.id)}
												onchange={() => memoryGraphStore.toggleForgottenSelection(node.id)}
												class="mt-0.5 accent-violet-600"
												aria-label="Select {node.label}"
											/>
										{/if}
										<div class="min-w-0 flex-1">
											<span class="block text-[11px] leading-snug break-words text-slate-600 dark:text-slate-300">
												{node.label}
											</span>
											<span class="block text-[9px] uppercase tracking-wide text-slate-400 mt-0.5">
												{node.subkind} ·
												<!--
													Two different claims, and the wording keeps them apart:
													"forgotten" means it was wrong, "replaced" means it was
													true and something newer took its place.
												-->
												{node.supersededBy ? 'replaced' : 'forgotten'}
											</span>
										</div>
										{#if canEdit}
											<!--
												Offered for REPLACED memories too, which it previously was
												not. Supersession is a judgement a model made while reading
												a transcript, and leaving it as the one thing the user could
												not undo meant their only recourse against a wrong revision
												was permanent deletion — which is how "reversible" ends up a
												property of the schema rather than of the product.
											-->
											<button
												onclick={() => void restore([node.id])}
												class="text-[10px] text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 shrink-0"
											>
												Restore
											</button>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}

						{#if canEdit}
							<!--
								One quiet link instead of a "Danger zone".

								Two permanently visible red links under a list the user opened in
								order to REVIEW things read as an invitation, and the more
								destructive of the two sat closest to the everyday controls. The
								choice of scope now lives behind the link, in a dialog, where the
								two options can be described rather than merely labelled.
							-->
							<div class="px-3 py-2 border-t border-slate-200/70 dark:border-slate-700/70">
								<button
									onclick={() => (deleteAllOpen = true)}
									disabled={purging}
									class="flex items-center gap-1.5 text-[10px] text-slate-400
									       hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40 transition-colors"
								>
									<Icon name="lucide:trash-2" class="w-3 h-3" />
									Delete memories in bulk…
								</button>
							</div>
						{/if}
					</div>
					</MemoryPopover>
				{/if}
			</div>

			{#if isMobile}
				{#if selected}
					<!-- On a phone a side column would be unreadably narrow, so the
					     inspector becomes a sheet over the graph instead. -->
					<div
						class="absolute inset-x-0 bottom-0 h-[62%] flex flex-col rounded-t-2xl
						       bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800
						       shadow-[0_-8px_30px_-12px_rgba(0,0,0,0.3)] z-10 memory-sheet"
					>
						<div class="flex items-center justify-center py-2 shrink-0">
							<span class="w-9 h-1 rounded-full bg-slate-300 dark:bg-slate-700"></span>
						</div>
						{#if memoryGraphStore.selectedLoading}
							<div class="flex-1 flex items-center justify-center"><LoadingSpinner /></div>
						{:else}
							<MemoryNodeInspector
								detail={selected}
								{canEdit}
								onSelect={visitAndFocus}
								{canGoBack}
								{canGoForward}
								onBack={() => step(-1)}
								onForward={() => step(1)}
								onClose={() => visit(null)}
							/>
						{/if}
					</div>
				{/if}
			{:else}
				<!-- Always mounted at zero width so opening and closing the inspector
				     is a slide rather than a jump, and the canvas re-flows with it. -->
				<div
					class="shrink-0 flex overflow-hidden border-l border-slate-200 dark:border-slate-800
					       {dragging ? '' : 'transition-[width] duration-200 ease-out'}"
					style="width: {selected ? sidebarWidth : 0}px; border-left-width: {selected ? 1 : 0}px"
					ontransitionend={() => canvas?.resize()}
				>
					<div
						class="w-1 shrink-0 cursor-col-resize hover:bg-violet-400 dark:hover:bg-violet-500
						       transition-colors {dragging ? 'bg-violet-500 dark:bg-violet-500' : ''}"
						onpointerdown={startDrag}
						onpointermove={onDrag}
						onpointerup={endDrag}
						onpointercancel={endDrag}
						role="separator"
						aria-orientation="vertical"
						aria-label="Resize details panel"
					></div>

					<div class="flex-1 min-w-0 flex flex-col min-h-0 relative" style="width: {sidebarWidth}px">
						{#if memoryGraphStore.selectedLoading}
							<div class="flex-1 flex items-center justify-center"><LoadingSpinner /></div>
						{:else if selected}
								<MemoryNodeInspector
								detail={selected}
								{canEdit}
								onSelect={visitAndFocus}
								{canGoBack}
								{canGoForward}
								onBack={() => step(-1)}
								onForward={() => step(1)}
								onClose={() => visit(null)}
							/>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	{/snippet}
</Modal>

<!--
	Typed confirmation for the only action in this feature with no undo. Kept as a
	local Dialog rather than the shared `showConfirm`, because that helper has no
	text input — and a single OK button is too small a gesture for "delete every
	memory in every project".
-->
<Dialog
	bind:isOpen={purgeDialogOpen}
	bind:inputValue={purgeTyped}
	onClose={() => (purgeDialogOpen = false)}
	title="Delete all memory"
	type="error"
	message={`Every memory, code entity and connection for ${purgeTargetLabel} will be removed. Forgotten memories can be restored; these cannot, because there will be nothing left to restore.

Type DELETE to confirm.`}
	inputPlaceholder="DELETE"
	confirmText="Delete everything"
	cancelText="Cancel"
	confirmDisabled={purgeTyped.trim() !== 'DELETE'}
	onConfirm={() => void confirmPurge()}
/>

<!--
	The scope chooser, which is what replaced the "Danger zone" footer.
	
	Two separate actions rather than one control with a checkbox, because a project
	purge deliberately leaves global memories alone — preferences and conventions
	were never that repository's to hold, and losing them because one repo was
	cleaned would be a surprise. Stating that here is what makes the difference
	between them legible; two red links could only label it.
-->
<Modal
	bind:isOpen={deleteAllOpen}
	onClose={() => (deleteAllOpen = false)}
	bare
	ariaLabelledBy="memory-delete-all-title"
	className="w-full max-w-[420px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.3)]"
>
	{#snippet children()}
		<div class="px-4 py-3.5">
			<h3 id="memory-delete-all-title" class="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
				Delete memories in bulk
			</h3>
			<p class="text-xs text-slate-500 dark:text-slate-400 mb-3.5 leading-relaxed">
				Neither of these can be undone. Individual memories can be forgotten and restored instead —
				that is what the list behind this is for.
			</p>

			{#if (filter.projectIds?.length ?? 0) > 0}
				<button
					onclick={() => askToPurge('selection')}
					class="w-full text-left px-3 py-2.5 mb-2 rounded-lg border border-slate-200 dark:border-slate-700
					       hover:border-red-300 dark:hover:border-red-900/60 hover:bg-red-50/50 dark:hover:bg-red-900/10
					       transition-colors"
				>
					<span class="block text-xs font-medium text-slate-800 dark:text-slate-200">
						Only the {filter.projectIds?.length === 1 ? 'selected project' : `${filter.projectIds?.length} selected projects`}
					</span>
					<span class="block text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
						Leaves global memories alone — the preferences and conventions that were never a
						repository's to hold.
					</span>
				</button>
			{/if}

			<button
				onclick={() => askToPurge('all')}
				class="w-full text-left px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700
				       hover:border-red-300 dark:hover:border-red-900/60 hover:bg-red-50/50 dark:hover:bg-red-900/10
				       transition-colors"
			>
				<span class="block text-xs font-medium text-red-600 dark:text-red-400">Everything, every project</span>
				<span class="block text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
					Including the global memories about how you work. The graph starts empty.
				</span>
			</button>

			<div class="flex justify-end mt-3.5">
				<button
					onclick={() => (deleteAllOpen = false)}
					class="px-3 py-1.5 text-xs rounded-md text-slate-500 dark:text-slate-400
					       hover:bg-slate-100 dark:hover:bg-slate-800"
				>
					Cancel
				</button>
			</div>
		</div>
	{/snippet}
</Modal>

<MemoryComposer bind:isOpen={composerOpen} onClose={() => (composerOpen = false)} onCreated={visitAndFocus} />

<style>
	/* The phone sheet slides up rather than appearing, matching the desktop panel. */
	.memory-sheet {
		animation: memory-sheet-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
	}

	@keyframes memory-sheet-in {
		from {
			transform: translateY(12%);
			opacity: 0;
		}
		to {
			transform: translateY(0);
			opacity: 1;
		}
	}
</style>
