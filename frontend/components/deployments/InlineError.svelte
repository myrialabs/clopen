<script lang="ts">
	/**
	 * A failure shown where it happened, with its link intact.
	 *
	 * Provider errors often end in "fix it at <url>", and a toast takes that away
	 * a few seconds later — before it can be read, and long before it can be
	 * clicked. So anything a user has to ACT on is rendered in the surface that
	 * caused it, and stays until they dismiss it.
	 *
	 * The URL is split out of the text rather than rendered with `{@html}`: the
	 * message comes from a third party, and no third-party string gets to inject
	 * markup here.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';

	interface Props {
		message: string;
		onDismiss?: () => void;
	}

	const { message, onDismiss }: Props = $props();

	/** The message as alternating text and link pieces. */
	const parts = $derived.by(() => {
		const pieces: { text: string; href: string | null }[] = [];
		const pattern = /https?:\/\/[^\s)]+/g;
		let index = 0;

		for (const match of message.matchAll(pattern)) {
			const at = match.index ?? 0;
			if (at > index) pieces.push({ text: message.slice(index, at), href: null });
			// Trailing punctuation belongs to the sentence, not to the URL.
			const url = match[0].replace(/[.,;:]+$/, '');
			pieces.push({ text: url, href: url });
			index = at + match[0].length;
			if (match[0].length > url.length) {
				pieces.push({ text: match[0].slice(url.length), href: null });
			}
		}
		if (index < message.length) pieces.push({ text: message.slice(index), href: null });
		return pieces;
	});
</script>

<div class="flex items-start gap-2 px-3 py-2.5 bg-rose-500/10 rounded-lg">
	<Icon name="lucide:circle-alert" class="w-3.5 h-3.5 shrink-0 mt-0.5 text-rose-600 dark:text-rose-400" />
	<p class="flex-1 m-0 text-xs text-rose-800 dark:text-rose-300 leading-relaxed wrap-anywhere">
		{#each parts as part, index (index)}
			{#if part.href}
				<a
					href={part.href}
					target="_blank"
					rel="noopener noreferrer"
					class="underline underline-offset-2 font-medium hover:text-rose-900 dark:hover:text-rose-200"
				>
					{part.text}
				</a>
			{:else}
				{part.text}
			{/if}
		{/each}
	</p>
	{#if onDismiss}
		<button
			type="button"
			class="flex items-center justify-center w-5 h-5 shrink-0 bg-transparent border-none rounded text-rose-500 cursor-pointer hover:text-rose-800 dark:hover:text-rose-200"
			onclick={onDismiss}
			aria-label="Dismiss"
		>
			<Icon name="lucide:x" class="w-3 h-3" />
		</button>
	{/if}
</div>
