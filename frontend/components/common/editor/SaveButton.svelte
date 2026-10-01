<script lang="ts">
	/** Save in an editor header — the same look, states and hint on every surface. */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { isMac } from '$frontend/utils/platform';
	import { HEADER_ICON } from './header-styles';

	interface Props {
		/** There are edits to save. */
		dirty: boolean;
		saving: boolean;
		onSave: () => void;
	}

	const { dirty, saving, onSave }: Props = $props();

	const hint = isMac() ? '⌘S' : 'Ctrl+S';
</script>

<button
	type="button"
	class="flex p-2 text-green-600 dark:text-green-400 hover:text-green-700 dark:hover:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/30 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
	onclick={onSave}
	disabled={!dirty || saving}
	title={saving ? 'Saving…' : dirty ? `Save (${hint})` : 'No changes to save'}
	aria-label="Save"
>
	{#if saving}
		<div class="{HEADER_ICON} border-2 border-green-600 border-t-transparent rounded-full animate-spin"></div>
	{:else}
		<Icon name="lucide:save" class={HEADER_ICON} />
	{/if}
</button>
