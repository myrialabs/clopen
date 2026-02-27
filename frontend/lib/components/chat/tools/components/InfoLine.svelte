<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		icon: IconName;
		text: string;
		iconColor?: string;
		textColor?: string;
		title?: string;
	}

	const { icon, text, iconColor = 'text-slate-500', textColor = 'text-slate-600 dark:text-slate-400', title="" }: Props = $props();
</script>

<div class="flex items-center gap-1.5" {title}>
	<Icon name={icon} class="{iconColor} w-3.5 h-3.5" />
	<span class="text-xs {textColor}">{text}</span>
</div>