<script lang="ts">
	/**
	 * Banner for an in-progress merge / rebase / cherry-pick / revert.
	 *
	 * The panel already knew about these states — it used them to grey out Push
	 * and Pull — but never said so anywhere the user could see, so a stalled
	 * rebase looked like broken buttons. This is also the only place that offers
	 * "Continue": without it, resolving every conflict left the repo mid-rebase
	 * with nothing to click but Abort.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { GitOperationState } from '$shared/types/git';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		state: GitOperationState;
		/** A continue/skip/abort is already running against this repo. */
		busy?: boolean;
		onContinue: () => void;
		onSkip: () => void;
		onAbort: () => void;
		/** Opens the conflict resolver. Hidden when nothing is unmerged. */
		onResolve?: () => void;
		/** Repo label, shown only for nested repos so the banner is unambiguous. */
		repoLabel?: string;
	}

	const { state, busy = false, onContinue, onSkip, onAbort, onResolve, repoLabel }: Props = $props();

	const title = $derived.by(() => {
		if (state.stashConflict) return 'Stash conflict';
		switch (state.operation) {
			case 'rebase': return 'Rebase in progress';
			case 'merge': return 'Merge in progress';
			case 'cherry-pick': return 'Cherry-pick in progress';
			case 'revert': return 'Revert in progress';
			case 'bisect': return 'Bisect in progress';
			default: return 'Operation in progress';
		}
	});

	const icon = $derived<IconName>(
		state.operation === 'rebase'
			? 'lucide:git-pull-request-arrow'
			: state.operation === 'merge'
				? 'lucide:git-merge'
				: 'lucide:triangle-alert'
	);

	/**
	 * The one sentence that prevents the most damage. During a rebase git replays
	 * your commits onto the upstream, which swaps what `ours` and `theirs` mean
	 * relative to a merge — so we spell both sides out by name rather than
	 * printing the bare words.
	 */
	const sidesHint = $derived(
		state.operation === 'bisect'
			? ''
			: `ours = ${state.oursLabel} · theirs = ${state.theirsLabel}`
	);

	const progress = $derived(
		state.step && state.total ? `${state.step} / ${state.total}` : ''
	);

	const abortLabel = $derived(
		state.stashConflict
			? 'Reset'
			: state.operation === 'merge'
				? 'Abort merge'
				: state.operation === 'rebase'
					? 'Abort rebase'
					: state.operation === 'cherry-pick'
						? 'Abort cherry-pick'
						: state.operation === 'revert'
							? 'Abort revert'
							: 'Abort'
	);

	const continueTitle = $derived(
		state.unmergedCount > 0
			? `Resolve and stage ${state.unmergedCount} file${state.unmergedCount === 1 ? '' : 's'} first`
			: 'Finish this operation'
	);
</script>

<div
	class="mx-2 mb-2 rounded-lg border border-amber-400/50 bg-amber-500/10 dark:border-amber-500/40 dark:bg-amber-500/10"
>
	<div class="flex flex-wrap items-start gap-x-2 gap-y-1 px-2.5 py-2">
		<Icon name={icon} class="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
		<div class="min-w-0 flex-1">
			<div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
				<span class="text-xs font-semibold text-amber-800 dark:text-amber-200">{title}</span>
				{#if progress}
					<span
						class="rounded px-1 py-px text-3xs font-semibold text-amber-800 dark:text-amber-200 bg-amber-500/20"
					>
						{progress}
					</span>
				{/if}
				{#if repoLabel}
					<span class="truncate text-3xs text-amber-700/80 dark:text-amber-300/80">in {repoLabel}</span>
				{/if}
			</div>

			{#if state.currentCommit}
				<p class="mt-0.5 truncate text-3xs text-amber-800/90 dark:text-amber-200/90" title={state.currentCommit}>
					{state.currentCommit}
				</p>
			{/if}

			{#if sidesHint}
				<p class="mt-0.5 truncate text-3xs text-amber-700/80 dark:text-amber-300/80" title={sidesHint}>
					{sidesHint}
				</p>
			{/if}

			{#if state.unmergedCount > 0}
				<button
					type="button"
					class="mt-1 inline-flex items-center gap-1 rounded-md border-none bg-amber-500/20 px-1.5 py-0.5 text-3xs font-medium text-amber-900 transition-colors hover:bg-amber-500/30 dark:text-amber-100 {onResolve ? 'cursor-pointer' : 'cursor-default'}"
					onclick={onResolve}
					disabled={!onResolve}
				>
					<Icon name="lucide:git-compare-arrows" class="w-3 h-3" />
					{state.unmergedCount} unresolved file{state.unmergedCount === 1 ? '' : 's'}
				</button>
			{/if}
		</div>

		<div class="flex shrink-0 flex-wrap items-center gap-1">
			{#if !state.stashConflict && state.operation !== 'bisect'}
				<button
					type="button"
					class="flex items-center gap-1 rounded-md border-none px-2 py-1 text-3xs font-semibold transition-colors
						{state.canContinue && !busy
							? 'bg-emerald-600 text-white hover:bg-emerald-700 cursor-pointer'
							: 'bg-slate-200 text-slate-400 dark:bg-slate-700 dark:text-slate-500 cursor-not-allowed'}"
					onclick={onContinue}
					disabled={!state.canContinue || busy}
					title={continueTitle}
				>
					<Icon name="lucide:play" class="w-3 h-3" />
					Continue
				</button>
			{/if}
			{#if state.canSkip}
				<button
					type="button"
					class="flex items-center gap-1 rounded-md border-none bg-white/70 px-2 py-1 text-3xs font-semibold text-amber-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-800/70 dark:text-amber-100 dark:hover:bg-slate-800 cursor-pointer"
					onclick={onSkip}
					disabled={busy}
					title="Drop the commit git is stuck on and move to the next one"
				>
					<Icon name="lucide:skip-forward" class="w-3 h-3" />
					Skip
				</button>
			{/if}
			<button
				type="button"
				class="flex items-center gap-1 rounded-md border-none bg-red-500/10 px-2 py-1 text-3xs font-semibold text-red-600 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-400 cursor-pointer"
				onclick={onAbort}
				disabled={busy}
				title={state.stashConflict
					? 'Unwind the unmerged paths — the stash entry itself is kept'
					: 'Undo this operation and return to the previous state'}
			>
				<Icon name="lucide:octagon-x" class="w-3 h-3" />
				{abortLabel}
			</button>
		</div>
	</div>
</div>
