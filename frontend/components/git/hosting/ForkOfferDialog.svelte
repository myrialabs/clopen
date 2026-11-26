<script lang="ts">
	/**
	 * A push was refused because the account cannot write to the repository.
	 * The usual answer is a fork; this offers it without leaving the panel.
	 *
	 * The remote rearrangement is spelled out before it happens — renaming
	 * `origin` is the kind of change people notice later and wonder about.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import ws from '$frontend/utils/ws';
	import { showSuccess, showInfo } from '$frontend/stores/ui/notification.svelte';
	import type { ForkResult } from '$shared/types/git-hosting';

	interface Props {
		offer: { accountId: string; remote: string; repoName: string; login: string | null; hasUpstream: boolean } | null;
		projectId: string;
		onClose: () => void;
		onForked: (result: ForkResult) => void;
	}

	const { offer, projectId, onClose, onForked }: Props = $props();

	let forking = $state(false);
	let error = $state<string | null>(null);

	const renames = $derived(offer?.remote === 'origin' && !offer.hasUpstream);

	$effect(() => {
		if (offer) error = null;
	});

	async function fork() {
		if (!offer) return;
		forking = true;
		error = null;
		try {
			const result = await ws.http('hosting:fork', { projectId, accountId: offer.accountId, remote: offer.remote }, 5 * 60 * 1000);
			if (result.pushed) showSuccess('Forked and pushed', result.fork.fullName);
			else showInfo('Forked', result.pushMessage ?? result.fork.fullName);
			onForked(result);
			onClose();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			forking = false;
		}
	}
</script>

<Modal isOpen={offer !== null} {onClose} title="You can't push to this repository" size="sm">
	{#snippet children()}
		{#if offer}
			<div class="space-y-3 text-sm text-slate-700 dark:text-slate-300">
				<p class="m-0">
					{offer.login ? `@${offer.login}` : 'This account'} has no write access to <span class="font-mono">{offer.repoName}</span>.
					Fork it to your account and push there instead — you can open a pull request from the fork.
				</p>
				<div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs space-y-1">
					{#if renames}
						<p class="m-0 flex items-center gap-1.5"><Icon name="lucide:arrow-right" class="w-3 h-3" /><span class="font-mono">origin</span> becomes <span class="font-mono">upstream</span> (the original)</p>
						<p class="m-0 flex items-center gap-1.5"><Icon name="lucide:arrow-right" class="w-3 h-3" />your fork becomes <span class="font-mono">origin</span></p>
					{:else}
						<p class="m-0 flex items-center gap-1.5"><Icon name="lucide:plus" class="w-3 h-3" />your fork is added as a new remote; nothing else changes</p>
					{/if}
					<p class="m-0 flex items-center gap-1.5"><Icon name="lucide:upload" class="w-3 h-3" />the current branch is pushed to the fork</p>
				</div>
				{#if error}<p class="m-0 text-xs text-red-500 break-words">{error}</p>{/if}
			</div>
		{/if}
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={onClose}>Not now</Button>
		<Button loading={forking} onclick={fork}>Fork and push</Button>
	{/snippet}
</Modal>
