<!--
  Rate Limit Banner
  Static panel docked at the top of the AI Assistant chat (above TaskProgress).
  Shows every active engine rate-limit snapshot keyed by account, regardless
  of which project / session the user is currently viewing — rate limits are
  bound to the account, not to a single session.
-->

<script lang="ts">
	import {
		rateLimitStore,
		dismissRateLimit,
		type RateLimitState
	} from '$frontend/stores/ui/rate-limit.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ws from '$frontend/utils/ws';

	const activeLimits = $derived.by(() => Object.values(rateLimitStore.byAccount));

	function isRejected(state: RateLimitState) {
		return state.status === 'rejected';
	}

	function percentUsed(state: RateLimitState) {
		const raw = Math.round((state.utilization || 0) * 100);
		if (isRejected(state)) return Math.max(raw, 100);
		return Math.min(Math.max(raw, 0), 100);
	}

	function resetLabel(state: RateLimitState): string | null {
		if (!state.resetsAt) return null;
		return new Date(state.resetsAt * 1000).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function typeLabel(state: RateLimitState): string | null {
		switch (state.rateLimitType) {
			case 'five_hour':
				return '5-hour session';
			case 'seven_day':
				return 'Weekly';
			case 'seven_day_opus':
				return 'Weekly · Opus';
			case 'seven_day_sonnet':
				return 'Weekly · Sonnet';
			case 'overage':
				return 'Overage';
			default:
				return null;
		}
	}

	function headerLabel(state: RateLimitState): string {
		const type = typeLabel(state);
		const prefix = type ? `${type} rate limit` : 'Rate limit';
		const base = isRejected(state)
			? `${prefix} reached`
			: `${prefix} · ${percentUsed(state)}% used`;
		const reset = resetLabel(state);
		return reset ? `${base} · Resets ${reset}` : base;
	}

	function handleDismiss(state: RateLimitState) {
		dismissRateLimit(state.engine, state.accountId);
		ws.emit('chat:rate-limit-dismiss', {
			engine: state.engine,
			accountId: state.accountId
		});
	}
</script>

{#each activeLimits as state (`${state.engine}:${state.accountId}`)}
	<div
		class="shrink-0 border-b {isRejected(state)
			? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900/60'
			: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/60'}"
		role="status"
		aria-live="polite"
	>
		<div class="flex items-center gap-2 min-w-0 px-4 py-2.5">
			<Icon
				name={isRejected(state) ? 'lucide:octagon-alert' : 'lucide:triangle-alert'}
				class="w-4 h-4 shrink-0 {isRejected(state)
					? 'text-red-600 dark:text-red-400'
					: 'text-amber-600 dark:text-amber-400'}"
			/>
			<span
				class="flex-1 text-sm font-semibold truncate {isRejected(state)
					? 'text-red-800 dark:text-red-200'
					: 'text-amber-800 dark:text-amber-200'}"
			>
				{headerLabel(state)}
			</span>
			<button
				type="button"
				onclick={() => handleDismiss(state)}
				title="Dismiss"
				aria-label="Dismiss rate limit banner"
				class="flex shrink-0 rounded p-0.5 transition-colors {isRejected(state)
					? 'text-red-600/80 hover:bg-red-100 hover:text-red-700 dark:text-red-400/80 dark:hover:bg-red-900/40 dark:hover:text-red-300'
					: 'text-amber-600/80 hover:bg-amber-100 hover:text-amber-700 dark:text-amber-400/80 dark:hover:bg-amber-900/40 dark:hover:text-amber-300'}"
			>
				<Icon name="lucide:x" class="w-3.5 h-3.5" />
			</button>
		</div>
	</div>
{/each}
