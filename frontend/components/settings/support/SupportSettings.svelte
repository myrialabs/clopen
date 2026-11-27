<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import SupportPanel from '$frontend/components/common/support/SupportPanel.svelte';
	import { REPOSITORY_URL } from '$shared/constants/support';

	const OTHER_WAYS = [
		{
			icon: 'lucide:star',
			label: 'Star the repository',
			detail: 'Helps other people find Clopen',
			url: REPOSITORY_URL
		},
		{
			icon: 'lucide:message-square-warning',
			label: 'Report a bug or request a feature',
			detail: 'Tells us what to fix and build next',
			url: `${REPOSITORY_URL}/issues`
		}
	] as const;
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Support Clopen</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">
		Clopen is free and open source. Donations pay for the time that goes into new features, fixes and releases.
	</p>

	<div class="flex flex-col gap-5">
		<SupportPanel />

		<div>
			<div class="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-2">Other ways to help</div>
			<div class="flex flex-col rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 divide-y divide-slate-200 dark:divide-slate-700/50 overflow-hidden">
				{#each OTHER_WAYS as way (way.url)}
					<a
						href={way.url}
						target="_blank"
						rel="noopener noreferrer"
						class="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
					>
						<Icon name={way.icon} class="w-4 h-4 text-slate-500 shrink-0" />
						<div class="flex-1 min-w-0">
							<div class="text-sm font-medium text-slate-900 dark:text-slate-100">{way.label}</div>
							<div class="text-xs text-slate-600 dark:text-slate-500">{way.detail}</div>
						</div>
						<Icon name="lucide:external-link" class="w-3.5 h-3.5 text-slate-400 shrink-0" />
					</a>
				{/each}
			</div>
		</div>
	</div>
</div>
