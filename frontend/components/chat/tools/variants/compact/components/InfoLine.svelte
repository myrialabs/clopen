<script lang="ts">
	interface Props {
		text: string;
		textColor?: string;
		title?: string;
	}

	const { text, textColor = 'text-slate-500 dark:text-slate-400', title = '' }: Props = $props();
</script>

<div class="flex items-center" {title}>
	<span class="text-xs {textColor}">{text}</span>
</div>
