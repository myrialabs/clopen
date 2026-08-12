<script lang="ts">
	/**
	 * Detail view for one node.
	 *
	 * Three blocks with room to breathe: what it is, what it says, what it touches.
	 * The earlier version stacked a title, two chips, a path, the same path again
	 * as `body`, a date, a lone button and a flat list — technically complete and
	 * unreadable.
	 *
	 * Editing is offered for memories only. A structural node describes what is on
	 * disk: its label and path are derived, so rewriting them would make the node
	 * claim something the filesystem contradicts, and the next extraction would
	 * overwrite it anyway.
	 */
	import { memoryGraphStore, type NodeDetail } from '$frontend/stores/features/memory-graph.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { EpisodicSubkind } from '$shared/types/memory';

	interface Props {
		detail: NodeDetail;
		canEdit: boolean;
		onSelect: (nodeId: string) => void;
		/** History controls live in this panel's own header — see the note below. */
		canGoBack: boolean;
		canGoForward: boolean;
		onBack: () => void;
		onForward: () => void;
		onClose: () => void;
	}

	const { detail, canEdit, onSelect, canGoBack, canGoForward, onBack, onForward, onClose }: Props =
		$props();

	// Includes `entity`, which extraction produces for people and things — leaving
	// it out made the dropdown silently rewrite an entity node as an observation.
	const SUBKINDS: EpisodicSubkind[] = [
		'entity',
		'preference',
		'decision',
		'pattern',
		'failure',
		'observation'
	];

	let editing = $state(false);
	let draftLabel = $state('');
	let draftBody = $state('');
	let draftSubkind = $state<string>('observation');
	let busy = $state(false);
	let error = $state<string | null>(null);

	const node = $derived(detail.node);
	const isMemory = $derived(node.kind === 'episodic');

	/**
	 * Structural nodes store their path in `body` as well as `path`, so rendering
	 * both printed the same string twice.
	 */
	const bodyText = $derived(node.body && node.body !== node.path ? node.body : '');

	const memories = $derived(detail.neighbours.filter(n => n.node.kind === 'episodic'));
	const code = $derived(detail.neighbours.filter(n => n.node.kind === 'structural'));

	// Reset when the inspected node changes, so switching never carries a
	// half-typed edit onto a different memory.
	$effect(() => {
		void node.id;
		editing = false;
		error = null;
	});

	function beginEdit(): void {
		draftLabel = node.label;
		draftBody = node.body;
		draftSubkind = node.subkind;
		editing = true;
		error = null;
	}

	async function run(action: () => Promise<void>): Promise<void> {
		busy = true;
		error = null;
		try {
			await action();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function save(): Promise<void> {
		if (!draftLabel.trim()) {
			error = 'A memory needs a summary.';
			return;
		}
		await run(async () => {
			await memoryGraphStore.saveNode(node.id, {
				label: draftLabel.trim(),
				body: draftBody.trim(),
				subkind: draftSubkind
			});
			editing = false;
		});
	}
</script>

<!-- Keyed on the node so switching nodes replays the fade, which is what makes
     following a connection feel like moving rather than a caption swap. -->
{#key node.id}
<div class="flex flex-col h-full min-h-0 memory-inspector">
	<div class="flex-1 min-h-0 overflow-y-auto">
		<!-- Identity. Navigation shares this row rather than getting a bar of its
		     own: a strip holding three small icons and nothing else was mostly empty
		     space at the top of an already narrow panel. -->
		<div class="px-4 pt-3 pb-3">
			<div class="flex items-center gap-2 mb-2">
				<Icon
					name={isMemory ? 'lucide:lightbulb' : 'lucide:file-code'}
					class="w-3.5 h-3.5 shrink-0 {isMemory ? 'text-violet-500' : 'text-slate-400'}"
				/>
				<span class="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
					{node.subkind}
				</span>
				{#if node.projectId === null}
					<span class="text-[10px] text-slate-400 dark:text-slate-500">· all projects</span>
				{/if}
				{#if node.archivedAt}
					<span class="text-[10px] text-amber-600 dark:text-amber-400">· forgotten</span>
				{/if}
				<!--
					Superseded and stale are different claims and the wording keeps them
					apart: one says this was replaced by a newer belief, the other says the
					code it describes has moved on. Neither means the memory is wrong.
				-->
				{#if node.supersededBy}
					<span class="text-[10px] text-slate-400 dark:text-slate-500">· replaced</span>
				{:else if node.staleAt}
					<span class="text-[10px] text-amber-600 dark:text-amber-400">· code changed since</span>
				{/if}
				{#if node.usefulCount > 0}
					<span class="text-[10px] text-emerald-600 dark:text-emerald-400">
						· used {node.usefulCount}×
					</span>
				{/if}

				<div class="ml-auto flex items-center gap-0.5 -mr-1">
					<button
						onclick={onBack}
						disabled={!canGoBack}
						class="flex p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200
						       hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors
						       disabled:opacity-25 disabled:hover:bg-transparent"
						aria-label="Back"
						title="Back"
					>
						<Icon name="lucide:chevron-left" class="w-3.5 h-3.5" />
					</button>
					<button
						onclick={onForward}
						disabled={!canGoForward}
						class="flex p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200
						       hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors
						       disabled:opacity-25 disabled:hover:bg-transparent"
						aria-label="Forward"
						title="Forward"
					>
						<Icon name="lucide:chevron-right" class="w-3.5 h-3.5" />
					</button>
					<button
						onclick={onClose}
						class="flex p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200
						       hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
						aria-label="Close details"
					>
						<Icon name="lucide:x" class="w-3.5 h-3.5" />
					</button>
				</div>
			</div>

			{#if editing}
				<input
					bind:value={draftLabel}
					class="w-full px-2.5 py-1.5 text-sm rounded-md bg-white dark:bg-slate-800 border
					       border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 outline-none
					       focus:border-violet-500"
				/>
			{:else}
				<h3 class="text-sm font-medium leading-snug text-slate-900 dark:text-slate-100 break-words">
					{node.label}
				</h3>
			{/if}
		</div>

		{#if error}
			<div class="mx-4 mb-3 px-2.5 py-1.5 rounded-md bg-red-50 dark:bg-red-900/20 text-[11px] text-red-600 dark:text-red-400">
				{error}
			</div>
		{/if}

		<!-- Content -->
		<div class="px-4 pb-4 space-y-3">
			{#if editing}
				<textarea
					bind:value={draftBody}
					rows="6"
					placeholder="Why is this true? What does it rule out?"
					class="w-full px-2.5 py-2 text-xs leading-relaxed rounded-md bg-white dark:bg-slate-800 border
					       border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 outline-none
					       focus:border-violet-500 resize-y"
				></textarea>

				<select
					bind:value={draftSubkind}
					class="w-full px-2.5 py-1.5 text-xs rounded-md bg-white dark:bg-slate-800 border border-slate-200
					       dark:border-slate-700 text-slate-700 dark:text-slate-200 outline-none"
				>
					{#each SUBKINDS as subkind (subkind)}
						<option value={subkind}>{subkind}</option>
					{/each}
				</select>

				<div class="flex items-center gap-2 pt-0.5">
					<button
						onclick={save}
						disabled={busy}
						class="px-3 py-1.5 text-xs font-medium rounded-md bg-violet-600 hover:bg-violet-700 text-white
						       disabled:opacity-50"
					>
						Save
					</button>
					<button
						onclick={() => { editing = false; }}
						disabled={busy}
						class="px-3 py-1.5 text-xs rounded-md text-slate-500 dark:text-slate-400
						       hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
					>
						Cancel
					</button>
				</div>
			{:else}
				{#if bodyText}
					<p class="text-xs leading-relaxed text-slate-600 dark:text-slate-300 whitespace-pre-wrap break-words">
						{bodyText}
					</p>
				{/if}

				{#if node.path}
					<p class="text-[11px] font-mono text-slate-500 dark:text-slate-400 break-all bg-slate-50
					          dark:bg-slate-800/60 rounded-md px-2 py-1.5">
						{node.path}
					</p>
				{/if}

				<p class="text-[10px] text-slate-400 dark:text-slate-500">
					{new Date(node.createdAt).toLocaleDateString(undefined, {
						day: 'numeric',
						month: 'short',
						year: 'numeric'
					})}
				</p>
			{/if}
		</div>

		<!-- Connections -->
		{#if detail.neighbours.length > 0}
			<div class="border-t border-slate-200 dark:border-slate-800">
				{#each [{ title: 'Memories', items: memories }, { title: 'Code', items: code }] as group (group.title)}
					{#if group.items.length > 0}
						<div class="px-4 py-3">
							<p class="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-1.5">
								{group.title} · {group.items.length}
							</p>
							<ul class="space-y-0.5">
								{#each group.items as neighbour (neighbour.node.id)}
									<li>
										<button
											onclick={() => onSelect(neighbour.node.id)}
											class="w-full text-left px-2 py-1.5 -mx-2 rounded-md text-[11px] leading-snug
											       text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800
											       transition-colors break-words"
										>
											{neighbour.node.label}
										</button>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
				{/each}
			</div>
		{/if}
	</div>

	<!-- Actions pinned to the bottom, so they do not float mid-panel. -->
	{#if canEdit && !editing}
		<div class="flex items-center gap-1.5 px-4 py-2.5 border-t border-slate-200 dark:border-slate-800">
			{#if isMemory}
				<button
					onclick={beginEdit}
					disabled={busy}
					class="px-3 py-1.5 text-[11px] font-medium rounded-md border
					       border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800
					       text-slate-700 dark:text-slate-200
					       hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
				>
					Edit
				</button>
			{/if}
			{#if node.archivedAt || node.supersededBy}
				<button
					onclick={() => run(async () => void (await memoryGraphStore.restoreNodes([node.id])))}
					disabled={busy}
					class="px-3 py-1.5 text-[11px] font-medium rounded-md border
					       border-violet-200 dark:border-violet-500/30 bg-violet-50 dark:bg-violet-500/10
					       text-violet-700 dark:text-violet-300
					       hover:bg-violet-100 dark:hover:bg-violet-500/20 transition-colors disabled:opacity-50"
				>
					Remember again
				</button>
			{:else}
				<button
					onclick={() => run(() => memoryGraphStore.archiveNode(node.id))}
					disabled={busy}
					class="ml-auto px-3 py-1.5 text-[11px] font-medium rounded-md border
					       border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800
					       text-slate-600 dark:text-slate-300
					       hover:border-red-200 dark:hover:border-red-500/30
					       hover:bg-red-50 dark:hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400
					       transition-colors disabled:opacity-50"
					title="Stop using this memory. Reversible."
				>
					Forget
				</button>
			{/if}
		</div>
	{/if}
</div>
{/key}

<style>
	.memory-inspector {
		animation: memory-inspector-in 0.18s ease-out;
	}

	@keyframes memory-inspector-in {
		from {
			opacity: 0;
			transform: translateX(6px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}
</style>
