<script lang="ts">
	/**
	 * One comment, with the two things you can do to your own.
	 *
	 * Edit and delete are only rendered when the SERVER said they are allowed
	 * (`canModify`, computed from authorship plus repository write access).
	 * Rendering them optimistically and letting the provider refuse produces a
	 * menu whose entries are a coin toss.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Markdown from '$frontend/components/common/display/Markdown.svelte';
	import MarkdownComposer from './MarkdownComposer.svelte';
	import MenuSurface from './MenuSurface.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import { showInfo } from '$frontend/stores/ui/notification.svelte';
	import { copyText } from '$frontend/utils/clipboard';
	import type { WorkItemComment } from '$shared/types/work';

	interface Props {
		comment: WorkItemComment;
		/** Where the author's profile lives, so their name is a real link. */
		authorUrl?: string;
		onSave: (body: string) => Promise<boolean>;
		/** Omitted for the item body, which cannot be deleted on its own. */
		onDelete?: () => void;
	}

	const { comment, authorUrl, onSave, onDelete }: Props = $props();

	let editing = $state(false);
	let draft = $state('');
	let saving = $state(false);
	let menuOpen = $state(false);
	let confirming = $state(false);
	let deleting = $state(false);

	function beginEdit() {
		draft = comment.body;
		editing = true;
		menuOpen = false;
	}

	async function save() {
		if (!draft.trim()) return;
		saving = true;
		try {
			if (await onSave(draft)) editing = false;
		} finally {
			saving = false;
		}
	}

	/**
	 * Delete, and stay on screen until the provider has answered.
	 *
	 * The card used to close the confirmation and call `onDelete` without
	 * awaiting it, so a slow delete looked like nothing had happened — with the
	 * comment still there and the button still inviting a second press at a
	 * request that cannot be taken back.
	 */
	async function remove() {
		if (deleting) return;
		deleting = true;
		try {
			await onDelete?.();
		} finally {
			deleting = false;
			confirming = false;
		}
	}

	async function copyLink() {
		menuOpen = false;
		if (!comment.url) return;
		const ok = await copyText(comment.url);
		showInfo(ok ? 'Copied' : 'Could not copy', ok ? 'Link copied.' : 'The clipboard refused the request.');
	}

	/**
	 * The comment's markdown, and nothing else.
	 *
	 * An earlier version wrapped it in an attribution line and quoted every line
	 * with `>`, which is a CITATION of the comment. What people paste this into
	 * is an editor or another comment box, where a blockquote of someone else's
	 * name is never what they meant by "copy as markdown" — they wanted the
	 * source they are looking at. Attribution is what Copy link is for.
	 */
	async function copyMarkdown() {
		menuOpen = false;
		const ok = await copyText(comment.body);
		showInfo(ok ? 'Copied' : 'Could not copy', ok ? 'Markdown copied.' : 'The clipboard refused the request.');
	}
</script>

