<script lang="ts">
	/**
	 * The pull request's diff.
	 *
	 * Everything about reading a set of changes lives in `DiffBrowser`, which a
	 * commit's file list uses too — the two views differ only in where the files
	 * came from, and duplicating a tree and a diff editor to express that was
	 * how the surface ended up with a diff renderer of its own.
	 */
	import DiffBrowser from './DiffBrowser.svelte';
	import { workStore } from '$frontend/stores/features/work.svelte';

	const files = $derived(workStore.files);
</script>

<DiffBrowser {files} />
