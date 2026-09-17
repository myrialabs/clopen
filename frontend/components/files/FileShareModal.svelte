<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import TunnelQRCode from '$frontend/components/tunnel/TunnelQRCode.svelte';
	import type { FileNode } from '$shared/types/filesystem';
	import { debug } from '$shared/utils/logger';
	import { copyText } from '$frontend/utils/clipboard';
	import { showSuccess, showError } from '$frontend/stores/ui/notification.svelte';
	import ws from '$frontend/utils/ws';

	interface Props {
		file: FileNode | null;
		isOpen: boolean;
		onClose: () => void;
	}

	const { file, isOpen, onClose }: Props = $props();

	let shareUrl = $state('');
	let expiresAt = $state('');
	let originSource = $state('');
	let isLoading = $state(false);
	let error = $state('');
	let copied = $state(false);
	// (Re)generate the link every time the modal opens for a file, so the QR
	// always points at exactly the file the menu was opened on.
	$effect(() => {
		if (isOpen && file) {
			void generateShareLink(file);
		}
		if (!isOpen) {
			shareUrl = '';
			expiresAt = '';
			originSource = '';
			error = '';
			copied = false;
		}
	});

	async function generateShareLink(target: FileNode) {
		isLoading = true;
		error = '';
		shareUrl = '';
		try {
			// Same public origin Remote Access builds its links against
			// (configured URL, current origin, or a quick tunnel) — reused,
			// not reimplemented.
			const requestOrigin = typeof window !== 'undefined' ? window.location.origin : undefined;
			const { origin, source } = await ws.http('share:ensure-origin', { requestOrigin });
			const { shareToken, expiresAt: expiry } = await ws.http('files:create-share', {
				file_path: target.path
			});
			shareUrl = `${origin}/api/files/shared?share=${encodeURIComponent(shareToken)}`;
			expiresAt = expiry;
			originSource = source === 'tunnel' ? 'public tunnel' : source === 'domain' ? 'this server' : 'configured URL';
		} catch (err) {
			debug.error('file', 'Failed to create share link:', err);
			error = err instanceof Error ? err.message : 'Failed to create share link';
		} finally {
			isLoading = false;
		}
	}

	const expiryLabel = $derived.by(() => {
		if (!expiresAt) return '';
		const date = new Date(expiresAt);
		if (Number.isNaN(date.getTime())) return '';
		return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	});

	async function copyLink() {
		if (!shareUrl) return;
		if (await copyText(shareUrl)) {
			copied = true;
			showSuccess('Copied', 'Share link copied to clipboard.');
			setTimeout(() => { copied = false; }, 2000);
		} else {
			showError('Copy Failed', 'Could not copy the link.');
		}
	}
</script>

<Modal {isOpen} {onClose} title={file ? `Share "${file.name}"` : 'Share File'} size="md">
	<div class="space-y-4">
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
			<!-- Link -->
			<div>
				<div class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1.5">
					Share Link
				</div>
				<div class="flex items-stretch gap-2">
					<div
						class="flex-1 min-w-0 px-3 py-2 text-xs font-mono break-all rounded-lg bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 select-all"
					>
						{shareUrl}
					</div>
				</div>
				{#if expiryLabel}
					<p class="mt-1.5 text-xs text-slate-400 dark:text-slate-500">
						This link opens this file once — it stops working after the first open, or on {expiryLabel} at the latest{originSource ? ` (via ${originSource})` : ''}.
					</p>
				{/if}
			</div>

			<!-- QR code (same renderer as the tunnel panel, so it looks identical everywhere) -->
			<div class="flex justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/30 py-2">
				<TunnelQRCode value={shareUrl} size={200} />
			</div>

			<!-- Actions -->
			<div class="grid grid-cols-1 gap-2">
				<button
					type="button"
					onclick={copyLink}
					class="flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-violet-600 hover:bg-violet-700 text-white transition-colors cursor-pointer"
				>
					<Icon name={copied ? 'lucide:check' : 'lucide:copy'} class="w-4 h-4" />
					{copied ? 'Copied' : 'Copy Link'}
				</button>
			</div>
		{/if}
	</div>
</Modal>
