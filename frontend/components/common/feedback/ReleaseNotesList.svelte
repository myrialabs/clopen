<script lang="ts">
	import Markdown from '../display/Markdown.svelte';
	import Icon from '../display/Icon.svelte';

	interface ReleaseNote {
		tag_name: string;
		body: string;
		html_url: string;
		published_at: string;
	}

	interface Props {
		releases: ReleaseNote[];
		/** How many releases (from the top) start expanded. The rest collapse into an accordion. Default 1. */
		defaultExpandedCount?: number;
	}

	const { releases, defaultExpandedCount = 1 }: Props = $props();

	let expanded = $state(new Set<string>());

	// Seed which entries start expanded whenever the release list itself changes
	// (new fetch, different version list) — not on every unrelated re-render.
	$effect(() => {
		expanded = new Set(releases.slice(0, defaultExpandedCount).map(r => r.tag_name));
	});

	function toggle(tag_name: string) {
		if (expanded.has(tag_name)) {
			expanded.delete(tag_name);
		} else {
			expanded.add(tag_name);
		}
		expanded = new Set(expanded);
	}

	function formatDate(published_at: string): string {
		return new Date(published_at).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}
</script>

<div class="flex flex-col divide-y divide-slate-200 dark:divide-slate-700">
	{#each releases as release (release.tag_name)}
		<div class="py-3 first:pt-0 last:pb-0">
			<button
				type="button"
				onclick={() => toggle(release.tag_name)}
				aria-expanded={expanded.has(release.tag_name)}
				class="flex items-center justify-between gap-2 w-full text-left cursor-pointer"
			>
				<div class="flex items-center gap-2">
					<span class="text-sm font-semibold text-slate-900 dark:text-slate-100">{release.tag_name}</span>
					<span class="text-xs text-slate-500 dark:text-slate-500">{formatDate(release.published_at)}</span>
				</div>
				<Icon
					name={expanded.has(release.tag_name) ? 'lucide:chevron-up' : 'lucide:chevron-down'}
					class="w-4 h-4 text-slate-500 shrink-0"
				/>
			</button>

			{#if expanded.has(release.tag_name)}
				<div class="mt-2 release-notes-body">
					<Markdown variant="compact" content={release.body} />
					<div class="mt-2">
						<a
							href={release.html_url}
							target="_blank"
							rel="noopener noreferrer"
							class="inline-flex items-center gap-1.5 text-sm font-semibold text-violet-600 dark:text-violet-400 hover:underline"
						>
							<Icon name="lucide:external-link" class="w-4 h-4" />
							View on GitHub
						</a>
					</div>
				</div>
			{/if}
		</div>
	{/each}
</div>

<style>
	/* Bump the shared "compact" markdown size up a notch for release notes specifically —
	   scoped here so it doesn't affect the other compact-variant consumer (McpSettings).
	   Headings (e.g. GitHub's auto-generated "## What's Changed") inherit the same size
	   as the body/list text instead of getting their own larger size — a release note's
	   section label shouldn't look bigger than the entries listed under it. */
	.release-notes-body :global(.markdown-compact) {
		font-size: 0.875rem;
		line-height: 1.65;
	}
	.release-notes-body :global(.markdown-compact code) {
		font-size: 0.8125rem;
	}
	.release-notes-body :global(.markdown-compact h1),
	.release-notes-body :global(.markdown-compact h2),
	.release-notes-body :global(.markdown-compact h3) {
		font-size: inherit !important;
	}
</style>
