<script lang="ts">
	/**
	 * Build output, live or finished.
	 *
	 * One component for both because they are the same text arriving two ways,
	 * and the reader should not have to learn two views. A running build streams
	 * and follows the tail; a finished one is fetched as the same budgeted bundle
	 * the chat prompt is built from — which is the point of showing it here at
	 * all: what you read is exactly what the agent would receive.
	 *
	 * ANSI is rendered with the app's own `processAnsiCodes`, the same path chat
	 * tool output takes, so a build log looks like every other piece of terminal
	 * output in Clopen. Deliberately NOT a PtyKit terminal: that is an
	 * interactive emulator with a keyboard, a cursor and a resize protocol, and
	 * this is read-only text — the emulator would cost more than the colour is
	 * worth and behave unlike the rest of the app's static output.
	 *
	 * Trailing blank lines are trimmed. The provider ends its stream with a few,
	 * and each streamed chunk appends its own newline, so the view accumulated
	 * empty space that looked like deliberate padding below the last line.
	 *
	 * The tail-follow releases as soon as the reader scrolls up. Yanking someone
	 * back to the bottom while they read an error six hundred lines up is the
	 * single most irritating thing a log view can do.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { copyText } from '$frontend/utils/clipboard';
	import { showInfo } from '$frontend/stores/ui/notification.svelte';
	import { processAnsiCodes } from '$frontend/utils/terminal-formatter';

	interface Props {
		text: string;
		isLoading: boolean;
		isStreaming: boolean;
		truncated?: boolean;
		/** Stage the provider reports, shown while a build is running. */
		phase?: string | null;
	}

	const { text, isLoading, isStreaming, truncated = false, phase = null }: Props = $props();

	let viewport = $state<HTMLElement | null>(null);
	let stickToBottom = $state(true);

	const trimmed = $derived(text.replace(/\s+$/, ''));
	// `processAnsiCodes` escapes HTML itself before substituting its spans, so
	// the provider's text cannot inject markup through this.
	const rendered = $derived(trimmed ? processAnsiCodes(trimmed) : '');

	function onScroll() {
		if (!viewport) return;
		// A small slack, because a scroll that lands a pixel short of the bottom
		// is still someone sitting at the bottom.
		stickToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 40;
	}

	$effect(() => {
		void trimmed;
		if (!viewport || !stickToBottom) return;
		viewport.scrollTop = viewport.scrollHeight;
	});

	async function copy() {
		const ok = await copyText(trimmed);
		showInfo(ok ? 'Copied' : 'Could not copy', ok ? 'Build log copied.' : 'The clipboard refused the request.');
	}
</script>

<div class="flex flex-col min-h-0 flex-1">
	<div class="flex items-center gap-2 px-4 py-1.5 shrink-0 border-b border-slate-200 dark:border-slate-800">
		<span class="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-600">Build log</span>

		{#if isStreaming}
			<!--
				The stage, not just a "live" dot. A build spends long stretches
				printing nothing — uploading, provisioning, assigning domains — and
				during those a bare dot cannot be told apart from a stall.
			-->
			<span class="inline-flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
				<span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
				{phase ?? 'live'}
			</span>
		{/if}
		{#if truncated}
			<span class="text-[11px] text-slate-400 dark:text-slate-600" title="Earlier output was dropped to fit">
				tail only
			</span>
		{/if}

		{#if trimmed}
			<button
				type="button"
				class="flex items-center justify-center w-6 h-6 ml-auto shrink-0 bg-transparent border-none rounded text-slate-400 dark:text-slate-500 cursor-pointer hover:text-slate-700 dark:hover:text-slate-200"
				onclick={copy}
				aria-label="Copy the build log"
				title="Copy"
			>
				<Icon name="lucide:copy" class="w-3.5 h-3.5" />
			</button>
		{/if}
	</div>

	<div bind:this={viewport} onscroll={onScroll} class="flex-1 min-h-0 overflow-auto px-4 py-2.5">
		{#if isLoading && !trimmed}
			<p class="flex items-center gap-2 m-0 text-xs text-slate-500 dark:text-slate-500">
				<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
				Reading the build log…
			</p>
		{:else if !trimmed}
			<p class="m-0 text-xs text-slate-500 dark:text-slate-500">
				No build output is stored for this deployment.
			</p>
		{:else}
			<pre class="m-0 font-mono text-xs leading-relaxed text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-words">{@html rendered}</pre>
		{/if}
	</div>
</div>
