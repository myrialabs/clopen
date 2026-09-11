<script lang="ts">
	/**
	 * A provider's brand mark, or a glyph when it has none.
	 *
	 * The marks are real vendor SVGs with a light and a dark variant, keyed by
	 * provider id — a monochrome glyph tinted with the theme foreground stops
	 * being a logo, which is why this is `{@html}` and not the icon font.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { getProviderIcon } from '$shared/constants/tool-icons';
	import { isDarkMode } from '$frontend/stores/ui/theme.svelte';

	interface Props {
		provider: string;
		size?: string;
	}

	const { provider, size = 'w-4 h-4' }: Props = $props();

	const mark = $derived.by(() => {
		const icon = getProviderIcon(provider);
		if (!icon) return null;
		return isDarkMode() ? icon.dark : icon.light;
	});
</script>

{#if mark}
	<span class="inline-flex items-center justify-center shrink-0 [&>svg]:w-full [&>svg]:h-full {size}">
		{@html mark}
	</span>
{:else}
	<Icon name="lucide:git-branch" class="{size} shrink-0 text-slate-500 dark:text-slate-400" />
{/if}
