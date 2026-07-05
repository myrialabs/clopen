<script lang="ts">
	import Markdown from '$frontend/components/common/display/Markdown.svelte';

	const { content }: { content: string } = $props();
</script>

<Markdown variant="chat" html="escape" terminalFallback {content} class="wrap-break-word" />
