<script lang="ts">
	/**
	 * What memory is doing right now.
	 *
	 * Recording is background work by design: it happens after a conversation goes
	 * quiet, through a model the user chose once and then forgets about. The cost
	 * of that design is that every failure mode looks identical from the outside —
	 * a rate-limited model, an expired account, an engine that is down and a
	 * genuinely uneventful conversation all produce the same thing, which is a
	 * graph that does not grow. This is the component that tells them apart.
	 *
	 * It says nothing when there is nothing to say. A status line that is always
	 * present becomes furniture, and the point here is to be noticed on the day
	 * something is wrong.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { memoryGraphStore } from '$frontend/stores/features/memory-graph.svelte';
	import { settingsModalState } from '$frontend/stores/ui/settings-modal.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		/** `bar` for the modal header; `block` for a settings page. */
		variant?: 'bar' | 'block';
		/** Whether this user may act on a stalled queue. */
		canRetry?: boolean;
	}

	const { variant = 'bar', canRetry = false }: Props = $props();

	const status = $derived(memoryGraphStore.status);
	let retrying = $state(false);

	type Tone = 'busy' | 'warn' | 'error' | 'idle';

	/**
	 * One line, chosen by severity rather than by concatenating every count.
	 *
	 * Ordered deliberately: a stalled queue matters more than a busy one, and "no
	 * model configured" outranks both because it is the only state where nothing
	 * will ever happen without the user doing something.
	 */
	const line = $derived.by((): { tone: Tone; icon: IconName; text: string } | null => {
		if (!status) return null;

		if (!status.modelConfigured) {
			return {
				tone: 'warn',
				icon: 'lucide:triangle-alert',
				text:
					status.pending > 0
						? `${status.pending} conversation${status.pending === 1 ? '' : 's'} waiting — no model is set to write memories`
						: 'No model is set to write memories'
			};
		}

		if (status.failed > 0) {
			return {
				tone: 'error',
				icon: 'lucide:circle-x',
				text: `${status.failed} conversation${status.failed === 1 ? '' : 's'} could not be recorded`
			};
		}

		if (status.running > 0) {
			return { tone: 'busy', icon: 'lucide:loader-circle', text: 'Recording a conversation…' };
		}

		if (status.retrying > 0) {
			return {
				tone: 'warn',
				icon: 'lucide:refresh-cw',
				text: `Retrying ${status.retrying} conversation${status.retrying === 1 ? '' : 's'}`
			};
		}

		if (status.pending > 0) {
			return {
				tone: 'idle',
				icon: 'lucide:clock',
				text: `${status.pending} conversation${status.pending === 1 ? '' : 's'} waiting to be recorded`
			};
		}

		// Everything is recorded. Worth saying on a settings page, not worth a line
		// in the header of a graph the user is already looking at.
		return variant === 'block'
			? { tone: 'idle', icon: 'lucide:check', text: 'Everything is recorded' }
			: null;
	});

	const TONES: Record<Tone, string> = {
		busy: 'text-violet-600 dark:text-violet-400',
		warn: 'text-amber-600 dark:text-amber-400',
		error: 'text-red-600 dark:text-red-400',
		idle: 'text-slate-500 dark:text-slate-400'
	};

	async function retry(): Promise<void> {
		retrying = true;
		try {
			await memoryGraphStore.retryFailed();
		} finally {
			retrying = false;
		}
	}

	function openModelSettings(): void {
		settingsModalState.isOpen = true;
		settingsModalState.activeSection = 'memory';
	}
</script>

{#if line}
	{#if variant === 'bar'}
		<span class="flex items-center gap-1.5 text-[10px] {TONES[line.tone]}" title={status?.lastError ?? undefined}>
			<Icon
				name={line.icon}
				class="w-3 h-3 shrink-0 {line.tone === 'busy' ? 'animate-spin' : ''}"
			/>
			<span class="hidden sm:inline">{line.text}</span>
		</span>
	{:else}
		<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
			<div class="flex items-center gap-3 px-5 py-4 border-b border-slate-200 dark:border-slate-700/50">
				<div class="flex items-center justify-center w-9 h-9 rounded-lg bg-violet-500/10 dark:bg-violet-500/15 shrink-0">
					<Icon name="lucide:activity" class="w-5 h-5 text-violet-600 dark:text-violet-400" />
				</div>
				<div class="min-w-0">
					<h4 class="font-semibold text-slate-900 dark:text-slate-100">Recording status</h4>
					<p class="text-xs text-slate-500 dark:text-slate-400">What's happening right now</p>
				</div>
			</div>

			<div class="px-5 py-4 flex items-start gap-2.5">
				<Icon
					name={line.icon}
					class="w-4 h-4 mt-0.5 shrink-0 {TONES[line.tone]} {line.tone === 'busy' ? 'animate-spin' : ''}"
				/>
				<div class="min-w-0 flex-1">
					<p class="text-[13px] font-medium text-slate-800 dark:text-slate-200">{line.text}</p>

					{#if status && (status.pending > 0 || status.failed > 0)}
						<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
							A conversation is summarised as soon as the turn finishes. Nothing is lost
							while it waits — a failure is retried with a growing delay, and anything still queued
							survives a restart.
						</p>
					{/if}

					<!--
						The error is shown verbatim. It is the difference between "memory is
						broken" and "your API key expired", and paraphrasing it would remove
						exactly the part that tells the user which.
					-->
					{#if status?.lastError}
						<p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5 font-mono wrap-anywhere">
							{status.lastError}
						</p>
					{/if}

					<div class="flex flex-wrap items-center gap-3 mt-2">
						{#if !status?.modelConfigured}
							<button
								type="button"
								class="text-[11px] font-medium text-amber-700 dark:text-amber-400 hover:underline"
								onclick={openModelSettings}
							>
								Choose a model
							</button>
						{/if}
						{#if canRetry && (status?.failed ?? 0) > 0}
							<button
								type="button"
								disabled={retrying}
								class="text-[11px] font-medium text-violet-600 dark:text-violet-400 hover:underline disabled:opacity-40"
								onclick={retry}
							>
								{retrying ? 'Retrying…' : 'Try again now'}
							</button>
						{/if}
					</div>
				</div>
			</div>
		</div>
	{/if}
{/if}
