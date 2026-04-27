<script lang="ts">
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';

	interface Props {
		isOpen: boolean;
		title?: string;
		message?: string;
		confirmText?: string;
		onConfirm: () => void;
		onClose: () => void;
	}

	let {
		isOpen = $bindable(),
		title = 'Confirm destructive action',
		message = 'This action cannot be undone. Continue?',
		confirmText = 'Run',
		onConfirm,
		onClose
	}: Props = $props();
</script>

<Dialog
	bind:isOpen
	{onClose}
	{title}
	{message}
	{confirmText}
	type="warning"
	cancelText="Cancel"
	{onConfirm}
/>
