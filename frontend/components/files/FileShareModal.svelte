<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ShareLinkCard from '$frontend/components/common/share/ShareLinkCard.svelte';
	import type { FileNode } from '$shared/types/filesystem';
	import { debug } from '$shared/utils/logger';
	import { showSuccess, showError } from '$frontend/stores/ui/notification.svelte';
	import { copyText } from '$frontend/utils/clipboard';
	import {
		fileSharesStore,
		FILE_SHARE_EXPIRY_CHOICES,
		type FileShareDefaults
	} from '$frontend/stores/features/file-shares.svelte';
	import { openSettingsModal } from '$frontend/stores/ui/settings-modal.svelte';

	interface Props {
		file: FileNode | null;
		isOpen: boolean;
		onClose: () => void;
	}

	const { file, isOpen, onClose }: Props = $props();

	let shareUrl = $state('');
	let shareId = $state('');
	let oneTime = $state(true);
	let expiresAt = $state<string | null>(null);
	let originSource = $state('');
	let isLoading = $state(false);
	let error = $state('');
	let isRevoking = $state(false);
	let copied = $state(false);

	// The options the next link is minted with. Seeded from the user's saved
	// defaults (one-time, 5 minutes out of the box) and editable per link.
	let options = $state<FileShareDefaults>({ ...fileSharesStore.defaults });
	let showOptions = $state(false);

	/** File a link was already minted for, so a re-render never mints a second one. */
	let mintedFor: string | null = null;

	// Live row for the link this modal minted, refreshed real-time via
	// `files:shares-changed` (opened from HP, revoked elsewhere, expired).
	// The store always re-fetches fresh — never a cached list — so this
	// derived flips the moment the phone's download hits the server.
	const liveShare = $derived(shareId ? fileSharesStore.byId(shareId) : undefined);
	const sharesLoaded = $derived(fileSharesStore.loaded);
	const isConsumed = $derived(!!liveShare?.consumedAt);
	// Loaded + minted but absent from the live list = gone (expired, revoked,
	// or swept after use). Guarded by !isLoading so the first mint never
	// flashes as expired while its refresh is still in flight.
	const isGone = $derived(
		!!shareId && !isLoading && sharesLoaded && !liveShare && !error
	);
	const isLinkDead = $derived(isConsumed || isGone);
	const liveOpenCount = $derived(liveShare?.openCount ?? 0);

	// (Re)generate the link every time the modal opens for a file, so the QR
	// always points at exactly the file the menu was opened on.
	$effect(() => {
		if (isOpen && file) {
			if (mintedFor !== file.path) {
				mintedFor = file.path;
				void openFor(file);
			}
		}
		if (!isOpen) {
			shareUrl = '';
			shareId = '';
			expiresAt = null;
			originSource = '';
			error = '';
			isRevoking = false;
			copied = false;
			showOptions = false;
			mintedFor = null;
		}
	});

	// Keep the status live while the modal is open: a scan + download from
	// a phone fires `files:shares-changed`, the store re-loads fresh, and
	// the deriveds above re-render without closing/reopening the modal.
	$effect(() => {
		if (!isOpen) return;
		const stop = fileSharesStore.subscribe();
		return () => stop();
	});

	async function openFor(target: FileNode) {
		options = { ...(await fileSharesStore.loadDefaults()) };
		await generateShareLink(target);
	}

	async function generateShareLink(target: FileNode) {
		isLoading = true;
		error = '';
		shareUrl = '';
		try {
			// The store owns both the public origin (same one Remote Access
			// resolves: configured URL, current origin, or a quick tunnel) and
			// the URL cache that keeps this link manageable after the modal closes.
			const result = await fileSharesStore.create(target.path, options);
			shareId = result.id;
			shareUrl = result.url;
			oneTime = result.oneTime;
			expiresAt = result.expiresAt;
			originSource =
				result.source === 'tunnel' ? 'public tunnel' : result.source === 'domain' ? 'this server' : 'configured URL';
		} catch (err) {
			debug.error('file', 'Failed to create share link:', err);
			error = err instanceof Error ? err.message : 'Failed to create share link';
		} finally {
			isLoading = false;
		}
	}

	/**
	 * Changing an option re-mints: the old link is revoked first, so the QR a
	 * moment ago cannot outlive the settings it was created under.
	 */
	async function applyOptions(next: Partial<FileShareDefaults>) {
		options = { ...options, ...next };
		if (!file) return;
		const previous = shareId;
		await generateShareLink(file);
		if (previous && previous !== shareId) {
			await fileSharesStore.revoke(previous).catch(() => {});
		}
	}

	const expiryLabel = $derived.by(() => {
		if (!expiresAt) return '';
		const date = new Date(expiresAt);
		if (Number.isNaN(date.getTime())) return '';
		return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	});

	const lifetimeSentence = $derived.by(() => {
		if (isConsumed) return 'Used — this one-time link no longer opens the file';
		if (isGone) return 'Expired — this link no longer opens the file';
		const access = oneTime ? 'Opens once' : 'Reusable';
		const deadline = expiryLabel ? `until ${expiryLabel}` : 'until you revoke it';
		const opened = !oneTime && liveOpenCount > 0 ? ` · opened ${liveOpenCount}×` : '';
		const via = originSource ? ` · via ${originSource}` : '';
		return `${access}, ${deadline}${opened}${via}`;
	});

	async function createNewLink() {
		if (!file || isLoading) return;
		const previous = shareId;
		// Keep mintedFor intact so the auto-mint $effect cannot fire a
		// concurrent mint while this one is in flight.
		await generateShareLink(file);
		mintedFor = file.path;
		if (previous && previous !== shareId) {
			await fileSharesStore.revoke(previous).catch(() => {});
		}
	}

	async function copyLink() {
		if (!shareUrl || isLinkDead) return;
		if (!(await copyText(shareUrl))) {
			showError('Copy Failed', 'Could not copy the link.');
			return;
		}
		copied = true;
		showSuccess('Copied', 'Share link copied to clipboard.');
		setTimeout(() => { copied = false; }, 2000);
	}

	/** Kill the link before anyone opens it — a share handed to the wrong person
	 *  would otherwise stay usable for its full lifetime. */
	async function revokeLink() {
		if (!shareId || isRevoking) return;
		isRevoking = true;
		try {
			await fileSharesStore.revoke(shareId);
			showSuccess('Link Revoked', 'This link no longer opens the file.');
			onClose();
		} catch (err) {
			debug.error('file', 'Failed to revoke share link:', err);
			showError('Revoke Failed', err instanceof Error ? err.message : 'Could not revoke the link.');
			isRevoking = false;
		}
	}

	function manageLinks() {
		onClose();
		openSettingsModal('file-shares');
	}
