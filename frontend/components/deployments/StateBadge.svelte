<script lang="ts">
	/**
	 * A deployment's state, as a glyph and a colour.
	 *
	 * Reads the NORMALISED state, never the provider's own word. The native word
	 * is shown beside it as text so nothing is hidden, but colour and icon are
	 * decided from the five states this surface knows — which is what lets a
	 * provider with nine build states render here without a change.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { DeploymentState } from '$shared/types/deployments';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		state: DeploymentState;
		/** The provider's own word, shown when there is room for it. */
		detail?: string;
		compact?: boolean;
	}

	const { state, detail = '', compact = false }: Props = $props();

	const LOOK: Record<DeploymentState, { icon: IconName; class: string; label: string; spin: boolean }> = {
		queued: { icon: 'lucide:clock', class: 'text-slate-500 dark:text-slate-400', label: 'Queued', spin: false },
		building: { icon: 'lucide:loader-circle', class: 'text-amber-600 dark:text-amber-400', label: 'Building', spin: true },
		ready: { icon: 'lucide:circle-check', class: 'text-emerald-600 dark:text-emerald-400', label: 'Ready', spin: false },
		error: { icon: 'lucide:circle-x', class: 'text-rose-600 dark:text-rose-400', label: 'Failed', spin: false },
		canceled: { icon: 'lucide:ban', class: 'text-slate-500 dark:text-slate-500', label: 'Cancelled', spin: false }
	};

	const look = $derived(LOOK[state]);
</script>

<span class="inline-flex items-center gap-1.5 shrink-0 text-sm font-medium {look.class}" title={detail || look.label}>
	<Icon name={look.icon} class="w-4 h-4 {look.spin ? 'animate-spin' : ''}" />
	{#if !compact}
		<span>{look.label}</span>
	{/if}
</span>
