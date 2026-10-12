<!--
	The "finish signing in in your browser" step of an engine OAuth login.

	Flows that run a loopback callback server (Pi, Cline) also accept the final
	redirect URL pasted by hand, raced against the callback. That paste is only
	needed when the browser cannot reach the server's 127.0.0.1 — Clopen opened
	from another machine — so on a local connection it stays folded away and the
	step reads as "waiting" rather than asking for input it will never need.
	A paste the flow cannot finish without (no callback listening, or a provider
	that shows a code to copy) is asked for directly.
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { isLocalConnection } from '$frontend/utils/platform';

	interface Props {
		url: string;
		/** The flow's own guidance, shown when the paste is required. */
		instructions?: string | null;
		/** The pending manual-paste prompt, or null while none is open. */
		fallback: { message: string; placeholder?: string; optional?: boolean } | null;
		onSubmitFallback: (value: string) => void;
		onCancel: () => void;
	}

	const { url, instructions = null, fallback, onSubmitFallback, onCancel }: Props = $props();

	const required = $derived(fallback !== null && !fallback.optional);
	let expanded = $state(!isLocalConnection());
	const showFallback = $derived(required || expanded);
	let fallbackValue = $state('');
	let copied = $state(false);

	async function copyUrl() {
		try {
			await navigator.clipboard.writeText(url);
			copied = true;
			setTimeout(() => { copied = false; }, 2000);
		} catch {
			/* clipboard unavailable — the link is still clickable */
		}
	}

	function submitFallback() {
		const value = fallbackValue.trim();
		if (!value) return;
		onSubmitFallback(value);
		fallbackValue = '';
	}
</script>

<div class="space-y-3">
	<div class="space-y-2">
		<p class="text-xs text-slate-600 dark:text-slate-400">
			{required ? (instructions ?? fallback?.message) : 'Sign in on the provider\'s page. This step completes on its own.'}
		</p>
		<div class="flex gap-2">
			<a
				href={url}
				target="_blank"
				rel="noopener noreferrer"
				class="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-violet-600 text-white hover:bg-violet-700 transition-colors"
			>
				<Icon name="lucide:external-link" class="w-3 h-3" />
				Open sign-in page
			</a>
			<button
				type="button"
				class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors
					{copied
					? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
					: 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'}"
				onclick={copyUrl}
			>
				<Icon name={copied ? 'lucide:check' : 'lucide:copy'} class="w-3 h-3" />
				{copied ? 'Copied' : 'Copy link'}
			</button>
		</div>
	</div>

	{#if !required}
		<div class="flex items-center gap-2 text-sm text-slate-500">
			<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
			<span>Waiting for sign-in to finish…</span>
		</div>
	{/if}

	{#if fallback}
		{#if showFallback}
			<div class="space-y-2 {required ? '' : 'pt-2 border-t border-slate-200 dark:border-slate-700/50'}">
				{#if !required}
					<p class="text-xs text-slate-600 dark:text-slate-400">
						If the browser ends on a page that won't load, copy that page's address and paste it here.
					</p>
				{/if}
				<input
					type="text"
					bind:value={fallbackValue}
					placeholder={fallback.placeholder ?? ''}
					onkeydown={(e) => { if (e.key === 'Enter') submitFallback(); }}
					class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
				/>
				<button
					type="button"
					class="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					onclick={submitFallback}
					disabled={!fallbackValue.trim()}
				>
					<Icon name="lucide:arrow-right" class="w-4 h-4" />
					Continue
				</button>
			</div>
		{:else}
			<button
				type="button"
				class="text-xs text-violet-600 dark:text-violet-400 hover:underline"
				onclick={() => { expanded = true; }}
			>
				Browser didn't come back here?
			</button>
		{/if}
	{/if}

	<button
		type="button"
		class="w-full px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
		onclick={onCancel}
	>
		Cancel
	</button>
</div>
