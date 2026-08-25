<!--
	Ports — the confirmation before stopping a port, and what it reports back.

	Lives in one place because both entry points need it to say exactly the same
	things: what will actually happen, and the honest difference between
	releasing a port through the feature that opened it and signalling a process
	Clopen never started.
-->
<script lang="ts">
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import { portsStore } from '$frontend/stores/features/ports.svelte';
	import { showError, showSuccess } from '$frontend/stores/ui/notification.svelte';
	import type { PortEntry } from '$shared/types/ports';
	import { debug } from '$shared/utils/logger';

	interface Props {
		/** The row awaiting confirmation, cleared once the user decides. */
		entry: PortEntry | null;
	}

	let { entry = $bindable() }: Props = $props();

	const message = $derived(
		entry
			? entry.origin.ownerFeature
				? `${entry.origin.label} will be shut down properly through the feature that opened it.`
				: `Process ${entry.pid} (${entry.origin.label}) and anything it started will be asked to stop, then forced if it refuses.` +
					(entry.origin.confidence === 'guess'
						? ' Clopen did not start this process, so check the command before continuing.'
						: '')
			: ''
	);

	async function run(): Promise<void> {
		const target = entry;
		entry = null;
		if (!target) return;

		const outcome = await portsStore.kill(target);
		if (outcome.ok) {
			showSuccess('Port released', `Nothing is holding ${target.protocol}/${target.port} now.`);
			return;
		}
		debug.warn('ports', `could not stop ${target.key}:`, outcome.error);
		showError('Could not stop it', outcome.error ?? 'The host refused.');
	}
</script>

<Dialog
	isOpen={entry !== null}
	onClose={() => (entry = null)}
	type="warning"
	title="Stop this port?"
	{message}
	confirmText="Stop it"
	onConfirm={run}
/>
