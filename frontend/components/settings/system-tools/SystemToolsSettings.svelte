<script lang="ts">
	import ToolInstallCard from './ToolInstallCard.svelte';

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

	<ToolInstallCard
		tool="git"
		title="Git"
		description="Used by clopen for source control and project syncing."
	/>

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
		tool="chrome"
		title="Chrome"
		description="Used by clopen to render the browser preview."
	/>

	<ToolInstallCard
		tool="cloudflared"
		title="Cloudflared"
		description="Used by clopen to expose local dev servers via Public Tunnel."
	/>
</div>
