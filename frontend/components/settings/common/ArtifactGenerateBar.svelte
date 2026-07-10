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
		} catch (e) {
			error = e instanceof Error ? e.message : 'Generation failed';
		} finally {
			generating = false;
		}
	}
</script>

<div class="p-3 rounded-lg border border-violet-500/20 bg-gradient-to-br from-violet-500/5 to-purple-500/5 space-y-2.5">
	<div class="flex items-center gap-1.5 text-xs font-semibold text-violet-600 dark:text-violet-400">
		<Icon name="lucide:sparkles" class="w-3.5 h-3.5" />
		Generate with AI
	</div>
	<div class="space-y-1.5">
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
		<div class="flex items-start justify-between gap-3">
			<div class="text-[11px] text-slate-400 leading-relaxed">
				<p>Fills the fields below — review before saving.</p>
				<p>
					Uses the model set in
					{#if onNavigateArtifacts}
						<button type="button" class="text-violet-600 dark:text-violet-400 hover:underline cursor-pointer font-medium" onclick={onNavigateArtifacts}>
							Settings &rarr; Models &rarr; Artifacts
						</button>.
					{:else}
						Settings &rarr; Models &rarr; Artifacts.
					{/if}
				</p>
			</div>
			<Button variant="primary" size="sm" class="gap-1.5 shrink-0" loading={generating} disabled={generating || !purpose.trim()} onclick={run}>
					{#if !generating}
						<Icon name="lucide:wand-sparkles" class="w-4 h-4" />
					{/if}
					Generate
				</Button>
		</div>
	</div>
</div>
