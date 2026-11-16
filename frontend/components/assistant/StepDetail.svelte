<script lang="ts">
	/**
	 * What one step of a plan did, sliding up over the bottom of the canvas.
	 * Tabs appear only when there is something in them: Result (a review reads
	 * as passed/not with its issues, never raw JSON), Instructions (what the
	 * agent was told), Rounds (each round of a loop), Info (who, where, how
	 * long, what it cost). It can be enlarged to fill the view.
	 *
	 * A plan not saved yet (a draft) has nothing that ran: it shows what the
	 * step will do, and its words can be changed right there — the canvas
	 * follows as they are typed.
	 */
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Markdown from '$frontend/components/common/display/Markdown.svelte';
	import type { RecipeStep, RecipeTraceEntry } from '$shared/types/recipe';
	import { duration, editableInstructions, money, readVerdict, stepInstructions } from './recipe-format';

	interface Props {
		title: string;
		step: RecipeStep | null;
		/** Every run of the step, oldest first. */
		entries: RecipeTraceEntry[];
		/** The project it ran in, when known. */
		projectName?: string | null;
		/** Opens the agent's chat for this step, when there is one. */
		onOpenChat?: (() => void) | null;
		expanded: boolean;
		onToggleExpand: () => void;
		onClose: () => void;
		/** A draft: nothing ran yet, and the step's words can be changed. */
		onEdit?: ((text: string) => void) | null;
	}

	const { title, step, entries, projectName = null, onOpenChat = null, expanded, onToggleExpand, onClose, onEdit = null }: Props = $props();
	const draft = $derived(Boolean(onEdit));
	const editable = $derived(onEdit && step ? editableInstructions(step) : null);

	type Tab = 'result' | 'instructions' | 'rounds' | 'info';
	let tab = $state<Tab>('result');

	const last = $derived(entries[entries.length - 1] ?? null);
	const instructions = $derived(step ? stepInstructions(step) : null);
	const totalMs = $derived(entries.reduce((sum, entry) => sum + (entry.ms ?? 0), 0));
	const totalCost = $derived(entries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0));
	const tabs = $derived(
		[
			{ id: 'result' as const, label: 'Result', shown: !draft },
			{ id: 'instructions' as const, label: 'Instructions', shown: Boolean(instructions || editable) },
			{ id: 'rounds' as const, label: `Rounds (${entries.length})`, shown: entries.length > 1 },
			{ id: 'info' as const, label: 'Info', shown: Boolean(last || (step && 'role' in step && step.role) || projectName) }
		].filter((entry) => entry.shown)
	);

	$effect(() => {
		if (!tabs.some((entry) => entry.id === tab)) tab = tabs[0]?.id ?? 'result';
	});
</script>

