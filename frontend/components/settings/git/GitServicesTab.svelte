<script lang="ts">
	/**
	 * Settings → Git Accounts → Services.
	 *
	 * Every GitHub, GitLab, Gitea and Bitbucket sign-in, how it signs in, and a
	 * way to sign in again. Global only: what belongs to one repository opens
	 * from the Git panel's hosting view.
	 */
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import ProviderMark from '$frontend/components/common/display/ProviderMark.svelte';
	import { integrationsStore } from '$frontend/stores/features/integrations.svelte';
	import { hostingStore } from '$frontend/stores/features/hosting.svelte';
	import { openHostConnect } from '$frontend/stores/ui/host-connect.svelte';
	import { GIT_HOST_KINDS, type GitHostKind } from '$shared/types/git-hosting';
	import type { IntegrationAccountInfo } from '$shared/types/integrations';

	const accounts = $derived(
		integrationsStore.accounts.filter((account) => (GIT_HOST_KINDS as readonly string[]).includes(account.provider))
	);
	let removing = $state<string | null>(null);
	let confirmRemove = $state<IntegrationAccountInfo | null>(null);

	onMount(() => void integrationsStore.load());

	function statusTone(account: IntegrationAccountInfo): string {
		switch (account.status) {
			case 'ok':
				return 'text-emerald-600 dark:text-emerald-400';
			case 'needs_auth':
			case 'error':
				return 'text-rose-600 dark:text-rose-400';
			case 'needs_config':
				return 'text-amber-600 dark:text-amber-400';
			default:
				return 'text-slate-400';
		}
	}

	function method(account: IntegrationAccountInfo): string {
		if (account.hosting?.linkedCli) return `Linked to ${account.hosting.linkedCli}`;
		switch (account.authMethod) {
			case 'oauth-device':
			case 'oauth-code':
				return 'Browser sign-in';
			case 'cli':
				return 'From this machine';
			default:
				return 'Token';
		}
	}

	function signInAgain(account: IntegrationAccountInfo) {
		const provider = integrationsStore.providers.find((entry) => entry.id === account.provider);
		const host = account.hosting?.host;
		openHostConnect({
			provider: account.provider as GitHostKind,
			accountId: account.id,
			baseUrl: host && host !== provider?.hosting?.defaultHost ? `https://${host}` : ''
		});
	}

	async function remove(account: IntegrationAccountInfo) {
		confirmRemove = null;
		removing = account.id;
		try {
			await integrationsStore.disconnect(account.id);
			await hostingStore.load({ force: true });
		} finally {
			removing = null;
		}
	}

</script>

<div class="space-y-4">
	<section class="space-y-2">
		<div class="flex items-center justify-between gap-3">
			<p class="m-0 text-xs text-slate-500 dark:text-slate-400">Used to publish, push over HTTPS, and show issues and pull requests.</p>
			<Button size="sm" variant="outline" class="shrink-0 whitespace-nowrap" onclick={() => openHostConnect()}>
				<Icon name="lucide:plus" class="w-3.5 h-3.5 mr-1" />Connect
			</Button>
		</div>
		{#if accounts.length === 0}
			<div class="flex flex-col items-center gap-2 py-8 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 text-center">
				<div class="flex gap-2">
					{#each GIT_HOST_KINDS as kind (kind)}<ProviderMark provider={kind} size="w-5 h-5" />{/each}
				</div>
				<p class="m-0 text-sm text-slate-600 dark:text-slate-300">No service connected</p>
			</div>
		{:else}
			<div class="space-y-2">
				{#each accounts as account (account.id)}
					<div class="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700/80 bg-slate-50 dark:bg-slate-800/50">
						<span class="flex items-center justify-center w-8 h-8 shrink-0 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
							<ProviderMark provider={account.provider} size="w-4 h-4" />
						</span>
						<div class="flex-1 min-w-0">
							<p class="m-0 text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{account.label}</p>
							<p class="m-0 text-[11px] text-slate-500 truncate">
								{account.hosting?.login ? `@${account.hosting.login} · ` : ''}{account.hosting?.host ?? ''} · {method(account)}
								{#if account.statusDetail && account.status !== 'ok'}
									· <span class={statusTone(account)}>{account.statusDetail}</span>
								{/if}
							</p>
						</div>
						<span class="w-2 h-2 rounded-full shrink-0 {account.status === 'ok' ? 'bg-emerald-500' : account.status === 'unknown' ? 'bg-slate-300 dark:bg-slate-600' : account.status === 'needs_config' ? 'bg-amber-500' : 'bg-rose-500'}" title={account.status === 'ok' ? 'Signed in' : account.statusDetail ?? account.status}></span>
						<Button size="sm" variant="ghost" onclick={() => signInAgain(account)}>Sign in again</Button>
						<button
							type="button"
							class="inline-flex items-center justify-center w-8 h-8 rounded-md bg-transparent border-none text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 cursor-pointer disabled:opacity-50"
							disabled={removing === account.id}
							onclick={() => (confirmRemove = account)}
							title="Disconnect"
						>
							<Icon name={removing === account.id ? 'lucide:loader-circle' : 'lucide:trash-2'} class="w-3.5 h-3.5 {removing === account.id ? 'animate-spin' : ''}" />
						</button>
					</div>
				{/each}
			</div>
		{/if}
	</section>

</div>

<Dialog
	isOpen={confirmRemove !== null}
	onClose={() => (confirmRemove = null)}
	title="Disconnect account"
	type="warning"
	message={confirmRemove ? `Disconnect ${confirmRemove.label}? Pushing to ${confirmRemove.hosting?.host ?? 'its host'} falls back to this machine's own credentials.` : ''}
	confirmText="Disconnect"
	cancelText="Cancel"
	onConfirm={() => confirmRemove && void remove(confirmRemove)}
/>
