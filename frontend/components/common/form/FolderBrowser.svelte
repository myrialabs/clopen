<script lang="ts">
	// Project-folder preset of PathBrowser: folder selection with recent/active
	// project badges. Everything else lives in PathBrowser so other pickers
	// (files, plain folders) share the same browser.
	import PathBrowser from './PathBrowser.svelte';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
		onSelect: (folderPath: string, folderName: string) => void;
		currentProjectPath?: string;
		title?: string;
		confirmText?: string;
		initialPath?: string;
	}

	let {
		isOpen = $bindable(),
		onClose,
		onSelect,
		currentProjectPath,
		title = 'Select Project Folder',
		confirmText = 'Select Project',
		initialPath
	}: Props = $props();
</script>

<PathBrowser
	bind:isOpen
	{onClose}
	{onSelect}
	{currentProjectPath}
	{title}
	{confirmText}
	{initialPath}
	mode="directory"
	showProjectHints
/>
