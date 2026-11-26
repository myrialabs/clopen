<script lang="ts">
	/**
	 * One work item.
	 *
	 * A pull request is split the way the providers split it — Conversation,
	 * Commits, Checks, Files changed — because those are four different
	 * questions and stacking them into one scroll makes each harder to answer.
	 * An issue has only a conversation, so it gets no tab strip at all rather
	 * than a strip with one entry in it.
	 *
	 * The composer is part of the SCROLL, not a docked footer. A footer pinned
	 * over the thread costs a strip of height on every screen including the ones
	 * where nobody is writing, and it puts the reply somewhere other than after
	 * the thing being replied to.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import MarkdownComposer from './MarkdownComposer.svelte';
	import CommentCard from './CommentCard.svelte';
	import CommitsList from './CommitsList.svelte';
	import FilesChanged from './FilesChanged.svelte';
	import ChecksList from './ChecksList.svelte';
	import MergeDialog from './MergeDialog.svelte';
	import MultiPicker from './MultiPicker.svelte';
	import StatePicker from './StatePicker.svelte';
	import MenuSurface from '$frontend/components/common/overlay/MenuSurface.svelte';
	import TimelineEvent from './TimelineEvent.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import { copyText } from '$frontend/utils/clipboard';
	import { showInfo } from '$frontend/stores/ui/notification.svelte';
	import { workStore, type DetailTab } from '$frontend/stores/features/work.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import type { WorkItemComment, WorkItemEvent } from '$shared/types/work';

	const detail = $derived(workStore.detail);
	const isLoading = $derived(workStore.isLoadingDetail);
	const states = $derived(workStore.states);
	const starting = $derived(workStore.startingId !== null);
	const source = $derived(workStore.source);
	const tab = $derived(workStore.detailTab);

	const isPullRequest = $derived(detail?.kind === 'pull-request');

	/**
	 * Comments and events as one thread, oldest first. Compared as instants,
	 * not strings: providers mix `Z` and offset timestamps, and an entry with
	 * no time sorts last rather than first.
	 */
	interface ThreadEntry {
		key: string;
		at: number;
		event?: WorkItemEvent;
		comment?: WorkItemComment;
	}

	const timeline = $derived.by((): ThreadEntry[] => {
		if (!detail) return [];
		const at = (value: string) => {
			const time = Date.parse(value);
			return Number.isNaN(time) ? Number.MAX_SAFE_INTEGER : time;
		};
		const entries: ThreadEntry[] = [
			...detail.events.map((event): ThreadEntry => ({ key: `e-${event.id}`, at: at(event.createdAt), event })),
			...detail.comments.map((comment): ThreadEntry => ({ key: `c-${comment.source}-${comment.id}`, at: at(comment.createdAt), comment }))
		];
		return entries.sort((a, b) => a.at - b.at);
	});

	/**
	 * The status badge.
	 *
	 * Colour AND glyph, because colour alone fails for the ~8% of men with a
	 * red-green deficiency, and because "Open" and "Closed" as bare grey pills
	 * are the same shape — the thing the eye lands on first has to differ.
	 */
	const stateBadge = $derived.by(() => {
		switch (detail?.stateCategory) {
			case 'merged':
				return {
					icon: 'lucide:git-merge' as IconName,
					class: 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/40'
				};
			case 'closed':
				return {
					icon: (isPullRequest ? 'lucide:git-pull-request-closed' : 'lucide:circle-check') as IconName,
					class: 'bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-400/40'
				};
			case 'draft':
				return {
					icon: 'lucide:git-pull-request-draft' as IconName,
					class: 'bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-400/40'
				};
			default:
				return {
					icon: (isPullRequest ? 'lucide:git-pull-request' : 'lucide:circle-dot') as IconName,
					class: 'bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/40'
				};
		}
	});
	const canMerge = $derived(
		isPullRequest &&
			source?.capabilities.merge === true &&
			detail?.mergeability?.merged === false &&
			detail?.stateCategory === 'open'
	);

	let commentDraft = $state('');
	let menuOpen = $state(false);
	let mergeOpen = $state(false);
	let editingTitle = $state(false);
	let titleDraft = $state('');
	let savingTitle = $state(false);

	/** The provider's web root, so a login becomes a profile link. */
	const webRoot = $derived.by(() => {
		if (!detail?.url) return null;
		try {
			return new URL(detail.url).origin;
		} catch {
			return null;
		}
	});

	function profileUrl(login: string | null | undefined): string | undefined {
		return login && webRoot ? `${webRoot}/${login}` : undefined;
	}

	/**
	 * The item's own body, rendered as the first card in the thread.
	 *
	 * Shaped as a comment because that is what it is to a reader, and doing so
	 * means the edit and copy affordances come from one component rather than
	 * being reimplemented for the row that happens to be first.
	 */
	const bodyAsComment = $derived(
		detail
			? {
				id: `item-${detail.id}`,
				author: detail.author ?? 'unknown',
				body: detail.body,
				createdAt: detail.createdAt,
				url: detail.url,
				source: 'conversation' as const,
				// Editable when the viewer wrote it, or has write access — the same
				// rule the server applies to comments.
				canModify:
					source?.capabilities.editTitle === true &&
					(detail.author === source?.viewer || detail.assignees.includes(source?.viewer ?? ''))
			}
			: null
	);

	function beginTitleEdit() {
		menuOpen = false;
		titleDraft = detail?.title ?? '';
		editingTitle = true;
	}

	async function saveTitle() {
		if (!titleDraft.trim()) return;
		savingTitle = true;
		try {
			if (await workStore.updateItem({ title: titleDraft })) editingTitle = false;
		} finally {
			savingTitle = false;
		}
	}

	const DETAIL_TABS: { id: DetailTab; label: string; icon: IconName }[] = [
		{ id: 'conversation', label: 'Conversation', icon: 'lucide:message-square' },
		{ id: 'commits', label: 'Commits', icon: 'lucide:git-commit-horizontal' },
		{ id: 'checks', label: 'Checks', icon: 'lucide:circle-check' },
		{ id: 'files', label: 'Files', icon: 'lucide:files' }
	];

	async function submitComment() {
		if (!commentDraft.trim()) return;
		if (await workStore.comment(commentDraft)) commentDraft = '';
	}

	async function copyLink() {
		menuOpen = false;
		if (!detail) return;
		const ok = await copyText(detail.url);
		showInfo(ok ? 'Copied' : 'Could not copy', ok ? detail.url : 'The clipboard refused the request.');
	}

