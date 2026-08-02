<script lang="ts">
	/**
	 * Console panel for the preview browser.
	 *
	 * Shows what the previewed page logged and evaluates expressions in it.
	 * Everything arrives as events from the backend, so the panel holds no live
	 * handles and survives navigation without going stale.
	 *
	 * Two layout decisions are load-bearing:
	 * - The prompt lives at the **bottom of the log stream**, not in a separate
	 *   field. That is what a real console is: input and output are one
	 *   transcript, and a detached input box breaks the reading order.
	 * - It docks to the bottom or the right, and the choice only appears once the
	 *   panel is wide enough to make a side dock usable — the same
	 *   width-driven rule the Files panel uses for its second column.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ConsoleValue from './ConsoleValue.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import type { BrowserConsoleMessage, BrowserConsoleType } from '$frontend/utils/native-ui';
	import type { IconName } from '$shared/types/ui/icons';

	let {
		logs = [] as BrowserConsoleMessage[],
		isMobile = false,
		/** Width of the preview panel, which decides whether side-docking is offered. */
		panelWidth = 0,
		dock = $bindable<'bottom' | 'right'>('bottom'),
		height = $bindable(240),
		width = $bindable(380),
		onClose = () => {},
		onClear = () => {},
		onExecute = (_command: string) => {}
	} = $props();

	type LevelFilter = 'all' | 'error' | 'warn' | 'info' | 'log';

	let levelFilter = $state<LevelFilter>('all');
	let searchTerm = $state('');
	let showTimestamps = $state(false);
	let autoScroll = $state(true);
	let command = $state('');
	let scrollContainer = $state<HTMLDivElement | undefined>();
	let promptElement = $state<HTMLTextAreaElement | undefined>();

	/**
	 * Side-docking needs room for both the preview and a readable transcript.
	 * Below this the bottom dock is the only sensible layout, so the control is
	 * hidden rather than offered and then fought with.
	 */
	const SIDE_DOCK_THRESHOLD = 900;
	const canSideDock = $derived(!isMobile && panelWidth >= SIDE_DOCK_THRESHOLD);

	// Falling below the threshold (panel resized, window shrunk) has to pull the
	// console back to the bottom, or it would be stuck in an unusable sliver.
	$effect(() => {
		if (!canSideDock && dock === 'right') dock = 'bottom';
	});

	/** REPL history, newest last; `historyIndex` walks backwards through it. */
	let history = $state<string[]>([]);
	let historyIndex = $state(-1);
	let draftBeforeHistory = '';

	const counts = $derived.by(() => {
		const tally = { error: 0, warn: 0, info: 0, log: 0 };
		for (const entry of logs) {
			const weight = entry.count ?? 1;
			if (entry.type === 'error') tally.error += weight;
			else if (entry.type === 'warn') tally.warn += weight;
			else if (entry.type === 'info') tally.info += weight;
			else if (entry.type !== 'clear') tally.log += weight;
		}
		return tally;
	});

	const visibleLogs = $derived.by(() => {
		const needle = searchTerm.trim().toLowerCase();

		return logs.filter((entry) => {
			if (entry.type === 'clear') return false;

			if (levelFilter !== 'all') {
				if (levelFilter === 'log') {
					// "Logs" is the everything-else bucket, but REPL echo and its
					// result always show — hiding your own input is disorienting.
					if (['error', 'warn', 'info'].includes(entry.type)) return false;
				} else if (entry.type !== levelFilter && entry.type !== 'input' && entry.type !== 'result') {
					return false;
				}
			}

			if (!needle) return true;
			return (
				entry.text.toLowerCase().includes(needle) ||
				entry.location?.url.toLowerCase().includes(needle) ||
				entry.values?.some((value) => value.preview.toLowerCase().includes(needle))
			);
		});
	});

	const levels: Array<{ id: LevelFilter; label: string; icon: IconName }> = [
		{ id: 'all', label: 'All messages', icon: 'lucide:list' },
		{ id: 'error', label: 'Errors', icon: 'lucide:circle-x' },
		{ id: 'warn', label: 'Warnings', icon: 'lucide:triangle-alert' },
		{ id: 'info', label: 'Info', icon: 'lucide:info' },
		{ id: 'log', label: 'Logs', icon: 'lucide:message-square' }
	];

	function rowClass(type: BrowserConsoleType): string {
		switch (type) {
			case 'error':
				return 'bg-red-50/70 dark:bg-red-950/30 border-l-2 border-red-500';
			case 'warn':
				return 'bg-amber-50/70 dark:bg-amber-950/30 border-l-2 border-amber-500';
			case 'input':
				return 'bg-slate-50 dark:bg-slate-800/60 border-l-2 border-violet-500';
			default:
				return 'border-l-2 border-transparent';
		}
	}

	function rowIcon(type: BrowserConsoleType): { name: IconName; class: string } | null {
		switch (type) {
			case 'error':
				return { name: 'lucide:circle-x', class: 'text-red-500' };
			case 'warn':
				return { name: 'lucide:triangle-alert', class: 'text-amber-500' };
			case 'info':
				return { name: 'lucide:info', class: 'text-sky-500' };
			case 'input':
				return { name: 'lucide:chevron-right', class: 'text-violet-500' };
			case 'result':
				return { name: 'lucide:corner-down-left', class: 'text-slate-400' };
			default:
				return null;
		}
	}

	function formatTime(timestamp: number): string {
		return new Date(timestamp).toLocaleTimeString(undefined, { hour12: false });
	}

	/** Strip the origin so the source column stays readable at panel width. */
	function shortSource(url: string, line?: number): string {
		try {
			const parsed = new URL(url);
			const file = parsed.pathname.split('/').pop() || parsed.hostname;
			return line ? `${file}:${line}` : file;
		} catch {
			return line ? `${url}:${line}` : url;
		}
	}

	function submit() {
		const trimmed = command.trim();
		if (!trimmed) return;

		history = [...history.filter((entry) => entry !== trimmed), trimmed].slice(-100);
		historyIndex = -1;
		command = '';
		autoScroll = true;
		resizePrompt();
		onExecute(trimmed);
	}

	/** Grow the prompt with its content, up to a third of the transcript. */
	function resizePrompt() {
		if (!promptElement) return;
		promptElement.style.height = 'auto';
		promptElement.style.height = `${Math.min(promptElement.scrollHeight, 160)}px`;
	}

	function handlePromptKeydown(event: KeyboardEvent) {
		// Shift+Enter inserts a newline; Enter runs. Multi-line entry is the whole
		// reason this is a textarea rather than an input.
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			submit();
			return;
		}

		const isMultiline = command.includes('\n');

		if (event.key === 'ArrowUp' && !isMultiline) {
			if (history.length === 0) return;
			event.preventDefault();
			if (historyIndex === -1) draftBeforeHistory = command;
			historyIndex = Math.min(historyIndex + 1, history.length - 1);
			command = history[history.length - 1 - historyIndex] ?? '';
			queueMicrotask(resizePrompt);
			return;
		}

		if (event.key === 'ArrowDown' && !isMultiline) {
			if (historyIndex === -1) return;
			event.preventDefault();
			historyIndex -= 1;
			command = historyIndex === -1 ? draftBeforeHistory : (history[history.length - 1 - historyIndex] ?? '');
			queueMicrotask(resizePrompt);
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			if (command) {
				command = '';
				queueMicrotask(resizePrompt);
			} else {
				onClose();
			}
		}
	}

	async function copyMessage(entry: BrowserConsoleMessage) {
		const text = entry.stackTrace ? `${entry.text}\n${entry.stackTrace}` : entry.text;
		try {
			await navigator.clipboard.writeText(text);
			addNotification({ type: 'success', title: 'Copied', message: 'Console message copied to clipboard' });
		} catch {
			addNotification({ type: 'error', title: 'Copy failed', message: 'Could not access the clipboard' });
		}
	}

	// Follow the tail only while the user is already at the bottom — yanking the
	// view down while they are reading an earlier error is the classic console
	// annoyance.
	$effect(() => {
		void visibleLogs.length;
		if (!autoScroll || !scrollContainer) return;
		queueMicrotask(() => {
			if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
		});
	});

	function handleScroll() {
		if (!scrollContainer) return;
		const distanceFromBottom =
			scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
		autoScroll = distanceFromBottom < 40;
	}

	// ── Resize handle ───────────────────────────────────────────────────────
	function startResize(event: PointerEvent) {
		if (isMobile) return;

		const isSide = dock === 'right';
		const start = isSide ? event.clientX : event.clientY;
		const startSize = isSide ? width : height;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);

		const move = (moveEvent: PointerEvent) => {
			// Both handles sit on the leading edge, so dragging toward the panel
			// centre grows the console — hence the inverted delta.
			const delta = start - (isSide ? moveEvent.clientX : moveEvent.clientY);
			if (isSide) {
				width = Math.max(260, Math.min(window.innerWidth * 0.7, startSize + delta));
			} else {
				height = Math.max(120, Math.min(window.innerHeight * 0.8, startSize + delta));
			}
		};
		const end = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', end);
		};

		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', end);
	}

	const sizeStyle = $derived(
		isMobile ? 'height: 55vh;' : dock === 'right' ? `width: ${width}px;` : `height: ${height}px;`
	);
