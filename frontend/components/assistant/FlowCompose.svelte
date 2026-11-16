<script lang="ts">
	/**
	 * A new repeating task, the way the owner would say it — one sentence with
	 * what should happen and when — on the left; the plan Clopen drafts from it
	 * on the canvas to the right. The sentence is the input: changing it offers
	 * to redraw the plan, right under it. Everything below it — the name, when
	 * it runs, the plan — is what was drawn from it. A step is opened from the
	 * canvas like any plan's, and its words can be changed there; the canvas
	 * follows. Save keeps it, and asks to connect any service it uses that is
	 * not connected yet. No recipe text: the owner never sees its syntax.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import PlanCanvas from './PlanCanvas.svelte';
	import StepDetail from './StepDetail.svelte';
	import { editableInstructions, findStep, stepLabel } from './recipe-format';
	import { recipeToText } from '$shared/utils/recipe-text';
	import { assistantStore, type FlowDraft } from '$frontend/stores/features/assistant.svelte';
	import { openFlow, openNeedsYou, openTask } from '$frontend/stores/ui/assistant-view.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';

	interface Props {
		mobile?: boolean;
	}

	const { mobile = false }: Props = $props();

	let what = $state('');
	let drafting = $state(false);
	let saving = $state(false);
	let draft = $state<FlowDraft | null>(null);
	/** The sentence the plan on the canvas was drawn from. */
	let drawnFrom = $state('');
	let selected = $state<string | null>(null);
	let detailExpanded = $state(false);

	const changed = $derived(Boolean(draft) && what.trim() !== drawnFrom);
	const step = $derived(draft && selected ? findStep(draft.recipe.steps, selected) : null);

	/** The step's words changed in its detail: the plan (and its card on the canvas) follows. */
	function editStep(text: string) {
		if (!step) return;
		const field = editableInstructions(step);
		if (field) (step as unknown as Record<string, string>)[field.key] = text;
	}

	async function makeDraft() {
		if (!what.trim()) return;
		drafting = true;
		try {
			const sentence = what.trim();
			draft = await assistantStore.draftFlow(sentence);
			drawnFrom = sentence;
			selected = null;
			detailExpanded = false;
		} catch (error) {
			addNotification({ type: 'error', title: 'Could not draft it', message: error instanceof Error ? error.message : String(error) });
		} finally {
			drafting = false;
		}
	}

	async function save() {
		if (!draft) return;
		saving = true;
		try {
			const saved = await assistantStore.saveFlow({
				name: draft.name,
				recipe: recipeToText(draft.recipe),
				...(draft.when ? { when: draft.when } : { manual: true })
			});
			// Services it uses that are not connected yet: their sign-in or key cards, right away.
			const results = await Promise.all(draft.needsConnect.map((service) => assistantStore.connectService(service).catch(() => null)));
			openFlow(saved.id);
			if (results.some((result) => result && result.status !== 'connected')) openNeedsYou();
		} catch (error) {
			addNotification({ type: 'error', title: 'Could not save it', message: error instanceof Error ? error.message : String(error) });
		} finally {
			saving = false;
		}
	}

	const field = 'w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm outline-none focus:border-violet-500/60';
	const primary = 'px-3 py-1.5 rounded-lg text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white border-none cursor-pointer disabled:opacity-50';
	const ghost = 'px-3 py-1.5 rounded-lg text-sm border border-slate-200 dark:border-slate-700 bg-transparent text-slate-600 dark:text-slate-300 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800';
</script>

<div class="flex flex-col h-full min-h-0">
	<header class="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
		{#if mobile}
			<button type="button" class="flex items-center justify-center w-8 h-8 -ml-1 rounded-lg text-slate-500 hover:bg-violet-500/10 border-none bg-transparent cursor-pointer" onclick={() => openTask(null)} aria-label="Back">
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
			</button>
		{/if}
		<h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">New repeating task</h2>
	</header>

	<div class="flex-1 min-h-0 flex {mobile ? 'flex-col overflow-y-auto' : ''}">
		<form class="{mobile ? '' : 'w-[380px] border-r overflow-y-auto'} shrink-0 p-4 space-y-4 border-slate-200 dark:border-slate-800" onsubmit={(event) => { event.preventDefault(); void makeDraft(); }}>
			<!-- The input, and the one action on it. -->
			<div class="space-y-2">
				<label class="block space-y-1.5">
					<span class="text-sm font-medium text-slate-800 dark:text-slate-200">What should happen?</span>
					<textarea class="{field} min-h-28" bind:value={what} placeholder="Every morning at 7, check my website and tell me if it is down"></textarea>
				</label>
				{#if !draft || changed || drafting}
					<button type="submit" class={draft ? ghost : primary} disabled={drafting || !what.trim()}>
						{#if drafting}<Icon name="lucide:loader" class="w-4 h-4 inline animate-spin" />{/if}
						{draft ? 'Redraw the plan' : 'Show me the plan'}
					</button>
				{/if}
			</div>
			<!-- What was drawn from it. -->
			{#if draft}
				<div class="space-y-4 pt-4 border-t border-slate-200 dark:border-slate-800">
					<label class="block space-y-1.5">
						<span class="text-sm font-medium text-slate-800 dark:text-slate-200">Name</span>
						<input class={field} bind:value={draft.name} />
					</label>
					<p class="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300"><Icon name="lucide:clock" class="w-4 h-4 shrink-0" />{draft.whenText}</p>
					<button type="button" class={primary} disabled={saving || drafting} onclick={save}>Save</button>
				</div>
			{/if}
		</form>
		<div class="flex-1 min-w-0 {mobile ? 'min-h-96' : 'min-h-0'} relative flex flex-col">
			{#if draft && !drafting}
				<div class="flex-1 min-h-0 relative">
					<PlanCanvas recipe={draft.recipe} trace={[]} trigger={draft.whenText} vertical={mobile} notConnected={draft.needsConnect} {selected} onSelect={(path) => (selected = path)} />
				</div>
				{#if step}
					<StepDetail
						title={stepLabel(step)}
						{step}
						entries={[]}
						expanded={detailExpanded}
						onToggleExpand={() => (detailExpanded = !detailExpanded)}
						onClose={() => {
							selected = null;
							detailExpanded = false;
						}}
						onEdit={editStep}
					/>
				{/if}
			{:else}
				<div class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-slate-400 bg-[radial-gradient(circle,_rgb(148_163_184/0.35)_1px,_transparent_1px)] [background-size:20px_20px]">
					{#if drafting}
						<div class="flex gap-6" aria-busy="true">
							{#each [0, 1, 2] as index (index)}<div class="w-40 h-[78px] rounded-xl bg-slate-200/70 dark:bg-slate-800/70 animate-pulse"></div>{/each}
						</div>
					{:else}
						<Icon name="lucide:workflow" class="w-6 h-6" />
						The plan appears here
					{/if}
				</div>
			{/if}
		</div>
	</div>
</div>
