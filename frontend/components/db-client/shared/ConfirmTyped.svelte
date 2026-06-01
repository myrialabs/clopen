<script lang="ts">
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';

	interface Props {
		isOpen: boolean;
		title?: string;
		message?: string;
		/** The exact value the user must type to enable the confirm button. */
		expected: string;
		confirmText?: string;
		onConfirm: () => void;
		onClose: () => void;
	}

	let {
		isOpen = $bindable(),
		title = 'Confirm destructive action',
		message = 'This action cannot be undone.',
		expected,
		confirmText = 'Delete',
		onConfirm,
		onClose
	}: Props = $props();

	let typed = $state('');

	// Reset the typed value whenever the dialog (re)opens.
	$effect(() => {
		if (isOpen) typed = '';
	});

	const matches = $derived(typed === expected);

	function handleConfirm(): void {
		if (matches) onConfirm();
	}
</script>

<Dialog
	bind:isOpen
	{onClose}
	{title}
	type="error"
	message={`${message}\nType "${expected}" to confirm.`}
	bind:inputValue={typed}
	inputPlaceholder={expected}
	{confirmText}
	confirmDisabled={!matches}
	onConfirm={handleConfirm}
/>
