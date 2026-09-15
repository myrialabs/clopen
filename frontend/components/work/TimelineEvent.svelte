<script lang="ts">
	/**
	 * One non-comment entry in the thread: a label added, a reference made, a
	 * closure.
	 *
	 * Rendered as a single line on the rail rather than as a card, which is what
	 * the providers do and for a good reason — these are context, and giving
	 * them the same visual weight as a comment makes the comments harder to find.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { WorkItemEvent } from '$shared/types/work';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		event: WorkItemEvent;
		/** Provider web root, so an actor's name links to their profile. */
		webRoot: string | null;
	}

	const { event, webRoot }: Props = $props();

	const look = $derived.by((): { icon: IconName; tone: string; verb: string } => {
		switch (event.kind) {
			case 'labeled':
				return { icon: 'lucide:tag', tone: 'text-slate-500', verb: 'added the label' };
			case 'unlabeled':
				return { icon: 'lucide:tag', tone: 'text-slate-500', verb: 'removed the label' };
			case 'assigned':
				return { icon: 'lucide:user-plus', tone: 'text-slate-500', verb: 'assigned' };
			case 'unassigned':
				return { icon: 'lucide:user-minus', tone: 'text-slate-500', verb: 'unassigned' };
			case 'renamed':
				return { icon: 'lucide:pencil', tone: 'text-slate-500', verb: 'renamed this to' };
			case 'referenced':
				return { icon: 'lucide:git-commit-horizontal', tone: 'text-slate-500', verb: 'referenced this' };
			case 'cross-referenced':
				return { icon: 'lucide:external-link', tone: 'text-violet-500', verb: 'mentioned this in' };
			case 'closed':
				return { icon: 'lucide:circle-check', tone: 'text-violet-500', verb: 'closed this' };
			case 'reopened':
				return { icon: 'lucide:circle-dot', tone: 'text-green-600 dark:text-green-400', verb: 'reopened this' };
			case 'merged':
				return { icon: 'lucide:git-merge', tone: 'text-violet-500', verb: 'merged this' };
			default:
				return { icon: 'lucide:eye', tone: 'text-slate-500', verb: 'requested a review from' };
		}
	});

	const actorUrl = $derived(event.actor && webRoot ? `${webRoot}/${event.actor}` : null);
</script>

<!--
	The dot sits in the rail's gutter, which the parent reserves with `pl-7`. It
	is placed by ONE number (-left-7, the width of that gutter) rather than by a
	negative margin plus a half-width translate — the old pair drew the dot half
	a centimetre to the left of the line it was supposed to be sitting on.
-->
<div class="relative py-0.5">
	<span class="absolute -left-7 top-0 flex items-center justify-center w-5 h-5 rounded-full bg-slate-100 dark:bg-slate-800 border-2 border-white dark:border-slate-900 {look.tone}">
		<Icon name={look.icon} class="w-2.5 h-2.5" />
	</span>

	<p class="flex items-center gap-1 flex-wrap m-0 text-xs text-slate-500 dark:text-slate-400">
		{#if event.actor}
			{#if actorUrl}
				<a
					href={actorUrl}
					target="_blank"
					rel="noreferrer noopener"
					class="font-medium text-slate-700 dark:text-slate-300 no-underline hover:text-violet-600 dark:hover:text-violet-400 hover:underline"
				>
					{event.actor}
				</a>
			{:else}
				<span class="font-medium text-slate-700 dark:text-slate-300">{event.actor}</span>
			{/if}
		{/if}

		<span>{look.verb}</span>

		{#if event.referenceUrl}
			<a
				href={event.referenceUrl}
				target="_blank"
				rel="noreferrer noopener"
				class="text-violet-600 dark:text-violet-400 no-underline hover:underline"
			>
				{event.referenceTitle}
				{#if event.referenceIdentifier}<span class="text-slate-400">#{event.referenceIdentifier}</span>{/if}
			</a>
		{:else if event.subject}
			<span class="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
				{event.subject}
			</span>
		{/if}

		{#if event.createdAt}
			<span class="text-slate-400 dark:text-slate-600" title={new Date(event.createdAt).toLocaleString()}>
				· {new Date(event.createdAt).toLocaleDateString()}
			</span>
		{/if}
	</p>
</div>
