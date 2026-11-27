<script lang="ts">
	/**
	 * Clopen releases as a user reads them: per version, the changes grouped into
	 * New / Improved / Fixed / Other, each with its area and pull-request number.
	 * The parsing happens on the backend (backend/update/release-notes.ts); this
	 * only lays it out.
	 *
	 * `collapsible` is for the long history in Settings, where only the newest
	 * entry starts open. The What's new dialog shows just the releases the user
	 * is getting, so there everything is open.
	 */
	import Markdown from '../display/Markdown.svelte';
	import Icon from '../display/Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import type { ReleaseChange, ReleaseChangeKind, ReleaseNote } from '$shared/types/release-notes';
	import { compareVersions } from '$shared/utils/semver';

	interface Props {
		releases: ReleaseNote[];
		/** Marks this version "Installed" and anything newer "New". */
		currentVersion?: string;
		collapsible?: boolean;
		/** With `collapsible`, how many releases from the top start open. */
		defaultExpandedCount?: number;
	}

	const { releases, currentVersion, collapsible = false, defaultExpandedCount = 1 }: Props = $props();

	const GROUPS: Array<{ kind: ReleaseChangeKind; label: string; icon: IconName; tone: string }> = [
		{ kind: 'feature', label: 'New', icon: 'lucide:sparkles', tone: 'text-violet-600 dark:text-violet-400' },
		{ kind: 'improvement', label: 'Improved', icon: 'lucide:gauge', tone: 'text-sky-600 dark:text-sky-400' },
		{ kind: 'fix', label: 'Fixed', icon: 'lucide:wrench', tone: 'text-emerald-600 dark:text-emerald-400' },
		{ kind: 'other', label: 'Other changes', icon: 'lucide:package', tone: 'text-slate-500 dark:text-slate-400' }
	];

	let expanded = $state(new Set<string>());

	// Keyed on which releases are at the top, not on the array: "Show older
	// releases" hands over a longer list with the same top, and re-seeding then
	// would close whatever the user had opened.
	const seedKey = $derived(releases.slice(0, defaultExpandedCount).map(release => release.tagName).join(','));
	$effect(() => {
		expanded = new Set(seedKey ? seedKey.split(',') : []);
	});

	function isOpen(tagName: string): boolean {
		return !collapsible || expanded.has(tagName);
	}

	function toggle(tagName: string) {
		const next = new Set(expanded);
		if (next.has(tagName)) next.delete(tagName);
		else next.add(tagName);
		expanded = next;
	}

	function changesOf(release: ReleaseNote, kind: ReleaseChangeKind): ReleaseChange[] {
		return release.changes.filter(change => change.kind === kind);
	}

	function status(release: ReleaseNote): 'installed' | 'new' | null {
		if (!currentVersion) return null;
		const order = compareVersions(release.version, currentVersion);
		if (order === 0) return 'installed';
		return order > 0 ? 'new' : null;
	}

	function formatDate(publishedAt: string): string {
		if (!publishedAt) return '';
		return new Date(publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	}
</script>

{#snippet releaseHeader(release: ReleaseNote)}
	{@const state = status(release)}
	<div class="flex items-center gap-2 min-w-0">
		<span class="text-sm font-bold text-slate-900 dark:text-slate-100">v{release.version}</span>
		<span class="text-xs text-slate-500">{formatDate(release.publishedAt)}</span>
		{#if state === 'installed'}
			<span class="px-1.5 py-0.5 rounded text-2xs font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">Installed</span>
		{:else if state === 'new'}
			<span class="px-1.5 py-0.5 rounded text-2xs font-semibold bg-violet-500/10 text-violet-600 dark:text-violet-400">New</span>
		{/if}
	</div>
{/snippet}

<div class="flex flex-col divide-y divide-slate-200 dark:divide-slate-700/60">
	{#each releases as release (release.tagName)}
		<section class="py-3 first:pt-0 last:pb-0">
			<div class="flex items-center justify-between gap-2">
				{#if collapsible}
					<button
						type="button"
						onclick={() => toggle(release.tagName)}
						aria-expanded={isOpen(release.tagName)}
						class="flex items-center gap-1.5 flex-1 min-w-0 text-left cursor-pointer"
					>
						<Icon
							name={isOpen(release.tagName) ? 'lucide:chevron-down' : 'lucide:chevron-right'}
							class="w-4 h-4 text-slate-400 shrink-0"
						/>
						{@render releaseHeader(release)}
					</button>
				{:else}
					{@render releaseHeader(release)}
				{/if}
				<a
					href={release.url}
					target="_blank"
					rel="noopener noreferrer"
					class="shrink-0 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
					title="View v{release.version} on GitHub"
				>
					GitHub
					<Icon name="lucide:external-link" class="w-3 h-3" />
				</a>
			</div>

			{#if isOpen(release.tagName)}
				<div class="mt-2.5 flex flex-col gap-3 {collapsible ? 'pl-5.5' : ''}">
					{#each GROUPS as group (group.kind)}
						{@const changes = changesOf(release, group.kind)}
						{#if changes.length}
							<div>
								<div class="flex items-center gap-1.5 mb-1 text-xs font-semibold {group.tone}">
									<Icon name={group.icon} class="w-3.5 h-3.5" />
									{group.label}
								</div>
								<ul class="flex flex-col gap-1">
									{#each changes as change, index (index)}
										<li class="flex items-start gap-2 text-sm leading-snug {group.kind === 'other' ? 'text-slate-500 dark:text-slate-400' : 'text-slate-700 dark:text-slate-300'}">
											<span class="w-1 h-1 mt-2 rounded-full bg-current opacity-50 shrink-0"></span>
											<span class="flex-1 min-w-0">
												{#if change.breaking}
													<span class="mr-1 px-1 py-px rounded text-2xs font-semibold bg-red-500/10 text-red-600 dark:text-red-400 align-middle">Breaking</span>
												{/if}
												{change.summary}
												{#if change.scope}
													<span class="ml-1 text-xs text-slate-400 dark:text-slate-500">{change.scope}</span>
												{/if}
											</span>
											{#if change.pullUrl}
												<a
													href={change.pullUrl}
													target="_blank"
													rel="noopener noreferrer"
													class="shrink-0 font-mono text-xs text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
												>
													#{change.pullNumber}
												</a>
											{/if}
										</li>
									{/each}
								</ul>
							</div>
						{/if}
					{/each}

					{#if release.notes}
						<div class="release-notes-body">
							<Markdown variant="compact" content={release.notes} />
						</div>
					{/if}

					{#if release.newContributors.length}
						<p class="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
							<Icon name="lucide:party-popper" class="w-3.5 h-3.5 text-amber-500" />
							First contribution from {release.newContributors.map(login => `@${login}`).join(', ')}
						</p>
					{/if}

					{#if !release.changes.length && !release.notes}
						<p class="text-xs text-slate-500">No notes for this release.</p>
					{/if}
				</div>
			{/if}
		</section>
	{/each}
</div>

<style>
	/* Headings in hand-written notes stay at body size: a section label should
	   not look bigger than the changes listed beside it. */
	.release-notes-body :global(.markdown-compact) {
		font-size: 0.875rem;
		line-height: 1.6;
	}
	.release-notes-body :global(.markdown-compact h1),
	.release-notes-body :global(.markdown-compact h2),
	.release-notes-body :global(.markdown-compact h3) {
		font-size: inherit !important;
	}
</style>
