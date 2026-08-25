<script lang="ts">
	/**
	 * Writing a memory by hand.
	 *
	 * Automatic extraction can only record what a conversation happened to state,
	 * which means a constraint the user already knows has to be said out loud to an
	 * agent before it can be remembered — usually after the mistake it would have
	 * prevented. This is the way in that does not require staging a conversation.
	 *
	 * ── one box, then a review ──
	 * The input is a single textarea, because a six-field form for a store whose
	 * promise is "you do not have to curate it" would be a contradiction. But six
	 * fields are what gets stored, so the write is two steps: shape it, show the
	 * result, save what was shown. The preview is editable and the shaping is
	 * optional — "Save as written" skips the model entirely, which is also the
	 * automatic fallback when no memory model is configured. That fallback is the
	 * point rather than an apology: this is the one write path that works on an
	 * instance whose graph is otherwise empty.
	 *
	 * A near-duplicate is SHOWN, never enforced. Refusing the save would be the
	 * second-worst version of this; storing the same fact twice and letting ranking
	 * sort it out would be the worst.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import LoadingSpinner from '$frontend/components/common/feedback/LoadingSpinner.svelte';
	import { memoryGraphStore, EPISODIC_SUBKINDS } from '$frontend/stores/features/memory-graph.svelte';
	import type { MemoryDraft } from '$shared/types/memory';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
		/** Called with the new node's id, so the caller can select it. */
		onCreated?: (nodeId: string) => void;
	}

	let { isOpen = $bindable(), onClose, onCreated }: Props = $props();

	let text = $state('');
	let draft = $state<MemoryDraft | null>(null);
	let working = $state(false);
	let error = $state<string | null>(null);
	/** Reinforce the near-duplicate instead of storing a second copy. */
	let reinforce = $state(false);

	const config = $derived(memoryGraphStore.config);
	const hasModel = $derived(Boolean(config?.model));

	function reset(): void {
		text = '';
		draft = null;
		error = null;
		working = false;
		reinforce = false;
	}

	function close(): void {
		reset();
		onClose();
	}

	async function preview(structure: boolean): Promise<void> {
		if (!text.trim() || working) return;
		working = true;
		error = null;
		try {
			draft = await memoryGraphStore.draftNode(text, { structure });
			if (!draft) error = 'There was nothing in that to record.';
			// Offered by default when a duplicate is found: agreeing with a memory
			// that already exists should make it stronger, not make a second one.
			reinforce = Boolean(draft?.duplicateOf);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			working = false;
		}
	}

	async function save(): Promise<void> {
		if (!draft || !draft.label.trim() || working) return;
		working = true;
		error = null;
		try {
			const node = await memoryGraphStore.createNode({
				subkind: draft.subkind,
				scope: draft.scope,
				label: draft.label,
				body: draft.body,
				entities: draft.entities,
				relatedPaths: draft.relatedPaths,
				reinforceId: reinforce ? draft.duplicateOf?.id ?? null : null
			});
			if (node) onCreated?.(node.id);
			close();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			working = false;
		}
	}

	/** Cmd/Ctrl+Enter advances: from the box to the preview, from the preview to saved. */
	function onKeydown(event: KeyboardEvent): void {
		if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
		event.preventDefault();
		if (draft) void save();
		else void preview(hasModel);
	}
</script>

<Modal
	bind:isOpen
	onClose={close}
	bare
	ariaLabelledBy="memory-composer-title"
	className="flex flex-col w-full max-w-[560px] max-h-[80dvh] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.3)]"
