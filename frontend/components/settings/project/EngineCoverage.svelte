<script lang="ts">
	import { ENGINES } from '$shared/constants/engines';
	import type { CoverageMap } from '$frontend/stores/features/project-artifacts.svelte';

	interface Props {
		coverage: CoverageMap;
	}

	const { coverage }: Props = $props();

	// Whether the engine gets it natively or through Clopen is an implementation
	// detail; what matters to the user is WHERE it works. Coverage is keyed by
	// the engine's config-dir slug; only Claude differs from its EngineType.
	const reached = $derived(
		ENGINES.filter(engine => {
			const status = coverage[engine.type === 'claude-code' ? 'claude' : engine.type];
			return status === 'native' || status === 'bridged';
		})
	);
	const label = $derived(
		reached.length === 0 ? 'Not used' : reached.length === 1 ? reached[0].name : `${reached.length} of ${ENGINES.length} engines`
	);
	const title = $derived(reached.length > 1 ? reached.map(e => e.name).join(', ') : undefined);
</script>

<!-- A status label, not a control. Shown only when something does NOT work
     everywhere — "works in every engine" is the expected case, not news. -->
{#if reached.length < ENGINES.length}
	<span {title} class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium select-none bg-slate-100 dark:bg-slate-800 {reached.length === 0 ? 'text-slate-400' : 'text-slate-500 dark:text-slate-400'}">
		{label}
	</span>
{/if}
