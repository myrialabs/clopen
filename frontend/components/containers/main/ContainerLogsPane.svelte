<!--
	Containers — following one container's output.

	Plain text rather than a terminal, on purpose: this is something to read,
	search and copy out of, and an xterm is none of those. Following means
	sticking to the bottom, and it stops the moment the reader scrolls up — an
	auto-scroll that fights the person reading is worse than none.

	The buffer is bounded on both ends. The server keeps the last N lines and so
	does this, so a container writing continuously cannot grow either side.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { containersStore } from '$frontend/stores/features/containers.svelte';
	import { showSuccess } from '$frontend/stores/ui/notification.svelte';

	interface Props {
		onBack: () => void;
	}

	const { onBack }: Props = $props();

	let viewport = $state<HTMLDivElement | null>(null);
	let filter = $state('');
	/** Whether the view is stuck to the bottom, decided by where the reader is. */
	let following = $state(true);

	const logs = $derived(containersStore.logs);
	const lines = $derived(logs?.lines ?? []);
	const needle = $derived(filter.trim().toLowerCase());
	const visible = $derived(
		needle ? lines.filter((line) => line.toLowerCase().includes(needle)) : lines
	);

	/** Level colouring, from the shapes almost every logger prints. */
	function levelClass(line: string): string {
		if (/\b(error|err|fatal|panic|exception)\b/i.test(line)) return 'text-red-600 dark:text-red-400';
		if (/\bwarn(ing)?\b/i.test(line)) return 'text-amber-600 dark:text-amber-400';
		if (/\b(debug|trace)\b/i.test(line)) return 'text-slate-400 dark:text-slate-600';
		return 'text-slate-700 dark:text-slate-300';
	}

	function onScroll(): void {
		if (!viewport) return;
		const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
		// A small tolerance: a browser's fractional scroll heights would otherwise
		// unstick the view on its own the first time anything is appended.
		following = distance < 24;
	}

	// Re-runs whenever a chunk arrives, because it reads `visible.length`.
	$effect(() => {
		const count = visible.length;
		if (!following || logs?.paused || count === 0) return;
		void tick().then(() => {
			if (viewport) viewport.scrollTop = viewport.scrollHeight;
		});
	});

	async function copyAll(): Promise<void> {
		await navigator.clipboard.writeText(visible.join('\n'));
		showSuccess('Copied', `${visible.length} lines copied to the clipboard.`);
	}
</script>

