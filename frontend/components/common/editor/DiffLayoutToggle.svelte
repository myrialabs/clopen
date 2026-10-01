<script lang="ts">
	/** Side by side or inline — the icon shows the layout on screen, the hint the other one. */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { HEADER_BUTTON, HEADER_ICON } from './header-styles';

	interface Props {
		sideBySide: boolean;
		onToggle: () => void;
	}

	const { sideBySide, onToggle }: Props = $props();
</script>

<button
	type="button"
	class={HEADER_BUTTON}
	onclick={onToggle}
	title={sideBySide ? 'Switch to inline' : 'Switch to side by side'}
	aria-label={sideBySide ? 'Switch to inline' : 'Switch to side by side'}
>
	<Icon name={sideBySide ? 'lucide:columns-2' : 'lucide:rows-2'} class={HEADER_ICON} />
</button>
