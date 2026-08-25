<script lang="ts">
	import { onMount } from 'svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import ArtifactGenerateBar from '$frontend/components/settings/common/ArtifactGenerateBar.svelte';
	import { instructionsStore } from '$frontend/stores/features/instructions.svelte';
	import { setActiveSection } from '$frontend/stores/ui/settings-modal.svelte';

	interface Props {
		showHeader?: boolean;
	}

	const { showHeader = true }: Props = $props();

	let content = $state('');
	let enabled = $state(true);
	let loaded = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);
	let savedAt = $state<string | null>(null);

	onMount(async () => {
		const data = await instructionsStore.fetchGlobal();
		if (data) {
			content = data.content;
			enabled = data.enabled;
			savedAt = data.updatedAt;
		}
		loaded = true;
	});

	async function save() {
		saving = true;
		error = null;
		try {
			await instructionsStore.saveGlobal(content, enabled);
			savedAt = instructionsStore.global?.updatedAt ?? null;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Save failed';
		} finally {
			saving = false;
		}
	}
</script>

<div class="space-y-6">
	{#if showHeader}
		<div>
			<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Instructions</h3>
			<p class="text-sm text-slate-600 dark:text-slate-500">
				A shared instruction block injected into every engine's memory file.
			</p>
		</div>
	{/if}

	<ArtifactGenerateBar
		artifactType="instruction"
		placeholder={'Describe the instructions, e.g. "always answer concisely and prefer TypeScript"'}
		onNavigateArtifacts={() => setActiveSection('artifacts')}
		onGenerated={(f) => { if (typeof f.content === 'string') content = f.content; }}
	/>

	<div class="space-y-2">
		<div class="flex items-center justify-between">
			<label for="instructions-body" class="block text-sm font-semibold text-slate-700 dark:text-slate-300">Global instructions</label>
			<label class="inline-flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 cursor-pointer">
				<button
					type="button"
					role="switch"
					aria-checked={enabled}
					onclick={() => (enabled = !enabled)}
					class="relative w-9 h-5 rounded-full transition-colors {enabled ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-700'}"
					aria-label={enabled ? 'Disable instructions' : 'Enable instructions'}
				>
					<span class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform {enabled ? 'translate-x-4' : ''}"></span>
				</button>
				Enabled
			</label>
		</div>
		<textarea
			id="instructions-body"
			bind:value={content}
			rows="16"
			disabled={!loaded}
			placeholder={'e.g. Always respond concisely. Prefer TypeScript. Follow the project conventions in CONTRIBUTING.md.'}
			class="w-full px-3 py-2 text-sm font-mono bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400 resize-y disabled:opacity-50"
		></textarea>
	</div>

	{#if error}
		<p class="text-xs text-red-500">{error}</p>
	{/if}

	<div class="flex items-center justify-between">
		<p class="text-[11px] text-slate-400">
			{#if savedAt}Last saved {savedAt}{/if}
		</p>
		<Button variant="primary" loading={saving} disabled={!loaded} onclick={save}>Save</Button>
	</div>
</div>