<div class="flex flex-col flex-1 min-h-0">
	<header
		class="flex items-center gap-2 px-2.5 sm:px-3 py-2 shrink-0 border-b border-slate-200 dark:border-slate-800"
	>
		<button
			type="button"
			class="flex items-center gap-1.5 shrink-0 px-2 h-8 rounded-lg bg-transparent border-none text-slate-500 dark:text-slate-400 text-xs cursor-pointer hover:bg-violet-500/10"
			onclick={onBack}
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			<span class="hidden sm:inline">Back</span>
		</button>

		<div class="flex flex-col min-w-0 flex-1">
			<span class="truncate text-sm font-semibold text-slate-800 dark:text-slate-200">
				{logs?.containerName ?? 'Logs'}
			</span>
			<span class="text-[11px] text-slate-400 dark:text-slate-600">
				{#if logs?.starting}
					opening the stream…
				{:else if logs?.ended}
					stream ended
				{:else if logs?.paused}
					paused · still buffering on the server
				{:else}
					following
				{/if}
			</span>
		</div>

		<div
			class="hidden sm:flex items-center gap-2 min-w-0 max-w-56 px-2.5 h-8 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"
		>
			<Icon name="lucide:search" class="w-3.5 h-3.5 shrink-0 text-slate-400" />
			<input
				type="text"
				class="flex-1 min-w-0 bg-transparent border-none outline-none text-xs text-slate-800 dark:text-slate-200 placeholder:text-slate-400"
				placeholder="Filter these lines…"
				bind:value={filter}
			/>
		</div>

		<button
			type="button"
			class="flex items-center justify-center w-8 h-8 shrink-0 rounded-lg bg-transparent border-none text-slate-500 cursor-pointer hover:bg-violet-500/10"
			onclick={() => containersStore.togglePause()}
			title={logs?.paused ? 'Resume following' : 'Pause following'}
			aria-label={logs?.paused ? 'Resume following' : 'Pause following'}
		>
			<Icon name={logs?.paused ? 'lucide:play' : 'lucide:pause'} class="w-4 h-4" />
		</button>
		<button
			type="button"
			class="flex items-center justify-center w-8 h-8 shrink-0 rounded-lg bg-transparent border-none text-slate-500 cursor-pointer hover:bg-violet-500/10"
			onclick={copyAll}
			title="Copy what is on screen"
			aria-label="Copy log"
		>
			<Icon name="lucide:copy" class="w-4 h-4" />
		</button>
		<button
			type="button"
			class="flex items-center justify-center w-8 h-8 shrink-0 rounded-lg bg-transparent border-none text-slate-500 cursor-pointer hover:bg-violet-500/10"
			onclick={() => containersStore.clearLogs()}
			title="Clear the view"
			aria-label="Clear the view"
		>
			<Icon name="lucide:eraser" class="w-4 h-4" />
		</button>
	</header>

	<!-- The filter has nowhere to sit in the header on a phone, so it gets its
	     own row rather than being dropped. -->
	<div class="sm:hidden flex items-center gap-2 px-2.5 py-2 shrink-0 border-b border-slate-200 dark:border-slate-800">
		<div
			class="flex items-center gap-2 flex-1 min-w-0 px-2.5 h-8 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"
		>
			<Icon name="lucide:search" class="w-3.5 h-3.5 shrink-0 text-slate-400" />
			<input
				type="text"
				class="flex-1 min-w-0 bg-transparent border-none outline-none text-xs text-slate-800 dark:text-slate-200 placeholder:text-slate-400"
				placeholder="Filter these lines…"
				bind:value={filter}
			/>
		</div>
	</div>

	{#if logs?.error}
		<div class="flex items-start gap-2.5 m-3 p-3 rounded-lg bg-red-500/10 text-red-700 dark:text-red-400">
			<Icon name="lucide:circle-alert" class="w-4 h-4 shrink-0 mt-0.5" />
			<p class="m-0 text-xs">{logs.error}</p>
		</div>
	{/if}

	<div
		bind:this={viewport}
		onscroll={onScroll}
		class="flex-1 min-h-0 overflow-auto bg-slate-50 dark:bg-slate-950 px-3 py-2 font-mono text-[11px] leading-relaxed"
	>
		{#if logs?.starting}
			<p class="m-0 text-slate-400">Opening the stream…</p>
		{:else if visible.length === 0}
			<p class="m-0 text-slate-400">
				{needle ? 'No line matches that filter.' : 'This container has written nothing yet.'}
			</p>
		{:else}
			{#each visible as line, index (index)}
				<div class="whitespace-pre-wrap wrap-anywhere {levelClass(line)}">{line || ' '}</div>
			{/each}
		{/if}

		{#if logs?.ended}
			<p class="m-0 mt-2 text-slate-400 dark:text-slate-600">— {logs.ended}</p>
		{/if}
	</div>

	{#if !following}
		<!-- Scrolling up stops the view following; this is how to get back, and
		     it only exists while it is needed. -->
		<button
			type="button"
			class="flex items-center justify-center gap-1.5 shrink-0 py-1.5 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-[11px] text-violet-600 dark:text-violet-400 cursor-pointer"
			onclick={() => {
				following = true;
				if (viewport) viewport.scrollTop = viewport.scrollHeight;
			}}
		>
			<Icon name="lucide:arrow-down" class="w-3.5 h-3.5" />
			Follow the newest output
		</button>
	{/if}
</div>
