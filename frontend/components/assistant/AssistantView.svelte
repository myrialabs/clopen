<script lang="ts">
	/**
	 * Clopen's own screen — Chat or Tasks, chosen in the sidebar.
	 *
	 * Chat is one conversation, like Telegram (see ClopenChat), in one
	 * container; while an agent is using a browser, its live view floats over
	 * the chat — moved by its header, sized by its corner, kept where the owner
	 * left it — and the chat column never moves (fold it to a pill, or close
	 * it until an agent takes another tab). When the agent lets go, the last
	 * frame stays a moment marked done, then folds to a pill. Tasks is two
	 * containers: the list and the selected task, with a gap between them
	 * that is dragged to size the list.
	 *
	 * On a phone: one thing at a time; the live view is a pill that opens over
	 * the chat.
	 */
	import { onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ClopenChat from './ClopenChat.svelte';
	import TaskList from './TaskList.svelte';
	import TaskDetail from './TaskDetail.svelte';
	import FlowDetail from './FlowDetail.svelte';
	import FlowCompose from './FlowCompose.svelte';
	import LiveCard from './LiveCard.svelte';
	import { assistantStore, type LiveTab } from '$frontend/stores/features/assistant.svelte';
	import { assistantView, openTask, saveAssistantLayout, TASK_LIST_MAX, TASK_LIST_MIN, type LiveBox } from '$frontend/stores/ui/assistant-view.svelte';

	interface Props {
		mobile?: boolean;
	}

	const { mobile = false }: Props = $props();

	let liveTab = $state<LiveTab | null>(null);
	let liveOpenOnPhone = $state(false);
	/** The agent let go of the tab shown: it stays as "Done", then folds, then goes. */
	let liveFinished = $state(false);
	let finishTimers: Array<ReturnType<typeof setTimeout>> = [];

	const DONE_SHOWN_MS = 4000;
	const PILL_SHOWN_MS = 30_000;

	function clearFinish() {
		finishTimers.forEach(clearTimeout);
		finishTimers = [];
	}

	const liveKey = $derived(liveTab ? `${liveTab.projectId}:${liveTab.tabId}` : null);
	const showLive = $derived(Boolean(liveTab) && liveKey !== assistantView.liveDismissedFor);

	// Which browser tab an agent is driving, if any.
	onMount(() => {
		void assistantStore.refreshOverview();
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const poll = async () => {
			if (stopped) return;
			const tabs = await assistantStore.liveTabs();
			const controlled = tabs.find((tab) => tab.controlledBy || tab.heldByOwner) ?? null;
			const key = controlled ? `${controlled.projectId}:${controlled.tabId}` : null;
			if (controlled && key !== liveKey) {
				clearFinish();
				liveTab = controlled;
				liveFinished = false;
				assistantView.liveCollapsed = false;
			} else if (controlled) {
				if (liveFinished) {
					clearFinish();
					liveFinished = false;
				}
				liveTab = controlled;
			} else if (liveTab && !liveFinished) {
				// Not snatched away: the last frame stays as "Done", folds to a pill, then goes.
				liveFinished = true;
				finishTimers = [
					setTimeout(() => (assistantView.liveCollapsed = true), DONE_SHOWN_MS),
					setTimeout(() => {
						liveTab = null;
						liveFinished = false;
					}, DONE_SHOWN_MS + PILL_SHOWN_MS)
				];
			}
			if (!stopped) timer = setTimeout(poll, 4000);
		};
		void poll();
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
			clearFinish();
		};
	});

	const container = 'bg-white/90 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-xl';

	// ── The gap beside the Tasks list: drag to size the list ──
	let listEl = $state<HTMLElement>();
	let sizingList = $state(false);

	function startListResize(event: PointerEvent) {
		if (!listEl) return;
		event.preventDefault();
		const left = listEl.getBoundingClientRect().left;
		sizingList = true;
		const move = (moved: PointerEvent) => {
			assistantView.taskListWidth = Math.round(Math.min(TASK_LIST_MAX, Math.max(TASK_LIST_MIN, moved.clientX - left)));
		};
		const up = () => {
			sizingList = false;
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			saveAssistantLayout();
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}

	// ── The floating live view: moved by its header, sized by its corner, kept inside the chat ──
	let chatWidth = $state(0);
	let chatHeight = $state(0);
	let movingLive = $state(false);
	const LIVE_MIN_WIDTH = 280;
	const LIVE_MIN_HEIGHT = 220;
	const EDGE = 12;

	/** Where it is now: as the owner left it, or the default card on the right — always inside the chat. */
	const liveBox = $derived.by((): LiveBox => {
		const fallback = { right: EDGE, top: EDGE, width: Math.min(520, Math.max(LIVE_MIN_WIDTH, chatWidth * 0.38)), height: Math.max(LIVE_MIN_HEIGHT, chatHeight - EDGE * 2) };
		return fit(assistantView.liveBox ?? fallback);
	});

	function fit(box: LiveBox): LiveBox {
		if (!chatWidth || !chatHeight) return box;
		const width = Math.min(Math.max(LIVE_MIN_WIDTH, box.width), Math.max(LIVE_MIN_WIDTH, chatWidth - EDGE * 2));
		const height = Math.min(Math.max(LIVE_MIN_HEIGHT, box.height), Math.max(LIVE_MIN_HEIGHT, chatHeight - EDGE * 2));
		return {
			width,
			height,
			right: Math.min(Math.max(0, box.right), Math.max(0, chatWidth - width)),
			top: Math.min(Math.max(0, box.top), Math.max(0, chatHeight - height))
		};
	}

	function dragLive(event: PointerEvent, mode: 'move' | 'size') {
		event.preventDefault();
		const start = { x: event.clientX, y: event.clientY, box: { ...liveBox } };
		movingLive = true;
		const move = (moved: PointerEvent) => {
			const dx = moved.clientX - start.x;
			const dy = moved.clientY - start.y;
			assistantView.liveBox = fit(
				mode === 'move'
					? { ...start.box, right: start.box.right - dx, top: start.box.top + dy }
					: // The handle is the bottom-left corner: the right edge stays put.
						{ ...start.box, width: start.box.width - dx, height: start.box.height + dy }
			);
		};
		const up = () => {
			movingLive = false;
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			saveAssistantLayout();
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}
</script>

{#snippet livePill()}
	<button
		type="button"
		class="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-emerald-300/60 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 text-xs text-emerald-700 dark:text-emerald-300 cursor-pointer shadow-sm"
		onclick={() => (mobile ? (liveOpenOnPhone = true) : (assistantView.liveCollapsed = false))}
	>
		<span class="w-1.5 h-1.5 rounded-full {liveFinished ? 'bg-slate-400' : 'bg-emerald-500 animate-pulse'}"></span>
		{liveFinished ? 'Browser · done' : `${liveTab?.controlledBy?.title ?? 'An agent'} is using a browser`}
		<Icon name="lucide:maximize-2" class="w-3 h-3" />
	</button>
{/snippet}

{#snippet chat()}
	<div class="relative flex-1 min-w-0 h-full overflow-hidden {mobile ? '' : container}" bind:clientWidth={chatWidth} bind:clientHeight={chatHeight}>
		{#key assistantView.chatId}
			<ClopenChat chatId={assistantView.chatId} {mobile} />
		{/key}
		{#if showLive && (mobile || assistantView.liveCollapsed)}
			<div class="absolute top-3 left-1/2 -translate-x-1/2 z-10" transition:fly={{ y: -8, duration: 200, easing: cubicOut }}>{@render livePill()}</div>
		{/if}
		{#if !mobile && showLive && !assistantView.liveCollapsed && liveTab}
			<div
				class="absolute z-10 {movingLive ? 'select-none' : ''}"
				style="right: {liveBox.right}px; top: {liveBox.top}px; width: {liveBox.width}px; height: {liveBox.height}px;"
				transition:fly={{ x: 40, duration: 260, easing: cubicOut }}
			>
				<LiveCard
					tab={liveTab}
					finished={liveFinished}
					onCollapse={() => (assistantView.liveCollapsed = true)}
					onClose={() => (assistantView.liveDismissedFor = liveKey)}
					onDragStart={(event) => dragLive(event, 'move')}
				/>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="absolute -left-1 -bottom-1 w-4 h-4 cursor-nesw-resize touch-none"
					title="Resize"
					onpointerdown={(event) => dragLive(event, 'size')}
				></div>
			</div>
		{/if}
	</div>
{/snippet}

{#snippet taskMain()}
	{#if assistantView.selected?.type === 'task'}
		{#key assistantView.selected.id}
			<TaskDetail taskId={assistantView.selected.id} {mobile} onBack={mobile ? () => openTask(null) : undefined} />
		{/key}
	{:else if assistantView.selected?.type === 'repeat' && assistantView.selected.id === 'new'}
		<FlowCompose {mobile} />
	{:else if assistantView.selected?.type === 'repeat'}
		{#key assistantView.selected.id}
			<FlowDetail flowId={assistantView.selected.id === 'new' ? null : assistantView.selected.id} {mobile} onBack={mobile ? () => openTask(null) : undefined} />
		{/key}
	{:else}
		<div class="h-full flex flex-col items-center justify-center gap-2 text-sm text-slate-400">
			<Icon name="lucide:list-checks" class="w-6 h-6" />
			Pick a task to see its plan
		</div>
	{/if}
{/snippet}

{#if mobile}
	<div class="relative flex flex-col h-full w-full min-h-0">
		{#if assistantView.tab === 'chat'}
			{@render chat()}
		{:else if assistantView.selected}
			<div class="flex-1 min-h-0">{@render taskMain()}</div>
		{:else}
			<div class="flex-1 min-h-0 p-3"><TaskList /></div>
		{/if}

		{#if showLive && liveOpenOnPhone && liveTab}
			<div class="absolute inset-0 z-20 p-3 bg-slate-50/95 dark:bg-slate-950/95 overflow-y-auto">
				<LiveCard tab={liveTab} finished={liveFinished} onCollapse={() => (liveOpenOnPhone = false)} onClose={() => { assistantView.liveDismissedFor = liveKey; liveOpenOnPhone = false; }} />
			</div>
		{/if}
	</div>
{:else}
	<div class="flex h-full w-full min-h-0 gap-3">
		{#if assistantView.tab === 'tasks'}
			<aside class="relative shrink-0 h-full min-h-0 p-3 {container}" style="width: {assistantView.taskListWidth}px" bind:this={listEl}>
				<TaskList />
				<!-- The gap to the task: drag to size the list. -->
				<div
					class="absolute top-0 -right-3 w-3 h-full z-10 flex items-center justify-center cursor-col-resize transition-colors duration-150 {sizingList ? 'bg-violet-500/10' : 'hover:bg-violet-500/5'}"
					role="separator"
					aria-orientation="vertical"
					aria-label="Resize the task list"
					onpointerdown={startListResize}
				>
					<div class="w-0.5 h-12 rounded bg-violet-500/20 transition-all duration-150 {sizingList ? 'bg-violet-600 scale-110' : ''}"></div>
				</div>
			</aside>
		{/if}

		{#if assistantView.tab === 'chat'}
			{@render chat()}
		{:else}
			<section class="flex-1 min-w-0 h-full min-h-0 overflow-hidden {container}">
				{@render taskMain()}
			</section>
		{/if}
	</div>
{/if}