</script>

{#if isLoading}
	<div class="flex items-center justify-center h-full">
		<Icon name="lucide:loader-circle" class="w-5 h-5 text-slate-400 animate-spin" />
	</div>
{:else if !detail}
	<div class="flex flex-col items-center justify-center gap-2 h-full px-6 text-center">
		<Icon name="lucide:circle-dot" class="w-8 h-8 text-slate-300 dark:text-slate-700" />
		<p class="text-sm text-slate-500 dark:text-slate-500 m-0">Pick something on the left</p>
	</div>
{:else}
	<!-- A container: this pane is as wide as the Git panel's right column, which
	     has nothing to do with the viewport, so its layout asks the pane. -->
	<div class="@container flex flex-col h-full min-h-0">
		<header class="flex flex-col gap-1.5 px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0">
			<div class="flex items-start gap-2">
				{#if editingTitle}
					<input
						type="text"
						class="flex-1 min-w-0 h-9 px-2.5 text-base font-semibold bg-white dark:bg-slate-800 border border-violet-500 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none"
						value={titleDraft}
						oninput={(event) => (titleDraft = event.currentTarget.value)}
						onkeydown={(event) => {
							if (event.key === 'Enter') saveTitle();
							if (event.key === 'Escape') editingTitle = false;
						}}
					/>
					<button
						type="button"
						class="flex items-center gap-1.5 h-9 shrink-0 px-3 text-xs font-semibold bg-violet-600 hover:bg-violet-700 border-none rounded-lg text-white cursor-pointer disabled:opacity-50"
						disabled={savingTitle || !titleDraft.trim()}
						onclick={saveTitle}
					>
						{#if savingTitle}
							<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
						{/if}
						Save
					</button>
					<button
						type="button"
						class="h-9 shrink-0 px-3 text-xs font-medium bg-transparent border border-slate-300 dark:border-slate-600 rounded-lg text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-violet-500/10"
						onclick={() => (editingTitle = false)}
					>
						Cancel
					</button>
				{:else}
					<h2 class="flex-1 min-w-0 text-sm @2xl:text-base font-semibold text-slate-900 dark:text-slate-100 m-0 leading-snug">
						{detail.title}
						<span class="font-normal text-slate-400 dark:text-slate-600">#{detail.identifier}</span>
					</h2>
				{/if}

				<div class="relative shrink-0" use:clickOutside={() => (menuOpen = false)}>
					<button
						type="button"
						class="flex items-center justify-center w-8 h-8 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
						onclick={() => (menuOpen = !menuOpen)}
						aria-label="More actions"
					>
						<Icon name="lucide:ellipsis" class="w-4 h-4" />
					</button>

					{#if menuOpen}
						<MenuSurface width="w-48" class="py-1">
							{#if source?.capabilities.editTitle}
								<button
									type="button"
									class="flex items-center gap-2 w-full px-3 h-8 text-xs bg-transparent border-none text-left text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-violet-500/10"
									onclick={beginTitleEdit}
								>
									<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
									Edit title
								</button>
							{/if}
							<button
								type="button"
								class="flex items-center gap-2 w-full px-3 h-8 text-xs bg-transparent border-none text-left text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-violet-500/10"
								onclick={copyLink}
							>
								<Icon name="lucide:link" class="w-3.5 h-3.5" />
								Copy link
							</button>
							<a
								href={detail.url}
								target="_blank"
								rel="noreferrer noopener"
								class="flex items-center gap-2 w-full px-3 h-8 text-xs text-left text-slate-700 dark:text-slate-300 no-underline hover:bg-violet-500/10"
								onclick={() => (menuOpen = false)}
							>
								<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
								Open in browser
							</a>
						</MenuSurface>
					{/if}
				</div>
			</div>

			<!-- One wrapping row for who, where and what you can do. Three rows
			     of chrome made the header taller than the first comment. -->
			<div class="flex items-center gap-1.5 flex-wrap min-w-0 text-xs text-slate-500 dark:text-slate-400">
				<span class="flex items-center gap-1 h-6 px-2 shrink-0 font-medium rounded-full border capitalize {stateBadge.class}">
					<Icon name={stateBadge.icon} class="w-3 h-3" />
					{detail.state}
				</span>
				{#if detail.author}
					<a
						href={profileUrl(detail.author)}
						target="_blank"
						rel="noreferrer noopener"
						class="shrink-0 text-slate-600 dark:text-slate-300 no-underline hover:text-violet-600 dark:hover:text-violet-400"
					>
						{detail.author}
					</a>
				{/if}
				{#if detail.headBranch}
					<span class="min-w-0 max-w-[16rem] truncate font-mono" title="{detail.baseBranch} ← {detail.headBranch}">
						{detail.baseBranch} ← {detail.headBranch}
					</span>
				{/if}

				<span class="w-px h-4 mx-0.5 bg-slate-200 dark:bg-slate-700"></span>

				<!-- The slowest action here: it clones a worktree. It says so. -->
				<button
					type="button"
					class="flex items-center justify-center gap-1.5 h-7 px-2.5 text-xs font-semibold bg-violet-600 hover:bg-violet-700 border-none rounded-md text-white cursor-pointer transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
					disabled={starting}
					onclick={() => workStore.startWork(detail)}
				>
					{#if starting}
						<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
						Starting…
					{:else}
						<Icon name="lucide:play" class="w-3.5 h-3.5" />
						Start work
					{/if}
				</button>

				{#if canMerge}
					<button
						type="button"
						class="flex items-center gap-1.5 h-7 px-2.5 text-xs font-semibold bg-transparent border border-green-600/50 rounded-md text-green-700 dark:text-green-400 cursor-pointer transition-colors duration-150 hover:bg-green-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
						disabled={workStore.isMerging}
						onclick={() => (mergeOpen = true)}
					>
						<Icon name="lucide:git-merge" class="w-3.5 h-3.5" />
						Merge
					</button>
				{/if}

				{#if source?.capabilities.assign}
					<MultiPicker
						selected={detail.assignees}
						candidates={workStore.assignees}
						icon="lucide:user-plus"
						placeholder="Assign"
						noun="assignees"
						filterPlaceholder="Filter people…"
						emptyLabel="Nobody assignable here — the token may not have write access to this repository."
						load={() => workStore.loadAssignees()}
						onChange={(next) => workStore.setAssignees(next)}
					/>
				{/if}

				{#if source?.capabilities.labels}
					<MultiPicker
						selected={detail.labels}
						candidates={workStore.labels}
						icon="lucide:tag"
						placeholder="Labels"
						noun="labels"
						filterPlaceholder="Filter labels…"
						emptyLabel="This repository defines no labels."
						load={() => workStore.loadLabels()}
						onChange={(next) => workStore.setLabels(next)}
					/>
				{/if}

				{#if isPullRequest && source?.capabilities.reviewers}
					<MultiPicker
						selected={detail.reviewers ?? []}
						candidates={workStore.assignees}
						icon="lucide:eye"
						placeholder="Reviewers"
						noun="reviewers"
						filterPlaceholder="Filter people…"
						emptyLabel="Nobody to request — the token may not have write access to this repository."
						load={() => workStore.loadAssignees()}
						onChange={(next) => workStore.setReviewers(next)}
					/>
				{/if}

				{#if states.length > 0}
					<StatePicker options={states} current={detail.state} />
				{/if}
			</div>

			{#if isPullRequest}
				<div class="flex items-center gap-0.5 -mb-2.5 overflow-x-auto">
					{#each DETAIL_TABS as entry (entry.id)}
						<button
							type="button"
							class="flex items-center gap-1.5 h-8 px-2 text-xs font-medium rounded-t-md border-b-2 bg-transparent cursor-pointer transition-colors duration-150
								{tab === entry.id
								? 'border-violet-500 text-slate-900 dark:text-slate-100'
								: 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}"
							onclick={() => workStore.setDetailTab(entry.id)}
							title={entry.label}
						>
							<Icon name={entry.icon} class="w-3.5 h-3.5" />
							<span class="hidden @sm:inline">{entry.label}</span>
						</button>
					{/each}
				</div>
			{/if}
		</header>

		<!-- Only the conversation scrolls as one column. Every other tab is a
		     list beside a pane, and each brings its own scroll containers. -->
		<div class="flex-1 min-h-0 {isPullRequest && tab !== 'conversation'
			? 'overflow-hidden'
			: 'overflow-y-auto bg-slate-50 dark:bg-slate-950/50'}">
			{#if isPullRequest && tab === 'checks'}
				<ChecksList />
			{:else if isPullRequest && tab === 'files'}
				<!-- Full height: the diff has its own tree and its own scroll host. -->
				{#if workStore.isLoadingDetailTab}
					<div class="flex items-center justify-center py-8">
						<Icon name="lucide:loader-circle" class="w-5 h-5 text-slate-400 animate-spin" />
					</div>
				{:else}
					<FilesChanged />
				{/if}
			{:else if isPullRequest && tab === 'commits'}
				{#if workStore.isLoadingDetailTab}
					<div class="flex items-center justify-center py-8">
						<Icon name="lucide:loader-circle" class="w-5 h-5 text-slate-400 animate-spin" />
					</div>
				{:else}
					<CommitsList />
				{/if}
			{:else}
				<div class="flex flex-col gap-3 px-4 py-3">
					<!--
						A conversation is a sequence, and the provider draws it as
						one. The rail is ONE absolutely positioned line down a
						gutter the rows reserve with `pl-10`, and every dot is
						placed against that same gutter — so the line cannot drift
						away from the dots, and it cannot break into segments when
						a card is taller than expected. It also stops at the last
						entry: the composer is outside the rail, because nothing
						has happened there yet.
					-->
					<div class="relative flex flex-col gap-3 pl-10">
						<span
							class="absolute left-[0.8125rem] top-[1.25rem] bottom-0 w-0.5 rounded-full bg-slate-200 dark:bg-slate-700/70"
							aria-hidden="true"
						></span>

						{#if bodyAsComment}
							<div class="relative">
								<span class="absolute -left-10 top-1.5 flex items-center justify-center w-7 h-7 rounded-full bg-slate-100 dark:bg-slate-800 border-2 border-white dark:border-slate-900 text-slate-500 dark:text-slate-400">
									<Icon name="lucide:message-square" class="w-3.5 h-3.5" />
								</span>
								<!-- No onDelete: an item's body cannot be deleted on its own. -->
								<CommentCard
									comment={bodyAsComment}
									authorUrl={profileUrl(detail.author)}
									onSave={(body) => workStore.updateItem({ body })}
								/>
							</div>
						{/if}

						<!-- One sequence in time order. Events and comments used to be two
						     lists one after the other, so an assignment made today sat
						     above last week's comments. -->
						{#each timeline as entry (entry.key)}
							{#if entry.event}
								<TimelineEvent event={entry.event} webRoot={webRoot} />
							{:else if entry.comment}
								{@const comment = entry.comment}
								<div class="relative">
									<span class="absolute -left-10 top-1.5 flex items-center justify-center w-7 h-7 rounded-full bg-slate-100 dark:bg-slate-800 border-2 border-white dark:border-slate-900 text-slate-500 dark:text-slate-400">
										<Icon
											name={comment.source === 'review-summary'
												? 'lucide:git-pull-request-arrow'
												: comment.source === 'review'
													? 'lucide:file-text'
													: 'lucide:message-square'}
											class="w-3.5 h-3.5"
										/>
									</span>
									<CommentCard
										{comment}
										authorUrl={profileUrl(comment.author)}
										onSave={(body) => workStore.updateComment(comment, body)}
										onDelete={() => workStore.deleteComment(comment)}
									/>
								</div>
							{/if}
						{/each}
					</div>

					{#if source?.capabilities.comments}
						<!-- Part of the thread, right after what it replies to. -->
						<div class="flex flex-col gap-2 pt-1">
							<MarkdownComposer
								value={commentDraft}
								minRows={10}
								itemUrl={detail.url}
								onInput={(next) => (commentDraft = next)}
								onSubmit={submitComment}
							/>
							<div class="flex items-center justify-end gap-2">
								<span class="flex-1 text-xs text-slate-500 dark:text-slate-500">
									Markdown supported. {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to send.
								</span>
								<button
									type="button"
									class="flex items-center justify-center gap-1.5 h-8 px-3 text-xs font-semibold bg-violet-600 hover:bg-violet-700 border-none rounded-md text-white cursor-pointer transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
									disabled={workStore.isCommenting || !commentDraft.trim()}
									onclick={submitComment}
								>
									{#if workStore.isCommenting}
										<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
									{:else}
										<Icon name="lucide:send" class="w-3.5 h-3.5" />
									{/if}
									Comment
								</button>
							</div>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	</div>

	<MergeDialog bind:isOpen={mergeOpen} item={detail} onClose={() => (mergeOpen = false)} />
{/if}
