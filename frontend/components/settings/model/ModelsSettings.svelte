<script lang="ts">
	/**
	 * Settings → Models: every job a model does, one row each, from the one
	 * list in `purposes.svelte.ts`. A job nothing was picked for uses the free
	 * model.
	 */
	import { onMount } from 'svelte';
	import { memoryGraphStore } from '$frontend/stores/features/memory-graph.svelte';
	import { MODEL_PURPOSES } from './purposes.svelte';
	import ModelPurposeRow from './ModelPurposeRow.svelte';

	onMount(() => {
		void memoryGraphStore.fetchConfig();
	});
</script>

<div class="space-y-2">
	{#each MODEL_PURPOSES as purpose (purpose.id)}
		<ModelPurposeRow purpose={purpose.id} />
	{/each}
</div>