<article class="flex flex-col rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 overflow-hidden">
	<header class="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60">
		{#if authorUrl}
			<a
				href={authorUrl}
				target="_blank"
				rel="noreferrer noopener"
				class="text-xs font-semibold text-slate-800 dark:text-slate-200 no-underline hover:text-violet-600 dark:hover:text-violet-400 hover:underline"
			>
				{comment.author}
			</a>
		{:else}
			<span class="text-xs font-semibold text-slate-800 dark:text-slate-200">{comment.author}</span>
		{/if}
		<span class="text-xs text-slate-500 dark:text-slate-500">
			{new Date(comment.createdAt).toLocaleString()}
		</span>

		{#if comment.source === 'review-summary'}
			<span class="flex items-center gap-1 px-1.5 h-5 text-[0.65rem] rounded-full border border-violet-500/40 text-violet-600 dark:text-violet-400">
				<Icon name="lucide:git-pull-request-arrow" class="w-3 h-3" />
				review
			</span>
		{:else if comment.source === 'review'}
			<span class="flex items-center gap-1 px-1.5 h-5 text-[0.65rem] rounded-full border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400">
				<Icon name="lucide:file-text" class="w-3 h-3" />
				{comment.path}{comment.line ? `:${comment.line}` : ''}
			</span>
		{/if}

		<span class="flex-1"></span>

		<div class="relative" use:clickOutside={() => (menuOpen = false)}>
			<button
				type="button"
				class="flex items-center justify-center w-6 h-6 bg-transparent border-none rounded text-slate-500 cursor-pointer hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
				onclick={() => (menuOpen = !menuOpen)}
				aria-label="Comment actions"
			>
				<Icon name="lucide:ellipsis" class="w-3.5 h-3.5" />
			</button>

			{#if menuOpen}
				<MenuSurface width="w-48" class="py-1">
					<!-- Outside the link check: copying the source needs no URL. -->
					<button
						type="button"
						class="flex items-center gap-2 w-full px-3 h-8 text-xs bg-transparent border-none text-left text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-violet-500/10"
						onclick={copyMarkdown}
					>
						<Icon name="lucide:copy" class="w-3.5 h-3.5" />
						Copy as markdown
					</button>
					{#if comment.url}
						<button
							type="button"
							class="flex items-center gap-2 w-full px-3 h-8 text-xs bg-transparent border-none text-left text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-violet-500/10"
							onclick={copyLink}
						>
							<Icon name="lucide:link" class="w-3.5 h-3.5" />
							Copy link
						</button>
						<a
							href={comment.url}
							target="_blank"
							rel="noreferrer noopener"
							class="flex items-center gap-2 w-full px-3 h-8 text-xs text-left text-slate-700 dark:text-slate-300 no-underline hover:bg-violet-500/10"
							onclick={() => (menuOpen = false)}
						>
							<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
							Open in browser
						</a>
					{/if}
					{#if comment.canModify}
						<button
							type="button"
							class="flex items-center gap-2 w-full px-3 h-8 text-xs bg-transparent border-none text-left text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-violet-500/10"
							onclick={beginEdit}
						>
							<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
							Edit
						</button>
					{/if}
					{#if comment.canModify && onDelete}
						<button
							type="button"
							class="flex items-center gap-2 w-full px-3 h-8 text-xs bg-transparent border-none text-left text-red-600 dark:text-red-400 cursor-pointer hover:bg-red-500/10"
							onclick={() => {
								menuOpen = false;
								confirming = true;
							}}
						>
							<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
							Delete
						</button>
					{/if}
				</MenuSurface>
			{/if}
		</div>
	</header>

	{#if editing}
		<div class="flex flex-col gap-2 p-3">
			<MarkdownComposer
				value={draft}
				minRows={10}
				itemUrl={comment.url}
				onInput={(next) => (draft = next)}
				onSubmit={save}
			/>
			<div class="flex justify-end gap-2">
				<button
					type="button"
					class="h-8 px-3 text-xs font-medium bg-transparent border border-slate-300 dark:border-slate-600 rounded-md text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-violet-500/10"
					onclick={() => (editing = false)}
				>
					Cancel
				</button>
				<button
					type="button"
					class="flex items-center gap-1.5 h-8 px-3 text-xs font-semibold bg-violet-600 hover:bg-violet-700 border-none rounded-md text-white cursor-pointer disabled:opacity-50"
					disabled={saving || !draft.trim()}
					onclick={save}
				>
					{#if saving}
						<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
					{/if}
					Save
				</button>
			</div>
		</div>
	{:else if confirming}
		<div class="flex items-center gap-3 p-3">
			<p class="flex-1 text-xs text-slate-700 dark:text-slate-300 m-0">
				Delete this comment? It cannot be undone.
			</p>
			<button
				type="button"
				class="h-8 px-3 text-xs font-medium bg-transparent border border-slate-300 dark:border-slate-600 rounded-md text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-violet-500/10 disabled:opacity-50"
				disabled={deleting}
				onclick={() => (confirming = false)}
			>
				Keep
			</button>
			<button
				type="button"
				class="flex items-center gap-1.5 h-8 px-3 text-xs font-semibold bg-red-600 hover:bg-red-700 border-none rounded-md text-white cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
				disabled={deleting}
				onclick={remove}
			>
				{#if deleting}
					<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
				{/if}
				Delete
			</button>
		</div>
	{:else}
		<div class="px-3 py-2">
			{#if comment.body.trim()}
				<Markdown content={comment.body} variant="chat" />
			{:else}
				<p class="text-sm italic text-slate-500 dark:text-slate-500 m-0">Empty comment.</p>
			{/if}
		</div>
	{/if}
</article>