>
	{#snippet children()}
		<header class="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
			<Icon name="lucide:plus" class="w-4 h-4 text-violet-500 shrink-0" />
			<h2 id="memory-composer-title" class="text-sm font-semibold text-slate-900 dark:text-slate-100">
				{draft ? 'Review this memory' : 'Remember something'}
			</h2>
			<button
				onclick={close}
				class="flex ml-auto p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200
				       hover:bg-slate-100 dark:hover:bg-slate-800"
				aria-label="Close"
			>
				<Icon name="lucide:x" class="w-4 h-4" />
			</button>
		</header>

		<div class="flex-1 min-h-0 overflow-y-auto px-4 py-3.5">
			{#if error}
				<div class="mb-3 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-xs text-red-600 dark:text-red-400">
					{error}
				</div>
			{/if}

			{#if !draft}
				<p class="text-xs text-slate-500 dark:text-slate-400 mb-2.5 leading-relaxed">
					Write it however you would say it. Every agent, on every engine, gets this from now on —
					so a rule, a constraint or a preference is worth more here than a note about today.
				</p>
				<textarea
					bind:value={text}
					onkeydown={onKeydown}
					rows="6"
					placeholder="Never touch the vendored/ directory — it is generated by the build and any edit is lost on the next run."
					class="w-full px-3 py-2.5 text-xs rounded-lg bg-slate-50 dark:bg-slate-800/70
					       border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100
					       placeholder:text-slate-400 outline-none focus:border-violet-500 resize-y leading-relaxed"
				></textarea>

				{#if !hasModel}
					<p class="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
						No memory model is configured, so this will be saved exactly as written. That is fine —
						nothing here needs one.
					</p>
				{/if}
			{:else}
				{#if draft.note}
					<div class="mb-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-slate-500/5 dark:bg-slate-400/5">
						<Icon name="lucide:info" class="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
						<p class="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">{draft.note}</p>
					</div>
				{/if}

				{#if draft.duplicateOf}
					<div class="mb-3 px-3 py-2.5 rounded-lg bg-amber-50 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-900/40">
						<p class="text-[11px] text-amber-800 dark:text-amber-300 leading-relaxed">
							Something very close to this is already stored:
							<span class="font-medium">“{draft.duplicateOf.label}”</span>
						</p>
						<label class="flex items-start gap-2 mt-2 cursor-pointer">
							<input type="checkbox" bind:checked={reinforce} class="mt-0.5 accent-violet-600" />
							<span class="text-[11px] text-amber-800 dark:text-amber-300">
								Strengthen that one instead of adding a second copy
							</span>
						</label>
					</div>
				{/if}

				<label class="block text-[9px] uppercase tracking-wide text-slate-400 mb-1">The claim</label>
				<input
					bind:value={draft.label}
					onkeydown={onKeydown}
					class="w-full px-3 py-2 mb-3 text-xs rounded-lg bg-slate-50 dark:bg-slate-800/70
					       border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100
					       outline-none focus:border-violet-500"
				/>

				<label class="block text-[9px] uppercase tracking-wide text-slate-400 mb-1">Why it holds</label>
				<textarea
					bind:value={draft.body}
					rows="4"
					class="w-full px-3 py-2 mb-3 text-xs rounded-lg bg-slate-50 dark:bg-slate-800/70
					       border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100
					       outline-none focus:border-violet-500 resize-y leading-relaxed"
				></textarea>

				<div class="grid grid-cols-2 gap-3">
					<div>
						<span class="block text-[9px] uppercase tracking-wide text-slate-400 mb-1">Kind</span>
						<div class="flex flex-wrap gap-1">
							{#each EPISODIC_SUBKINDS as subkind (subkind)}
								<button
									type="button"
									onclick={() => draft && (draft.subkind = subkind)}
									class="px-2 py-1 text-[10px] rounded border capitalize transition-colors {draft.subkind === subkind
										? 'border-violet-500/40 bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300'
										: 'border-slate-200 dark:border-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}"
								>
									{subkind}
								</button>
							{/each}
						</div>
					</div>
					<div>
						<span class="block text-[9px] uppercase tracking-wide text-slate-400 mb-1">Applies to</span>
						<div class="flex gap-1">
							{#each [{ value: 'project' as const, label: 'This project' }, { value: 'global' as const, label: 'Everywhere' }] as option (option.value)}
								<button
									type="button"
									onclick={() => draft && (draft.scope = option.value)}
									class="px-2 py-1 text-[10px] rounded border transition-colors {draft.scope === option.value
										? 'border-violet-500/40 bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300'
										: 'border-slate-200 dark:border-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}"
								>
									{option.label}
								</button>
							{/each}
						</div>
					</div>
				</div>

				{#if draft.entities.length > 0 || draft.relatedPaths.length > 0}
					<p class="mt-3 text-[10px] text-slate-400 leading-relaxed">
						Will be connected to
						{#if draft.entities.length > 0}<span class="text-slate-500 dark:text-slate-400">{draft.entities.join(', ')}</span>{/if}
						{#if draft.entities.length > 0 && draft.relatedPaths.length > 0} · {/if}
						{#if draft.relatedPaths.length > 0}<span class="text-slate-500 dark:text-slate-400 font-mono">{draft.relatedPaths.join(', ')}</span>{/if}
					</p>
				{/if}
			{/if}
		</div>

		<footer class="flex items-center gap-2 px-4 py-3 border-t border-slate-200 dark:border-slate-800">
			{#if working}
				<LoadingSpinner />
			{/if}
			<div class="ml-auto flex items-center gap-2">
				{#if draft}
					<button
						onclick={() => (draft = null)}
						disabled={working}
						class="px-3 py-1.5 text-xs rounded-md text-slate-500 dark:text-slate-400
						       hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
					>
						Back
					</button>
					<button
						onclick={() => void save()}
						disabled={working || !draft.label.trim()}
						class="px-3 py-1.5 text-xs font-medium rounded-md bg-violet-600 text-white
						       hover:bg-violet-500 disabled:opacity-40"
					>
						{reinforce ? 'Strengthen it' : 'Remember this'}
					</button>
				{:else}
					<button
						onclick={() => void preview(false)}
						disabled={working || !text.trim()}
						class="px-3 py-1.5 text-xs rounded-md text-slate-600 dark:text-slate-300
						       hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
					>
						Keep as written
					</button>
					<button
						onclick={() => void preview(hasModel)}
						disabled={working || !text.trim()}
						class="px-3 py-1.5 text-xs font-medium rounded-md bg-violet-600 text-white
						       hover:bg-violet-500 disabled:opacity-40"
					>
						{hasModel ? 'Tidy it up' : 'Continue'}
					</button>
				{/if}
			</div>
		</footer>
	{/snippet}
</Modal>
