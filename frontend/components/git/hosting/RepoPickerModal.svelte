<script lang="ts">
	/**
	 * Add a remote by picking a repository, not by pasting its URL.
	 *
	 * The URL form stays where it was for anything not on a connected account;
	 * this is the common case made one search and one click.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import ProviderMark from '$frontend/components/common/display/ProviderMark.svelte';
	import ws from '$frontend/utils/ws';
	import { hostingStore } from '$frontend/stores/features/hosting.svelte';
	import { openHostConnect } from '$frontend/stores/ui/host-connect.svelte';
	import { relativeTime } from '$frontend/utils/relative-time';
	import type { HostedRepo } from '$shared/types/git-hosting';

	interface Props {
		isOpen: boolean;
		projectId: string;
		existingRemotes: string[];
		onClose: () => void;
		/** Adds the remote. Resolves when it is added; throws to keep the dialog open. */
		onAdd: (name: string, url: string) => Promise<void>;
	}

	const { isOpen, projectId, existingRemotes, onClose, onAdd }: Props = $props();

	let accountId = $state('');
	let search = $state('');
	let repos = $state<HostedRepo[]>([]);
	let page = $state(1);
	let hasMore = $state(false);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let chosen = $state<HostedRepo | null>(null);
	let remoteName = $state('origin');
	let protocol = $state<'https' | 'ssh'>('https');
	let adding = $state(false);
	let generation = 0;

	const accounts = $derived(hostingStore.publishAccounts);
	const remoteTaken = $derived(existingRemotes.includes(remoteName.trim()));

	$effect(() => {
		if (!isOpen) return;
		chosen = null;
		search = '';
		error = null;
		remoteName = existingRemotes.includes('origin') ? (existingRemotes.includes('upstream') ? 'fork' : 'upstream') : 'origin';
		if (!accounts.some((entry) => entry.accountId === accountId)) accountId = accounts[0]?.accountId ?? '';
	});

	// Debounced: every keystroke would otherwise be a request to the service.
	$effect(() => {
		const id = accountId;
		const query = search;
		if (!isOpen || !id) return;
		const handle = setTimeout(() => void fetchPage(id, query, 1), query ? 300 : 0);
		return () => clearTimeout(handle);
	});

	async function fetchPage(id: string, query: string, next: number) {
		const mine = ++generation;
		loading = true;
		error = null;
		try {
			const result = await ws.http('hosting:repos', { projectId, accountId: id, ...(query.trim() && { search: query.trim() }), page: next });
			if (mine !== generation) return;
			repos = next === 1 ? result.repos : [...repos, ...result.repos];
			hasMore = result.hasMore;
			page = next;
		} catch (err) {
			if (mine !== generation) return;
			error = err instanceof Error ? err.message : String(err);
			if (next === 1) repos = [];
		} finally {
			if (mine === generation) loading = false;
		}
	}

	async function add() {
		if (!chosen || remoteTaken || !remoteName.trim()) return;
		const url = protocol === 'ssh' && chosen.cloneUrlSsh ? chosen.cloneUrlSsh : chosen.cloneUrlHttps;
		adding = true;
		error = null;
		try {
			await onAdd(remoteName.trim(), url);
			onClose();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			adding = false;
		}
	}

	const fieldClass = 'w-full px-2.5 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500';
</script>

<Modal {isOpen} {onClose} title="Add a remote from your repositories" size="md">
	{#snippet children()}
		<div class="space-y-3 text-sm">
			{#if accounts.length === 0}
				<div class="flex flex-col items-center gap-3 py-6 text-center">
					<p class="m-0 text-slate-700 dark:text-slate-300">Connect an account to pick from its repositories</p>
					<Button onclick={() => openHostConnect()}>Connect GitHub, GitLab…</Button>
				</div>
			{:else}
				<div class="flex gap-2">
					{#if accounts.length > 1}
						<select class="{fieldClass} w-44" bind:value={accountId}>
							{#each accounts as entry (entry.accountId)}
								<option value={entry.accountId}>{entry.label}</option>
							{/each}
						</select>
					{/if}
					<div class="relative flex-1">
						<Icon name="lucide:search" class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
						<input class="{fieldClass} pl-8" placeholder="Search repositories…" bind:value={search} />
					</div>
				</div>

				<div class="max-h-72 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
					{#each repos as repo (repo.fullName)}
						<button
							type="button"
							class="flex items-start gap-2 w-full px-3 py-2 text-left border-none cursor-pointer {chosen?.fullName === repo.fullName ? 'bg-violet-500/10' : 'bg-transparent hover:bg-slate-50 dark:hover:bg-slate-800/50'}"
							onclick={() => (chosen = repo)}
						>
							<Icon name={repo.isPrivate ? 'lucide:lock' : repo.isFork ? 'lucide:git-fork' : 'lucide:book-marked'} class="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-400" />
							<span class="flex flex-col min-w-0 flex-1">
								<span class="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">{repo.fullName}</span>
								{#if repo.description}<span class="text-[11px] text-slate-500 truncate">{repo.description}</span>{/if}
							</span>
							{#if repo.updatedAt}<span class="text-3xs text-slate-400 shrink-0">{relativeTime(repo.updatedAt)}</span>{/if}
						</button>
					{/each}
					{#if loading}
						<div class="flex items-center justify-center py-4"><Icon name="lucide:loader-circle" class="w-4 h-4 animate-spin text-slate-400" /></div>
					{:else if repos.length === 0}
						<p class="m-0 py-6 text-center text-xs text-slate-500">{search ? `Nothing matches "${search}".` : 'No repositories.'}</p>
					{:else if hasMore}
						<button type="button" class="w-full py-2 text-xs bg-transparent border-none text-slate-500 cursor-pointer hover:bg-violet-500/5" onclick={() => void fetchPage(accountId, search, page + 1)}>Load more</button>
					{/if}
				</div>

				{#if chosen}
					<div class="flex items-center gap-2">
						<ProviderMark provider={accounts.find((entry) => entry.accountId === accountId)?.provider ?? ''} size="w-4 h-4" />
						<input class="{fieldClass} w-36" bind:value={remoteName} aria-label="Remote name" />
						<select class={fieldClass} bind:value={protocol}>
							<option value="https">HTTPS</option>
							<option value="ssh" disabled={!chosen.cloneUrlSsh}>SSH</option>
						</select>
					</div>
					{#if remoteTaken}<p class="m-0 text-[11px] text-red-500">A remote with this name already exists.</p>{/if}
				{/if}

				{#if error}<p class="m-0 text-xs text-red-500 break-words">{error}</p>{/if}
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={onClose}>Cancel</Button>
		{#if accounts.length > 0}
			<Button loading={adding} disabled={!chosen || remoteTaken || !remoteName.trim()} onclick={add}>Add remote</Button>
		{/if}
	{/snippet}
</Modal>
