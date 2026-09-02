<!--
	Containers — the confirmation before stopping or restarting one.

	Lives in one place because both entry points need it to say exactly the same
	thing: what goes down, and for whom. Starting, pausing and resuming need no
	confirmation — nothing is lost by any of them — so only the three that take
	something away come through here.
-->
<script lang="ts">
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import { containersStore } from '$frontend/stores/features/containers.svelte';
	import { showError, showSuccess } from '$frontend/stores/ui/notification.svelte';
	import type { ContainerAction, ContainerEntry } from '$shared/types/containers';
	import { debug } from '$shared/utils/logger';

	interface Props {
		/** The container and action awaiting confirmation, cleared once decided. */
		pending: { entry: ContainerEntry; action: ContainerAction } | null;
	}

	let { pending = $bindable() }: Props = $props();

	const title = $derived(
		pending?.action === 'restart'
			? 'Restart this container?'
			: pending?.action === 'remove' || pending?.action === 'force-remove'
				? 'Remove this container?'
				: 'Stop this container?'
	);

	const message = $derived.by(() => {
		if (!pending) return '';
		const name = pending.entry.name;
		switch (pending.action) {
			case 'restart':
				return `${name} will be stopped and started again. Anything it serves is unavailable while it comes back.`;
			case 'remove':
				return `${name} will be deleted. Its image and its volumes stay, so an identical container can be created again — anything written inside the container itself and not into a volume is lost.`;
			case 'force-remove':
				// Worth its own sentence: this one stops a running container first.
				return `${name} is still running. It will be stopped and then deleted, taking down whatever it serves for everyone. Its volumes are kept.`;
			default:
				return `${name} will be asked to stop. Anything it serves — for every member, not just you — goes down with it.`;
		}
	});

	const confirmText = $derived(
		pending?.action === 'restart'
			? 'Restart it'
			: pending?.action === 'remove' || pending?.action === 'force-remove'
				? 'Remove it'
				: 'Stop it'
	);

	async function run(): Promise<void> {
		const target = pending;
		pending = null;
		if (!target) return;

		const outcome = await containersStore.act(target.entry, target.action);
		if (outcome.ok) {
			const what =
				target.action === 'restart'
					? 'is coming back up'
					: target.action === 'remove' || target.action === 'force-remove'
						? 'has been removed'
						: 'has been stopped';
			showSuccess('Done', `${target.entry.name} ${what}.`);
			return;
		}
		debug.warn('containers', `could not ${target.action} ${target.entry.name}:`, outcome.error);
		showError('Could not do that', outcome.error ?? 'The host refused.');
	}
</script>

<Dialog
	isOpen={pending !== null}
	onClose={() => (pending = null)}
	type="warning"
	{title}
	{message}
	{confirmText}
	onConfirm={run}
/>
