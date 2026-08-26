<script lang="ts">
	import Markdown from '$frontend/components/common/display/Markdown.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';

	const { content }: { content: string } = $props();

	let isCopied = $state(false);

	async function handleCopy() {
		if (!content) return;
		try {
			await navigator.clipboard.writeText(content);
		} catch {
			// Fallback for older contexts
			const ta = document.createElement('textarea');
			ta.value = content;
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			document.body.appendChild(ta);
			ta.select();
			document.execCommand('copy');
			ta.remove();
		}
		isCopied = true;
		setTimeout(() => (isCopied = false), 1500);
	}
</script>

<div class="relative group/text">
	<Markdown variant="chat" html="escape" {content} class="wrap-break-word pr-8" />
	{#if content && content.trim().length > 0}
		<button
			type="button"
			onclick={handleCopy}
			class="absolute top-1 right-1 inline-flex items-center justify-center gap-1 p-1.5 rounded-md border bg-white/90 dark:bg-slate-800/90 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-white dark:hover:bg-slate-800 shadow-sm backdrop-blur-sm transition-all opacity-0 group-hover/text:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
			aria-label={isCopied ? 'Copied' : 'Copy message'}
			title={isCopied ? 'Copied!' : 'Copy'}
		>
			<Icon name={isCopied ? 'lucide:check' : 'lucide:copy'} class="w-3.5 h-3.5" />
			<span class="hidden sm:inline text-xs font-medium leading-none">{isCopied ? 'Copied' : 'Copy'}</span>
		</button>
	{/if}
</div>