</script>

<div
	class="relative flex min-h-0 min-w-0 shrink-0 flex-col bg-white dark:bg-slate-900
		{dock === 'right' && !isMobile
		? 'border-l border-slate-200 dark:border-slate-700'
		: 'border-t border-slate-200 dark:border-slate-700'}"
	style={sizeStyle}
>
	{#if !isMobile}
		<div
			class="shrink-0 bg-transparent transition-colors hover:bg-violet-500/30 {dock === 'right'
				? 'absolute inset-y-0 left-0 w-1.5 cursor-ew-resize'
				: 'h-1.5 cursor-ns-resize'}"
			role="separator"
			aria-label="Resize console"
			aria-orientation={dock === 'right' ? 'vertical' : 'horizontal'}
			onpointerdown={startResize}
		></div>
	{/if}

	<!-- Toolbar -->
	<div
		class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-200 px-1.5 py-1.5 dark:border-slate-700"
	>
		<div class="flex shrink-0 items-center gap-0.5 rounded-md bg-slate-100/80 p-0.5 dark:bg-slate-800/60">
			{#each levels as level (level.id)}
				{@const tally = level.id === 'all' ? 0 : counts[level.id]}
				<button
					type="button"
					class="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium transition-colors
						{levelFilter === level.id
						? 'bg-white text-violet-600 shadow-sm dark:bg-slate-700 dark:text-violet-300'
						: 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'}"
					onclick={() => (levelFilter = level.id)}
					title={level.label}
					aria-label={level.label}
					aria-pressed={levelFilter === level.id}
				>
					<Icon name={level.icon} class="h-3.5 w-3.5" />
					{#if tally > 0}
						<span
							class="rounded-full px-1 text-[10px] leading-4
								{level.id === 'error'
								? 'bg-red-500/15 text-red-600 dark:text-red-400'
								: level.id === 'warn'
									? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
									: 'bg-slate-500/15 text-slate-600 dark:text-slate-300'}"
						>
							{tally > 999 ? '999+' : tally}
						</span>
					{/if}
				</button>
			{/each}
		</div>

		<div class="relative min-w-20 flex-1">
			<Icon
				name="lucide:search"
				class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
			/>
			<input
				type="text"
				bind:value={searchTerm}
				placeholder="Filter"
				class="w-full rounded-md border border-slate-200 bg-transparent py-1 pl-7 pr-2 text-xs text-slate-700 placeholder:text-slate-400 focus:border-violet-500 focus:outline-none dark:border-slate-700 dark:text-slate-200"
			/>
		</div>

		{#if !isMobile}
			<button
				type="button"
				class="flex shrink-0 items-center justify-center rounded-md p-1.5 transition-colors
					{showTimestamps
					? 'bg-violet-500/10 text-violet-600 dark:text-violet-400'
					: 'text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200'}"
				onclick={() => (showTimestamps = !showTimestamps)}
				title="Show timestamps"
				aria-label="Show timestamps"
			>
				<Icon name="lucide:clock" class="h-3.5 w-3.5" />
			</button>
		{/if}

		{#if canSideDock}
			<button
				type="button"
				class="flex shrink-0 items-center justify-center rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
				onclick={() => (dock = dock === 'bottom' ? 'right' : 'bottom')}
				title={dock === 'bottom' ? 'Dock to the right' : 'Dock to the bottom'}
				aria-label={dock === 'bottom' ? 'Dock to the right' : 'Dock to the bottom'}
			>
				<Icon name={dock === 'bottom' ? 'lucide:panel-right' : 'lucide:panel-bottom'} class="h-3.5 w-3.5" />
			</button>
		{/if}

		<button
			type="button"
			class="flex shrink-0 items-center justify-center rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
			onclick={() => onClear()}
			title="Clear console"
			aria-label="Clear console"
		>
			<Icon name="lucide:ban" class="h-3.5 w-3.5" />
		</button>

		<button
			type="button"
			class="flex shrink-0 items-center justify-center rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
			onclick={() => onClose()}
			title="Close console"
			aria-label="Close console"
		>
			<Icon name="lucide:x" class="h-4 w-4" />
		</button>
	</div>

	<!-- Transcript: log stream with the prompt as its last line -->
	<div
		bind:this={scrollContainer}
		onscroll={handleScroll}
		class="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden font-mono text-[12px] leading-relaxed"
	>
		{#if visibleLogs.length === 0}
			<div class="flex flex-col items-center justify-center gap-2 px-6 py-8 text-center">
				<Icon name="lucide:terminal" class="h-8 w-8 text-slate-300 dark:text-slate-600" />
				<p class="font-sans text-xs text-slate-400 dark:text-slate-500">
					{logs.length === 0
						? 'Nothing logged yet — messages from the page appear here.'
						: 'No messages match this filter.'}
				</p>
			</div>
		{:else}
			{#each visibleLogs as entry (entry.id)}
				{@const icon = rowIcon(entry.type)}
				<div
					class="group flex items-start gap-2 px-2 py-1 {rowClass(entry.type)} hover:bg-slate-50 dark:hover:bg-slate-800/50"
				>
					<span class="flex w-4 shrink-0 justify-center pt-0.5">
						{#if icon}
							<Icon name={icon.name} class="h-3.5 w-3.5 {icon.class}" />
						{/if}
					</span>

					{#if showTimestamps}
						<span class="shrink-0 pt-0.5 text-[11px] tabular-nums text-slate-400">{formatTime(entry.timestamp)}</span>
					{/if}

					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-start gap-x-2 gap-y-0.5">
							{#if entry.count && entry.count > 1}
								<span
									class="shrink-0 rounded-full bg-slate-500/15 px-1.5 text-[10px] leading-4 text-slate-600 dark:text-slate-300"
									title="{entry.count} identical messages"
								>
									{entry.count > 999 ? '999+' : entry.count}
								</span>
							{/if}
							{#if entry.status}
								<span class="shrink-0 rounded bg-red-500/15 px-1.5 text-[10px] leading-4 text-red-600 dark:text-red-400">
									{entry.status}
								</span>
							{/if}

							{#if entry.values && entry.values.length > 0}
								{#each entry.values as value, index (index)}
									<ConsoleValue {value} bare />
								{/each}
							{:else}
								<span
									class="min-w-0 whitespace-pre-wrap break-all
										{entry.type === 'error'
										? 'text-red-700 dark:text-red-300'
										: entry.type === 'warn'
											? 'text-amber-700 dark:text-amber-300'
											: entry.type === 'input'
												? 'text-violet-700 dark:text-violet-300'
												: 'text-slate-700 dark:text-slate-200'}">{entry.text}</span
								>
							{/if}
						</div>

						{#if entry.location?.url}
							<span
								class="mt-0.5 block truncate text-[11px] text-slate-400"
								title={`${entry.location.url}:${entry.location.lineNumber}`}
							>
								{shortSource(entry.location.url, entry.location.lineNumber)}
							</span>
						{/if}

						{#if entry.stackTrace}
							<pre class="mt-0.5 whitespace-pre-wrap break-all text-[11px] text-slate-500 dark:text-slate-400">{entry.stackTrace}</pre>
						{/if}
					</div>

					<button
						type="button"
						class="shrink-0 rounded p-0.5 text-slate-400 transition-colors hover:bg-slate-200/60 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-slate-200"
						onclick={() => copyMessage(entry)}
						title="Copy message"
						aria-label="Copy message"
					>
						<Icon name="lucide:copy" class="h-3 w-3" />
					</button>
				</div>
			{/each}
		{/if}

		<!-- The prompt is part of the transcript, not a separate field. -->
		<div class="flex items-start gap-2 border-l-2 border-violet-500 bg-slate-50/60 px-2 py-1 dark:bg-slate-800/40">
			<span class="flex w-4 shrink-0 justify-center pt-0.5">
				<Icon name="lucide:chevron-right" class="h-3.5 w-3.5 text-violet-500" />
			</span>
			<textarea
				bind:this={promptElement}
				bind:value={command}
				oninput={resizePrompt}
				onkeydown={handlePromptKeydown}
				rows="1"
				placeholder="Run JavaScript in the page — Shift+Enter for a new line"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				class="min-w-0 flex-1 resize-none overflow-hidden break-all bg-transparent font-mono text-[12px] leading-relaxed text-slate-700 outline-none placeholder:font-sans placeholder:text-slate-400 dark:text-slate-200"
			></textarea>
			{#if command.trim()}
				<button
					type="button"
					class="mt-0.5 shrink-0 rounded-md bg-violet-500 px-2 py-0.5 text-[11px] font-medium text-white transition-colors hover:bg-violet-600"
					onclick={submit}
				>
					Run
				</button>
			{/if}
		</div>
	</div>
</div>