{#snippet output(entry: RecipeTraceEntry)}
	{@const verdict = readVerdict(entry.output)}
	{#if entry.error}
		<p class="text-sm text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">{entry.error}</p>
	{/if}
	{#if verdict}
		<div class="space-y-2">
			<p class="flex items-center gap-1.5 text-sm font-medium {verdict.passed ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}">
				<Icon name={verdict.passed ? 'lucide:circle-check' : 'lucide:circle-alert'} class="w-4 h-4" />
				{verdict.passed ? 'Passed' : 'Not yet'}
			</p>
			{#if verdict.issues.length}
				<ul class="space-y-1.5 list-disc pl-5 text-sm text-slate-700 dark:text-slate-300">
					{#each verdict.issues as issue, at (at)}<li class="break-words">{issue}</li>{/each}
				</ul>
			{:else if verdict.notes.length}
				<ul class="space-y-1.5 list-disc pl-5 text-sm text-slate-700 dark:text-slate-300">
					{#each verdict.notes as note, at (at)}<li class="break-words">{note}</li>{/each}
				</ul>
			{/if}
		</div>
	{:else if entry.output}
		<div class="text-sm text-slate-700 dark:text-slate-300 break-words"><Markdown content={entry.output} /></div>
	{/if}
{/snippet}

<section
	class="flex flex-col min-h-0 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 {expanded ? 'absolute inset-0 z-20' : 'shrink-0 max-h-[45%]'}"
	transition:fly={{ y: 160, duration: 220, easing: cubicOut }}
>
	<header class="flex items-center gap-2 px-4 pt-3 pb-2 shrink-0">
		<h3 class="flex-1 min-w-0 text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{title}</h3>
		{#if onOpenChat}
			<button type="button" class="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-violet-600 dark:text-violet-400 bg-transparent border border-violet-500/30 cursor-pointer hover:bg-violet-500/10 shrink-0" onclick={onOpenChat}>
				Open chat <Icon name="lucide:arrow-up-right" class="w-3.5 h-3.5" />
			</button>
		{/if}
		<button type="button" class="flex items-center justify-center w-7 h-7 rounded-md text-slate-400 bg-transparent border-none cursor-pointer hover:bg-violet-500/10" onclick={onToggleExpand} aria-label={expanded ? 'Shrink' : 'Enlarge'} title={expanded ? 'Shrink' : 'Enlarge'}>
			<Icon name={expanded ? 'lucide:minimize-2' : 'lucide:maximize-2'} class="w-4 h-4" />
		</button>
		<button type="button" class="flex items-center justify-center w-7 h-7 rounded-md text-slate-400 bg-transparent border-none cursor-pointer hover:bg-violet-500/10" onclick={onClose} aria-label="Close"><Icon name="lucide:x" class="w-4 h-4" /></button>
	</header>
	{#if tabs.length > 1}
		<nav class="flex items-center gap-1 px-4 pb-2 shrink-0" aria-label="Step details">
			{#each tabs as entry (entry.id)}
				<button
					type="button"
					class="px-2.5 py-1 rounded-md text-xs font-medium border-none cursor-pointer {tab === entry.id ? 'bg-violet-500/10 dark:bg-violet-500/20 text-violet-700 dark:text-violet-300' : 'bg-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-100'}"
					onclick={() => (tab = entry.id)}
				>{entry.label}</button>
			{/each}
		</nav>
	{/if}
	<div class="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
		{#if tab === 'result'}
			{#if last}
				{@render output(last)}
				{#if !last.output && !last.error}<p class="text-sm text-slate-500">Done, with nothing to show.</p>{/if}
			{:else}
				<p class="text-sm text-slate-500">Not started yet.</p>
			{/if}
		{:else if tab === 'instructions' && editable}
			<textarea
				class="w-full min-h-28 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-800 dark:text-slate-200 outline-none focus:border-violet-500/60 resize-y"
				value={editable.value}
				oninput={(event) => onEdit?.(event.currentTarget.value)}
				aria-label="What this step does"
			></textarea>
		{:else if tab === 'instructions' && instructions}
			<div class="text-sm text-slate-700 dark:text-slate-300 break-words"><Markdown content={instructions} /></div>
		{:else if tab === 'rounds'}
			<ol class="space-y-3">
				{#each entries as entry, at (at)}
					<li class="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-1.5">
						<p class="text-2xs font-semibold uppercase tracking-wide text-slate-500">Round {at + 1} · {duration(entry.ms)}{entry.costUsd ? ` · ${money(entry.costUsd)}` : ''}</p>
						{@render output(entry)}
					</li>
				{/each}
			</ol>
		{:else if tab === 'info'}
			<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
				{#if step && 'role' in step && step.role}<dt class="text-slate-500">Who</dt><dd class="text-slate-800 dark:text-slate-200">{step.role}</dd>{/if}
				{#if projectName}<dt class="text-slate-500">Project</dt><dd class="text-slate-800 dark:text-slate-200">{projectName}</dd>{/if}
				{#if last}<dt class="text-slate-500">Time</dt><dd class="text-slate-800 dark:text-slate-200">{duration(totalMs)}{entries.length > 1 ? ` over ${entries.length} rounds` : ''}</dd>{/if}
				{#if totalCost}<dt class="text-slate-500">Cost</dt><dd class="text-slate-800 dark:text-slate-200">{money(totalCost)}</dd>{/if}
				{#if last}<dt class="text-slate-500">Started</dt><dd class="text-slate-800 dark:text-slate-200">{new Date(entries[0].startedAt).toLocaleString()}</dd>{/if}
			</dl>
		{/if}
	</div>
</section>
