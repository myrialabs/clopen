<!--
	ssh-client — what is running on this host.

	The same pane the Containers tool shows for the local machine, scoped to the
	host the SSH Client is already on. Nothing is reimplemented here: the store,
	the listing, the detail pane, the log stream and the container shell are all
	shared, and this only supplies the host id.
-->
<script lang="ts">
	import ContainersPane from '$frontend/components/containers/ContainersPane.svelte';

	interface Props {
		connectionId: string;
	}

	const { connectionId }: Props = $props();
</script>

<div
	class="flex flex-col flex-1 min-h-0 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden"
>
	<ContainersPane hostId={connectionId} />
</div>