</script>

<!-- The file name stays OUT of the modal title: a long name has nowhere to go
     in a header that also holds the close button, and it pushed the layout
     apart. In the body it can truncate against a known width. -->
<Modal {isOpen} {onClose} title="Share File" size="md">
	<div class="space-y-3">
		{#if file}
			<div class="flex items-center gap-2 min-w-0">
				<Icon name="lucide:file" class="w-4 h-4 text-slate-400 shrink-0" />
				<span
					class="min-w-0 truncate text-sm font-medium text-slate-800 dark:text-slate-200"
					title={file.path}
				>
					{file.name}
				</span>
			</div>
		{/if}

		{#if isLoading}
			<div class="flex flex-col items-center gap-3 py-8" role="status" aria-label="Creating share link">
				<span class="w-8 h-8 border-2 border-violet-500/30 border-t-violet-500 rounded-full animate-spin"></span>
				<p class="text-sm text-slate-500 dark:text-slate-400">Creating share link…</p>
			</div>
		{:else if error}
			<div class="flex flex-col items-center gap-3 py-6 text-center">
				<Icon name="lucide:circle-alert" class="w-8 h-8 text-red-500" />
				<p class="text-sm text-slate-600 dark:text-slate-300">{error}</p>
				<button
					type="button"
					onclick={() => file && generateShareLink(file)}
					class="px-4 py-1.5 text-sm font-medium rounded-md bg-violet-600 hover:bg-violet-700 text-white transition-colors cursor-pointer"
				>
					Try Again
				</button>
			</div>
		{:else if shareUrl}
			{#if isLinkDead}
				<div
					class="flex items-start gap-2 p-2.5 rounded-lg border text-xs
						{isConsumed
						? 'bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-300'
						: 'bg-slate-500/10 border-slate-500/20 text-slate-600 dark:text-slate-300'}"
					role="status"
				>
					<Icon
						name={isConsumed ? 'lucide:check-check' : 'lucide:link-2-off'}
						class="w-4 h-4 shrink-0 mt-px"
					/>
					<span>
						{#if isConsumed}
							Link opened — the file was downloaded. This one-time link no longer works.
						{:else}
							This link is no longer valid (expired, already used, or revoked).
						{/if}
					</span>
				</div>
			{/if}
			<!-- Same link + QR presentation as every other share surface; the
			     modal keeps its own prominent actions below, like the Remote
			     Access panel does. -->
			<ShareLinkCard
				url={shareUrl}
				qr="always"
				onCopied={(ok) => !ok && showError('Copy Failed', 'Could not copy the link.')}
			>
				{#snippet meta()}
					<Icon name="lucide:timer" class="w-3 h-3 shrink-0" />
					<span>{lifetimeSentence}</span>
				{/snippet}
			</ShareLinkCard>

			<div class="grid grid-cols-[1fr_auto] gap-2">
				{#if isLinkDead}
					<button
						type="button"
						onclick={createNewLink}
						disabled={isLoading}
						class="flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-violet-600 hover:bg-violet-700 text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
					>
						<Icon name="lucide:refresh-cw" class="w-4 h-4" />
						Create New Link
					</button>
				{:else}
					<button
						type="button"
						onclick={copyLink}
						class="flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-violet-600 hover:bg-violet-700 text-white transition-colors cursor-pointer"
					>
						<Icon name={copied ? 'lucide:check' : 'lucide:copy'} class="w-4 h-4" />
						{copied ? 'Copied' : 'Copy Link'}
					</button>
				{/if}
				{#if !isLinkDead}
					<button
						type="button"
						onclick={revokeLink}
						disabled={isRevoking}
						class="flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
					>
						<Icon name="lucide:link-2-off" class="w-4 h-4" />
						{isRevoking ? 'Revoking…' : 'Revoke'}
					</button>
				{/if}
			</div>

			<!-- Options, folded away: the defaults are the answer almost every
			     time, and unfolding them re-mints the link rather than leaving a
			     QR on screen that no longer matches its settings. -->
			<div class="rounded-lg border border-slate-200 dark:border-slate-700">
				<button
					type="button"
					onclick={() => (showOptions = !showOptions)}
					class="flex items-center gap-1.5 w-full px-3 py-2 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition-colors cursor-pointer"
					aria-expanded={showOptions}
				>
					<Icon name={showOptions ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3.5 h-3.5" />
					Link options
				</button>

				{#if showOptions}
					<div class="px-3 pb-3 space-y-3 border-t border-slate-200 dark:border-slate-700 pt-3">
						<div class="space-y-1.5">
							<div class="text-2xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
								Access
							</div>
							<div class="grid grid-cols-2 gap-1.5">
								{#each [{ value: true, label: 'Open once' }, { value: false, label: 'Reusable' }] as choice}
									<button
										type="button"
										onclick={() => applyOptions({ oneTime: choice.value })}
										class="px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer
											{options.oneTime === choice.value
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
										onclick={() => applyOptions({ expiresInMinutes: choice.value })}
										class="px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer
											{options.expiresInMinutes === choice.value
											? 'border-violet-500 bg-violet-500/10 text-violet-600 dark:text-violet-400'
											: 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}"
									>
										{choice.label}
									</button>
								{/each}
							</div>
						</div>

						{#if !options.oneTime && options.expiresInMinutes === null}
							<div class="flex items-start gap-2 p-2 rounded-md bg-amber-500/10 border border-amber-500/20 text-2xs text-amber-700 dark:text-amber-300">
								<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5 shrink-0 mt-px" />
								<span>Anyone with this URL can read the file, any number of times, until you revoke it.</span>
							</div>
						{/if}

						<button
							type="button"
							onclick={() => fileSharesStore.saveDefaults(options)}
							class="text-2xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition-colors cursor-pointer"
						>
							Save as my default
						</button>
					</div>
				{/if}
			</div>

			<button
				type="button"
				onclick={manageLinks}
				class="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition-colors cursor-pointer"
			>
				<Icon name="lucide:list" class="w-3.5 h-3.5" />
				Manage all share links
			</button>
		{/if}
	</div>
</Modal>
