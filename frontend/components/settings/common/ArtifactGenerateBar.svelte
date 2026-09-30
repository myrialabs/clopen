<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import { generateArtifactDraft, type GeneratableArtifactType } from '$frontend/utils/artifact-generate';

	interface Props {
		artifactType: GeneratableArtifactType;
		placeholder?: string;
		/** Called with the generated fields (shape depends on artifactType). */
		onGenerated: (fields: Record<string, unknown>) => void;
		/** Invoked when the "Settings → Models → Artifacts" link is clicked. */
		onNavigateArtifacts?: () => void;
	}

	const { artifactType, placeholder = 'Describe what you want, e.g. "review a PR for security issues"', onGenerated, onNavigateArtifacts }: Props = $props();

	// Collapsed to a single button until asked for — most edits are by hand, and
	// an always-open prompt box pushed the actual fields down the dialog.
	let open = $state(false);
	let purpose = $state('');
	let generating = $state(false);
	let error = $state<string | null>(null);

	async function run() {
		if (!purpose.trim()) return;
		generating = true;
		error = null;
		try {
			const fields = await generateArtifactDraft(artifactType, purpose);
			onGenerated(fields);
			purpose = '';
			open = false;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Generation failed';
		} finally {
			generating = false;
		}
	}
</script>

{#if !open}
	<button
		type="button"
		onclick={() => (open = true)}
		class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-violet-600 dark:text-violet-400 bg-violet-500/10 hover:bg-violet-500/15 transition-colors"
	>
		<Icon name="lucide:sparkles" class="w-3.5 h-3.5" />
		Generate with AI
	</button>
{:else}
	<div class="p-3 rounded-lg border border-violet-500/20 bg-violet-500/5 space-y-2">
		<div class="flex items-center justify-between">
			<span class="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-600 dark:text-violet-400">
				<Icon name="lucide:sparkles" class="w-3.5 h-3.5" />
				Generate with AI
			</span>
			<button type="button" onclick={() => (open = false)} class="flex p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-300" aria-label="Close">
				<Icon name="lucide:x" class="w-3.5 h-3.5" />
			</button>
		</div>
		<textarea
			bind:value={purpose}
			rows="2"
			{placeholder}
			disabled={generating}
			onkeydown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } }}
			class="w-full px-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400 resize-y disabled:opacity-50"
		></textarea>
		{#if error}
			<p class="text-xs text-red-500">{error}</p>
		{/if}
		<div class="flex items-center justify-between gap-3">
			<p class="text-[11px] text-slate-400">
				Model:
				{#if onNavigateArtifacts}
					<button type="button" class="text-violet-600 dark:text-violet-400 hover:underline font-medium" onclick={onNavigateArtifacts}>Models &rarr; Artifacts</button>
				{:else}
					Models &rarr; Artifacts
				{/if}
			</p>
			<Button variant="primary" size="sm" class="gap-1.5 shrink-0" loading={generating} disabled={generating || !purpose.trim()} onclick={run}>
				{#if !generating}
					<Icon name="lucide:wand-sparkles" class="w-4 h-4" />
				{/if}
				Generate
			</Button>
		</div>
	</div>
{/if}
