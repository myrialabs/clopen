<script lang="ts">
	import ToolInstallCard from './ToolInstallCard.svelte';
	import PiInfoCard from './PiInfoCard.svelte';

	interface Props {
		showHeader?: boolean;
	}

	const { showHeader = true }: Props = $props();
</script>

<div class="space-y-6">
	{#if showHeader}
		<div>
			<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">System Tools</h3>
			<p class="text-sm text-slate-600 dark:text-slate-500">
				Install binaries clopen depends on, directly on the server.
			</p>
		</div>
	{/if}

	<!-- Engines -->
	<section class="space-y-3">
		<h4 class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Engines</h4>
		<div class="space-y-3">
			<ToolInstallCard
				tool="claude"
				title="Claude Code"
				description="Used by clopen to run the Claude Code engine."
			/>

			<ToolInstallCard
				tool="opencode"
				title="OpenCode"
				description="Used by clopen to run the OpenCode engine."
			/>

			<ToolInstallCard
				tool="copilot"
				title="GitHub Copilot CLI"
				description="Used by clopen to run the GitHub Copilot engine."
			/>

			<ToolInstallCard
				tool="codex"
				title="Codex CLI"
				description="Used by clopen to run the OpenAI Codex engine."
			/>

			<ToolInstallCard
				tool="qwen"
				title="Qwen Code CLI"
				description="Used by clopen to run the Qwen Code engine."
			/>

			<PiInfoCard />
		</div>
	</section>

	<!-- Utilities -->
	<section class="space-y-3">
		<h4 class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Utilities</h4>
		<div class="space-y-3">
			<ToolInstallCard
				tool="git"
				title="Git"
				description="Used by clopen for source control and project syncing."
			/>

			<ToolInstallCard
				tool="chrome"
				title="Chrome"
				description="Used by clopen to render the browser preview."
			/>
		</div>
	</section>
</div>
