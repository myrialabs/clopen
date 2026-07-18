<script lang="ts">
	/**
	 * Shared full-panel loading state for the DB Client main views
	 * (Data / Structure / ERD) so every tab shows the same centered
	 * spinner instead of each rolling its own.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
</script>

<div class="flex-1 min-h-[220px] flex items-center justify-center text-slate-400 dark:text-slate-600">
	<Icon name="lucide:loader" class="w-6 h-6 animate-spin text-violet-500" />
</div>
