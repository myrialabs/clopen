<script lang="ts">
	import Markdown from '$frontend/components/common/display/Markdown.svelte';
	import { onMount, tick } from 'svelte';

	interface Props {
		content: string;
		initialScrollPercent?: number;
		onScrollPercent?: (percent: number) => void;
		onFileLink?: (href: string) => void;
	}

	const { content, initialScrollPercent = 0, onScrollPercent, onFileLink }: Props = $props();

	let container: HTMLDivElement | null = $state(null);
	let suppressScrollReport = false;

	function applyScrollPercent(percent: number) {
		if (!container) return;
		const max = container.scrollHeight - container.clientHeight;
		if (max <= 0) return;
		suppressScrollReport = true;
		container.scrollTop = Math.max(0, Math.min(1, percent)) * max;
		requestAnimationFrame(() => {
			suppressScrollReport = false;
		});
	}

	onMount(() => {
		(async () => {
			await tick();
			requestAnimationFrame(() => {
				requestAnimationFrame(() => applyScrollPercent(initialScrollPercent));
			});
		})();
	});

	function handleScroll(e: Event) {
		if (suppressScrollReport) return;
		const el = e.currentTarget as HTMLDivElement;
		const max = el.scrollHeight - el.clientHeight;
		if (max <= 0) return;
		onScrollPercent?.(Math.max(0, Math.min(1, el.scrollTop / max)));
	}

	export function getScrollPercent(): number {
		if (!container) return 0;
		const max = container.scrollHeight - container.clientHeight;
		if (max <= 0) return 0;
		return Math.max(0, Math.min(1, container.scrollTop / max));
	}
</script>

<div bind:this={container} class="h-full overflow-auto px-6 py-5" onscroll={handleScroll}>
	<Markdown variant="preview" {content} {onFileLink} />
</div>
