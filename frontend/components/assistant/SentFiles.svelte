<script lang="ts">
	/**
	 * Files an agent sent the owner with Clopen's `send` tool, shown in the chat
	 * where it was sent — images inline, anything else as a download.
	 */
	import AssistantFile from './AssistantFile.svelte';

	interface Props {
		/** The tool result: text, then the JSON report on the next line. */
		content: unknown;
	}

	const { content }: Props = $props();

	type SharedFile = { id: string; filename: string; mime: string; size: number; url: string };

	const files = $derived.by((): SharedFile[] => {
		const text = typeof content === 'string'
			? content
			: Array.isArray(content)
				? content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join('\n')
				: '';
		const json = text.slice(text.indexOf('\n') + 1);
		try {
			const parsed = JSON.parse(json) as { files?: SharedFile[] };
			return Array.isArray(parsed.files) ? parsed.files.filter((file) => typeof file?.url === 'string') : [];
		} catch {
			return [];
		}
	});
</script>

{#if files.length}
	<div class="mt-1.5 flex flex-wrap gap-2">
		{#each files as file (file.id)}
			<AssistantFile {file} />
		{/each}
	</div>
{/if}
