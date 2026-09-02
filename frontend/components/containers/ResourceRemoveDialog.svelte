<!--
	Containers — the confirmation before removing an image, a volume or a network.

	Each one is worth a different sentence. An image comes back with a pull or a
	build; a volume does not come back at all, and its contents are the reason
	anyone would be nervous here. Whether anything is currently using it decides
	the tone, because the runtime will refuse in that case and the dialog should
	say so before the user finds out from an error.
-->
<script lang="ts">
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import { containersStore } from '$frontend/stores/features/containers.svelte';
	import { showError, showSuccess } from '$frontend/stores/ui/notification.svelte';
	import type { RemovableResourceKind } from '$shared/types/containers';
	import { debug } from '$shared/utils/logger';

	export interface PendingRemoval {
		kind: RemovableResourceKind;
		/** What the command takes: an id for an image, a name for the rest. */
		id: string;
		label: string;
		usedBy: string[];
	}

	interface Props {
		/** The resource awaiting confirmation, cleared once the user decides. */
		pending: PendingRemoval | null;
	}

	let { pending = $bindable() }: Props = $props();

	const inUse = $derived((pending?.usedBy.length ?? 0) > 0);

	const title = $derived(
		pending?.kind === 'image'
			? 'Remove this image?'
			: pending?.kind === 'volume'
				? 'Remove this volume?'
				: 'Remove this network?'
	);

	const message = $derived.by(() => {
		if (!pending) return '';
		const used = `${pending.label} is in use by ${pending.usedBy.slice(0, 3).join(', ')}${
			pending.usedBy.length > 3 ? ` and ${pending.usedBy.length - 3} more` : ''
		}, so the runtime will refuse to remove it. Remove or stop those first.`;
		if (inUse) return used;

		switch (pending.kind) {
			case 'image':
				return `${pending.label} will be deleted from this host. Getting it back means pulling or building it again.`;
			case 'volume':
				// The one deletion here with no way back at all.
				return `${pending.label} and everything stored in it will be deleted. There is no undo, and nothing else on this host holds a copy.`;
			default:
				return `${pending.label} will be deleted. Any container later configured to use it will recreate it empty.`;
		}
	});

	async function run(): Promise<void> {
		const target = pending;
		pending = null;
		if (!target) return;

		const outcome = await containersStore.removeResource(target.kind, target.id);
		if (outcome.ok) {
			showSuccess('Removed', `${target.label} is gone.`);
			return;
		}
		debug.warn('containers', `could not remove ${target.kind} ${target.id}:`, outcome.error);
		showError('Could not remove it', outcome.error ?? 'The host refused.');
	}
</script>

<Dialog
	isOpen={pending !== null}
	onClose={() => (pending = null)}
	type={inUse ? 'info' : 'warning'}
	{title}
	{message}
	confirmText="Remove it"
	confirmDisabled={inUse}
	onConfirm={run}
/>
