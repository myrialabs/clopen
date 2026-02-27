<script lang="ts">
	import Alert from './Alert.svelte';
	import Dialog from './Dialog.svelte';
	import { dialogStore, closeAlert, closeConfirm } from '$frontend/lib/stores/ui/dialog.svelte';

	const alertState = $derived(dialogStore.alert);
	const confirmState = $derived(dialogStore.confirm);
</script>

<Alert
	isOpen={alertState.isOpen}
	title={alertState.options.title}
	message={alertState.options.message}
	type={alertState.options.type}
	onClose={closeAlert}
/>

<Dialog
	isOpen={confirmState.isOpen}
	title={confirmState.options.title}
	message={confirmState.options.message}
	type={confirmState.options.type}
	confirmText={confirmState.options.confirmText}
	cancelText={confirmState.options.cancelText}
	showCancel={true}
	onConfirm={() => closeConfirm(true)}
	onClose={() => closeConfirm(false)}
/>