<script lang="ts">
	/**
	 * Open a pull request from a branch in this workspace.
	 *
	 * Two deliberate frictions, both because this publishes to a repository
	 * other people watch: the draft is always shown before it can be created,
	 * never generated and submitted in one action; and an existing open PR for
	 * the branch is surfaced instead of the form.
	 *
	 * An unpushed branch used to be a third — it stated the problem and sent the
	 * user to the Git panel. That is a correct instruction and a poor one: the
	 * branch is named right there, the destination is the one git already
	 * records, and the trip back costs whatever was typed into this form. So the
	 * warning carries the button. Pushing a branch that tracks nothing cannot
	 * overwrite anything, which is what made it safe to offer here and would not
	 * be true of a force push.
	 *
	 * The head is a CHOICE, not a reading of HEAD. A worktree is often left on
	 * the branch after the one you meant, and "check out the other branch, then
	 * come back" is a worse answer than a second dropdown. Picking one re-reads
	 * the whole context for it — commits, upstream, linked item — because a
	 * composer that lets you choose a head and keeps describing a different one
	 * is worse than one that never let you choose.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import MarkdownComposer from './MarkdownComposer.svelte';
	import { workStore } from '$frontend/stores/features/work.svelte';
	import { showError, showSuccess } from '$frontend/stores/ui/notification.svelte';
	import { debug } from '$shared/utils/logger';
	import type { PullRequestContext, WorkItem } from '$shared/types/work';

	interface Props {
		isOpen: boolean;
		accountId: string | null;
		onClose: () => void;
	}

	let { isOpen = $bindable(), accountId, onClose }: Props = $props();

	let context = $state<PullRequestContext | null>(null);
	let loadError = $state<string | null>(null);
	let isLoading = $state(false);
	let isSwitchingHead = $state(false);
	let isPushing = $state(false);
	let isDrafting = $state(false);
	let isCreating = $state(false);

	/** Any in-flight request. Every control is inert while one is. */
	const isBusy = $derived(isLoading || isSwitchingHead || isPushing || isDrafting || isCreating);

	let title = $state('');
	let body = $state('');
	let base = $state('');
	let asDraft = $state(false);
	let created = $state<WorkItem | null>(null);

	/**
	 * A branch cannot merge into itself.
	 *
	 * Reachable in one click now that both sides are dropdowns, and reachable
	 * without touching either when the worktree is sitting on the default
	 * branch. Said here rather than avoided by picking some other base on the
	 * user's behalf, which would propose a merge nobody asked for.
	 */
	const sameBranch = $derived(!!context && context.head === base);

	// Loaded on open rather than on mount: the branch, its commits and whether a
	// pull request already exists are all things that change while the modal is
	// closed.
	$effect(() => {
		if (!isOpen || !accountId) return;
		void load(accountId);
	});

	async function load(id: string) {
		isLoading = true;
		loadError = null;
		context = null;
		created = null;
		title = '';
		body = '';
		try {
			apply(await workStore.pullRequestContext(id));
		} catch (error) {
			debug.error('work', 'Could not build the pull request context:', error);
			loadError = error instanceof Error ? error.message : String(error);
		} finally {
			isLoading = false;
		}
	}

	/**
	 * Adopt a context, seeding the form only where the user has not typed.
	 *
	 * Switching head or pushing re-reads the context, and neither is a reason to
	 * discard a title someone wrote.
	 */
	function apply(result: PullRequestContext) {
		context = result;
		base = result.base;
		if (title.trim()) return;
		// A branch started from an issue gets a title to begin from, so the
		// common case is editing one line rather than writing from nothing.
		if (result.linkedItem) title = `Fix #${result.linkedItem.itemIdentifier}`;
		else if (result.commits.length === 1) title = result.commits[0].subject;
	}

	async function switchHead(head: string) {
		if (!accountId || !context || head === context.head) return;
		isSwitchingHead = true;
		try {
			apply(await workStore.pullRequestContext(accountId, head));
		} catch (error) {
			showError('Could not read that branch', error instanceof Error ? error.message : String(error));
		} finally {
			isSwitchingHead = false;
		}
	}

	async function push() {
		if (!accountId || !context) return;
		isPushing = true;
		try {
			apply(await workStore.pushPullRequestHead(accountId, context.head));
			showSuccess('Branch pushed', `${context.head} → ${context.pushRemote}`);
		} catch (error) {
			showError('Could not push the branch', error instanceof Error ? error.message : String(error));
		} finally {
			isPushing = false;
		}
	}

	async function draft() {
		if (!accountId || !context) return;
		isDrafting = true;
		try {
			const result = await workStore.draftPullRequest(accountId, base, context.head);
			title = result.title;
			body = result.body;
		} catch (error) {
			showError('Could not draft a description', error instanceof Error ? error.message : String(error));
		} finally {
			isDrafting = false;
		}
	}

	async function create() {
		if (!accountId || !context || !title.trim()) return;
		isCreating = true;
		try {
			created = await workStore.createPullRequest({
				accountId,
				title: title.trim(),
				body,
				base,
				head: context.head,
				isDraft: asDraft
			});
			showSuccess('Pull request opened', `#${created.identifier} ${created.title}`);
		} catch (error) {
			showError('Could not open the pull request', error instanceof Error ? error.message : String(error));
		} finally {
			isCreating = false;
		}
	}
