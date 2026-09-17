<script lang="ts">
	/**
	 * Every live file link, in one place.
	 *
	 * Without this the only handle on a link was the modal that created it:
	 * close it and the raw token — the sole argument the old revoke took — was
	 * gone, leaving a working public URL nobody could withdraw. Revoking by row
	 * id lifts that, and this list is where it is reachable.
	 *
	 * A link whose URL was minted in another browser session lists without its
	 * URL: the server keeps only the token's hash, so no surface can re-show it.
	 * Revoke still works, which is the part that matters.
	 *
	 * There is no refresh button on purpose. `files:shares-changed` fires when a
	 * link is minted, revoked or opened — including an open from a phone that
	 * never touches this browser — so the list moves on its own.
	 */
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import ShareLinkCard from '$frontend/components/common/share/ShareLinkCard.svelte';
	import {
		fileSharesStore,
		FILE_SHARE_EXPIRY_CHOICES,
		type FileShare,
		type FileShareDefaults
	} from '$frontend/stores/features/file-shares.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { debug } from '$shared/utils/logger';

	const isAdmin = $derived(authStore.isAdmin);
	const shares = $derived(fileSharesStore.shares);
	const defaults = $derived(fileSharesStore.defaults);

	let loadError = $state('');
	let shareToRevoke = $state<FileShare | null>(null);
	let showRevokeConfirm = $state(false);

	// Live clock so every countdown ticks off the same second.
	let now = $state(Date.now());

	onMount(() => {
		void load();
		void fileSharesStore.loadDefaults();
		const stop = fileSharesStore.subscribe();
		const timer = setInterval(() => { now = Date.now(); }, 1000);
		return () => { stop(); clearInterval(timer); };
	});

	async function load() {
		loadError = '';
		try {
			await fileSharesStore.load();
		} catch (err) {
			loadError = err instanceof Error ? err.message : 'Failed to load share links';
		}
	}

	function saveDefaults(next: Partial<FileShareDefaults>) {
		void fileSharesStore.saveDefaults({ ...defaults, ...next });
	}

	/** A link past its deadline is dropped by the server on the next read; until
	 *  then the row would tick into negative numbers, so it reads as expired. */
	function formatCountdown(expiresAt: string | null, currentTime: number): string {
		if (!expiresAt) return 'until revoked';
		const remainingMs = new Date(expiresAt).getTime() - currentTime;
		if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'expired';
		const totalMinutes = Math.floor(remainingMs / 60_000);
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
		if (hours > 0) return `${hours}h ${minutes}m`;
		if (totalMinutes > 0) return `${totalMinutes}m`;
		return `${Math.floor(remainingMs / 1000)}s`;
	}

	function formatAgo(iso: string, currentTime: number): string {
		const elapsed = currentTime - new Date(iso).getTime();
		if (!Number.isFinite(elapsed) || elapsed < 0) return 'just now';
		const minutes = Math.floor(elapsed / 60_000);
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		return `${Math.floor(hours / 24)}d ago`;
	}

	function usageLabel(share: FileShare, currentTime: number): string {
		if (share.openCount === 0) return 'Not opened yet';
		const when = share.lastOpenedAt ? ` · ${formatAgo(share.lastOpenedAt, currentTime)}` : '';
		if (share.oneTime) return `Opened${when}`;
		return `Opened ${share.openCount}×${when}`;
	}

	function confirmRevoke(share: FileShare) {
		shareToRevoke = share;
		showRevokeConfirm = true;
	}

	async function revoke() {
		if (!shareToRevoke) return;
		try {
			await fileSharesStore.revoke(shareToRevoke.id);
			addNotification({ type: 'success', title: 'Revoked', message: 'The link no longer opens the file' });
		} catch (error) {
			debug.error('file', 'Failed to revoke file share:', error);
			addNotification({ type: 'error', title: 'Error', message: 'Failed to revoke the link' });
		} finally {
			showRevokeConfirm = false;
			shareToRevoke = null;
		}
	}
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">File share links</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">
		{isAdmin ? 'Links that can still open a file on this server.' : 'Your links that can still open a file.'}
	</p>

	<!-- Defaults for new links -->
	<div class="flex flex-col gap-3 px-3 py-3 mb-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg">
		<div class="text-2xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
			Defaults for new links
		</div>
		<!-- Two questions, two groups — the same shape the share modal's "Link
		     options" uses. One wrapping strip with a divider made "Until revoked"
		     land on its own line under the access choices, where it read as a
		     third kind of thing. -->
		<div class="space-y-1.5">
			<div class="text-2xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
				Access
			</div>
			<div class="grid grid-cols-2 gap-1.5">
				{#each [{ value: true, label: 'Open once' }, { value: false, label: 'Reusable' }] as choice}
					<button
						type="button"
						onclick={() => saveDefaults({ oneTime: choice.value })}
						class="px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer
							{defaults.oneTime === choice.value
							? 'border-violet-500 bg-violet-500/10 text-violet-600 dark:text-violet-400'
							: 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}"
					>
						{choice.label}
					</button>
				{/each}
			</div>
		</div>

		<div class="space-y-1.5">
			<div class="text-2xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
				Expires
			</div>
			<div class="flex flex-wrap gap-1.5">
				{#each FILE_SHARE_EXPIRY_CHOICES as choice}
					<button
						type="button"
						onclick={() => saveDefaults({ expiresInMinutes: choice.value })}
						class="px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer
							{defaults.expiresInMinutes === choice.value
							? 'border-violet-500 bg-violet-500/10 text-violet-600 dark:text-violet-400'
							: 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}"
					>
						{choice.label}
					</button>
				{/each}
			</div>
		</div>
		<p class="text-2xs text-slate-400 dark:text-slate-500">
			Applied to every link you create from the Explorer; each one can still be changed as you share it.
		</p>
	</div>

	{#if loadError}
		<div class="flex items-start gap-2 p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg text-xs">
			<Icon name="lucide:circle-alert" class="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
			<span class="text-red-700 dark:text-red-300">{loadError}</span>
		</div>
	{:else if !fileSharesStore.loaded && fileSharesStore.isLoading}
		<div class="flex items-center justify-center gap-3 py-8 text-slate-600 dark:text-slate-500 text-sm">
			<div class="w-5 h-5 border-2 border-violet-500/20 border-t-violet-600 rounded-full animate-spin"></div>
			<span>Loading...</span>
		</div>
	{:else if shares.length === 0}
		<div class="flex flex-col items-center gap-2 py-10 text-center">
			<Icon name="lucide:link-2-off" class="w-8 h-8 text-slate-300 dark:text-slate-600" />
			<p class="text-sm text-slate-500 dark:text-slate-400">No live share links.</p>
			<p class="text-xs text-slate-400 dark:text-slate-500">
				Right-click a file in the Explorer and pick “Share Link…” to create one.
			</p>
		</div>
	{:else}
		<div class="flex flex-col gap-2">
			{#each shares as share (share.id)}
				{@const url = fileSharesStore.shareURL(share.id)}
				<div class="flex flex-col gap-2 px-3 py-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg">
					<!-- Which file, said precisely: a project full of index.ts files
					     is unreadable when the row only carries a basename. -->
					<div class="flex items-start gap-2">
						<Icon name="lucide:file" class="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
						<div class="flex-1 min-w-0" title={share.filePath}>
							<div class="flex items-center gap-1.5 flex-wrap">
								{#if share.projectName}
									<span class="text-2xs px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400 font-medium">
										{share.projectName}
									</span>
								{/if}
								{#if share.worktreeName}
									<span class="text-2xs px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-600 dark:text-sky-400 font-medium">
										{share.worktreeName}
									</span>
								{/if}
								<span class="text-sm font-medium text-slate-800 dark:text-slate-200 break-all">
									{share.fileName}
								</span>
							</div>
							<div class="font-mono text-2xs text-slate-400 dark:text-slate-500 break-all">
								{share.relativePath}
							</div>
						</div>
						<span
							class="text-2xs px-1.5 py-0.5 rounded-full font-medium shrink-0
								{share.openCount > 0
								? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
								: 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400'}"
						>
							{usageLabel(share, now)}
						</span>
						{#if !url}
							<button
								type="button"
								onclick={() => confirmRevoke(share)}
								class="flex items-center justify-center w-7 h-7 rounded-md hover:bg-red-100 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-all shrink-0 cursor-pointer"
								title="Revoke link"
								aria-label="Revoke link"
							>
								<Icon name="lucide:x" class="w-3.5 h-3.5" />
							</button>
						{/if}
					</div>

					{#if url}
						<!-- `flat`: the row already draws a border, and nesting a
						     second one around the URL is what made this read as a
						     card inside a card. -->
						<ShareLinkCard {url} qr="toggle" flat>
							{#snippet actions()}
								<button
									type="button"
									onclick={() => confirmRevoke(share)}
									class="flex items-center justify-center w-7 h-7 rounded-md hover:bg-red-100 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-all shrink-0 cursor-pointer"
									title="Revoke link"
									aria-label="Revoke link"
								>
									<Icon name="lucide:x" class="w-3.5 h-3.5" />
								</button>
							{/snippet}
						</ShareLinkCard>
					{:else}
						<div class="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800/60 text-xs text-slate-500 dark:text-slate-400 italic">
							Created in another session — revocable, but the URL cannot be shown again.
						</div>
					{/if}

					<div class="flex items-center gap-1.5 flex-wrap text-2xs text-slate-500 dark:text-slate-400">
						{#if isAdmin}
							<Icon name="lucide:user" class="w-3 h-3" />
							<span>{share.createdByName ?? 'Unknown user'}</span>
							<span class="text-slate-300 dark:text-slate-600">·</span>
						{/if}
						<Icon name={share.oneTime ? 'lucide:flame' : 'lucide:repeat'} class="w-3 h-3" />
						<span>{share.oneTime ? 'Opens once' : 'Reusable'}</span>
						<span class="text-slate-300 dark:text-slate-600">·</span>
						<Icon name="lucide:timer" class="w-3 h-3" />
						<span class="font-mono tabular-nums">{formatCountdown(share.expiresAt, now)}</span>
						{#if share.consumedAt}
							<span class="text-slate-300 dark:text-slate-600">·</span>
							<span>only the original viewer can still stream it</span>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<Dialog
	bind:isOpen={showRevokeConfirm}
	onClose={() => { showRevokeConfirm = false; shareToRevoke = null; }}
	title="Revoke Share Link"
	type="warning"
	message={shareToRevoke
		? `Revoke this link? "${shareToRevoke.fileName}" will stop being reachable through it immediately.`
		: ''}
	confirmText="Revoke"
	cancelText="Cancel"
	showCancel={true}
	onConfirm={revoke}
/>