</script>

<!--
	Closable except while the pull request is being created: that is the one
	action whose result the user needs to see, and the only one long enough that
	blocking the rest would trap them behind a 60-second push.
-->
<Modal bind:isOpen onClose={isCreating ? () => {} : onClose} title="Open a pull request" size="xl">
	{#snippet children()}
		{#if isLoading}
			<div class="flex items-center justify-center py-10">
				<Icon name="lucide:loader-circle" class="w-5 h-5 text-slate-400 animate-spin" />
			</div>
		{:else if loadError}
			<div class="flex flex-col items-center gap-2 py-8 text-center">
				<Icon name="lucide:triangle-alert" class="w-7 h-7 text-amber-500" />
				<p class="text-sm text-slate-700 dark:text-slate-300 m-0">{loadError}</p>
			</div>
		{:else if created}
			<div class="flex flex-col items-center gap-3 py-8 text-center">
				<Icon name="lucide:git-pull-request" class="w-8 h-8 text-green-600 dark:text-green-400" />
				<p class="text-sm text-slate-800 dark:text-slate-200 m-0">
					#{created.identifier} — {created.title}
				</p>
				<a
					href={created.url}
					target="_blank"
					rel="noreferrer noopener"
					class="text-sm text-violet-600 dark:text-violet-400"
				>
					Open it on the web
				</a>
			</div>
		{:else if context?.existing}
			<div class="flex flex-col items-center gap-3 py-8 text-center">
				<Icon name="lucide:git-pull-request" class="w-8 h-8 text-violet-500" />
				<p class="text-sm text-slate-700 dark:text-slate-300 m-0">
					This branch already has an open pull request.
				</p>
				<a
					href={context.existing.url}
					target="_blank"
					rel="noreferrer noopener"
					class="text-sm text-violet-600 dark:text-violet-400"
				>
					#{context.existing.identifier} — {context.existing.title}
				</a>
			</div>
		{:else if context}
			<div class="flex flex-col gap-4">
				<!--
					Branches and the drafter share the top row: "Draft with AI"
					fills BOTH fields below it, so sitting beside the Description
					label described half of what it does.
				-->
				<div class="flex items-center gap-2 flex-wrap text-xs">
					<span class="text-slate-500 dark:text-slate-400">Merge</span>
					<select
						class="max-w-[14rem] px-2 py-1 text-xs font-mono bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200 cursor-pointer focus:outline-none focus:border-violet-500 disabled:opacity-60 disabled:cursor-not-allowed"
						value={context.head}
						disabled={isBusy}
						onchange={(event) => switchHead(event.currentTarget.value)}
						aria-label="Branch to open the pull request from"
					>
						{#each context.headCandidates as candidate (candidate)}
							<option value={candidate}>{candidate}</option>
						{/each}
					</select>
					<span class="text-slate-500 dark:text-slate-400">into</span>
					<select
						class="max-w-[14rem] px-2 py-1 text-xs font-mono bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200 cursor-pointer focus:outline-none focus:border-violet-500 disabled:opacity-60 disabled:cursor-not-allowed"
						value={base}
						disabled={isBusy}
						onchange={(event) => (base = event.currentTarget.value)}
						aria-label="Branch to merge into"
					>
						{#each context.baseCandidates as candidate (candidate)}
							<option value={candidate}>{candidate}</option>
						{/each}
					</select>
					{#if isSwitchingHead}
						<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 text-slate-400 animate-spin" />
					{:else}
						<span class="text-slate-500 dark:text-slate-500">
							· {context.commits.length} commit{context.commits.length === 1 ? '' : 's'}
						</span>
					{/if}

					<span class="flex-1"></span>

					<button
						type="button"
						class="flex items-center gap-1.5 shrink-0 px-2 py-1 text-xs bg-transparent border border-slate-200 dark:border-slate-700 rounded-md text-slate-600 dark:text-slate-400 cursor-pointer hover:border-violet-500/50 hover:text-violet-600 dark:hover:text-violet-400 disabled:opacity-60 disabled:cursor-not-allowed"
						disabled={isBusy}
						onclick={draft}
					>
						{#if isDrafting}
							<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
							Drafting…
						{:else}
							<Icon name="lucide:sparkles" class="w-3.5 h-3.5" />
							Draft with AI
						{/if}
					</button>
				</div>

				{#if sameBranch}
					<div class="flex items-start gap-2 p-3 rounded-lg border border-amber-500/40 bg-amber-500/10">
						<Icon name="lucide:triangle-alert" class="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
						<p class="flex-1 text-xs text-amber-800 dark:text-amber-300 m-0">
							<strong class="font-semibold">{context.head}</strong> cannot merge into itself. Pick a
							different branch on one side.
						</p>
					</div>
				{:else if !context.isPushed}
					<div class="flex items-start gap-2 p-3 rounded-lg border border-amber-500/40 bg-amber-500/10">
						<Icon name="lucide:triangle-alert" class="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
						<p class="flex-1 text-xs text-amber-800 dark:text-amber-300 m-0">
							<strong class="font-semibold">{context.head}</strong> has no upstream yet — a pull
							request cannot be opened for a branch the remote has never seen.
						</p>
						<button
							type="button"
							class="flex items-center gap-1.5 shrink-0 h-7 px-2.5 text-xs font-semibold bg-amber-600 hover:bg-amber-700 border-none rounded-md text-white cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
							disabled={isBusy}
							onclick={push}
						>
							{#if isPushing}
								<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
								Pushing…
							{:else}
								<Icon name="lucide:upload" class="w-3.5 h-3.5" />
								Push to {context.pushRemote}
							{/if}
						</button>
					</div>
				{/if}

				{#if context.linkedItem}
					<p class="text-xs text-slate-500 dark:text-slate-400 m-0">
						Started from #{context.linkedItem.itemIdentifier}. Reference it in the body to close it
						on merge.
					</p>
				{/if}

				<label class="flex flex-col gap-1.5">
					<span class="text-xs font-medium text-slate-700 dark:text-slate-300">Title</span>
					<input
						type="text"
						class="w-full px-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500 disabled:opacity-60"
						value={title}
						disabled={isBusy}
						oninput={(event) => (title = event.currentTarget.value)}
						placeholder="What this change does"
					/>
				</label>

				<div class="flex flex-col gap-1.5">
					<span class="text-xs font-medium text-slate-700 dark:text-slate-300">Description</span>
					<!-- The same composer as New issue: one way to write markdown here. -->
					<MarkdownComposer
						value={body}
						minRows={10}
						placeholder="Markdown. Draft one from the diff, then edit it."
						onInput={(next) => (body = next)}
					/>
				</div>

				<label class="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						class="w-4 h-4 accent-violet-600 cursor-pointer"
						checked={asDraft}
						disabled={isBusy}
						onchange={(event) => (asDraft = event.currentTarget.checked)}
					/>
					<span class="text-xs text-slate-700 dark:text-slate-300">Open as a draft</span>
				</label>
			</div>
		{/if}
	{/snippet}

	{#snippet footer()}
		<div class="flex items-center justify-end gap-2">
			<Button variant="ghost" disabled={isCreating} onclick={onClose}>{created ? 'Done' : 'Cancel'}</Button>
			{#if context && !created && !context.existing}
				<Button
					loading={isCreating}
					disabled={isBusy || !title.trim() || !context.isPushed || sameBranch}
					onclick={create}
				>
					Create pull request
				</Button>
			{/if}
		</div>
	{/snippet}
</Modal>
