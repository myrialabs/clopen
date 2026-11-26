<script lang="ts">
	/**
	 * Publish this repository: create it on the service, add it as a remote,
	 * push. One form instead of "create a repository in the browser, copy its
	 * URL, come back, Add Remote, paste, push".
	 *
	 * Private is the default. Making something public is the step worth a
	 * deliberate click; the reverse costs nothing.
	 *
	 * A repository with no commits yet needs one before anything can be pushed,
	 * so the form says how many files the first commit would hold and lets the
	 * user decide — committing everything silently is how secrets get pushed.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import ProviderMark from '$frontend/components/common/display/ProviderMark.svelte';
	import ws from '$frontend/utils/ws';
	import { hostingStore } from '$frontend/stores/features/hosting.svelte';
	import { openHostConnect } from '$frontend/stores/ui/host-connect.svelte';
	import { showSuccess, showInfo } from '$frontend/stores/ui/notification.svelte';
	import type { HostOwner, HostTemplates, PublishRepoResult } from '$shared/types/git-hosting';

	interface Props {
		isOpen: boolean;
		projectId: string;
		/** Suggested repository name — the project folder's. */
		defaultName: string;
		/** Remote names already taken, so the default does not collide. */
		existingRemotes: string[];
		onClose: () => void;
		onPublished: (result: PublishRepoResult) => void;
	}

	const { isOpen, projectId, defaultName, existingRemotes, onClose, onPublished }: Props = $props();

	let accountId = $state('');
	let owners = $state<HostOwner[]>([]);
	let owner = $state('');
	let name = $state('');
	let description = $state('');
	let isPrivate = $state(true);
	let remoteName = $state('origin');
	let protocol = $state<'https' | 'ssh'>('https');
	let templates = $state<HostTemplates | null>(null);
	let gitignore = $state('');
	let license = $state('');
	let readme = $state(false);
	let firstCommit = $state(true);
	let loading = $state(false);
	let publishing = $state(false);
	let error = $state<string | null>(null);

	const accounts = $derived(hostingStore.publishAccounts);
	const account = $derived(accounts.find((entry) => entry.accountId === accountId) ?? null);
	const nameValid = $derived(/^[A-Za-z0-9._-]{1,100}$/.test(name.trim()));
	const remoteTaken = $derived(existingRemotes.includes(remoteName.trim()));
	const canPublish = $derived(!!account && !!owner && nameValid && !!remoteName.trim() && !remoteTaken && !publishing);

	/** A folder name is rarely a valid repository name as-is: spaces and accents. */
	function slug(raw: string): string {
		return raw.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
	}

	// Seed on open.
	$effect(() => {
		if (!isOpen) return;
		error = null;
		name = slug(defaultName);
		description = '';
		isPrivate = true;
		remoteName = existingRemotes.includes('origin') ? 'github' : 'origin';
		readme = false;
		firstCommit = true;
		if (!accounts.some((entry) => entry.accountId === accountId)) accountId = accounts[0]?.accountId ?? '';
	});

	// Owners and templates follow the chosen account.
	$effect(() => {
		const id = accountId;
		if (!isOpen || !id) return;
		void load(id);
	});

	async function load(id: string) {
		loading = true;
		owners = [];
		templates = null;
		try {
			const [ownerList, templateInfo] = await Promise.all([
				ws.http('hosting:owners', { projectId, accountId: id }),
				ws.http('hosting:templates', { projectId, accountId: id })
			]);
			if (id !== accountId) return;
			owners = ownerList;
			owner = ownerList[0]?.login ?? '';
			templates = templateInfo;
			gitignore = templateInfo.existing.gitignore ? '' : templateInfo.suggestedGitignore ?? '';
			license = '';
			readme = !templateInfo.existing.readme && templateInfo.needsFirstCommit;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function publish() {
		if (!canPublish || !account) return;
		publishing = true;
		error = null;
		try {
			const result = await ws.http('hosting:publish', {
				projectId,
				accountId,
				owner,
				name: name.trim(),
				description: description.trim(),
				isPrivate,
				remoteName: remoteName.trim(),
				gitignore: gitignore || null,
				license: license || null,
				readme,
				createFirstCommit: firstCommit,
				protocol
			}, 5 * 60 * 1000);
			if (result.pushed) showSuccess('Published', result.repo.fullName);
			else showInfo('Repository created', result.pushMessage ?? `${result.repo.fullName} is ready to push.`);
			onPublished(result);
			onClose();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			publishing = false;
		}
	}

	const selectClass = 'w-full px-2.5 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500';
	const inputClass = selectClass;
</script>

<Modal {isOpen} {onClose} title="Publish repository" size="md">
	{#snippet children()}
		<div class="space-y-4 text-sm">
			{#if accounts.length === 0}
				<div class="flex flex-col items-center gap-3 py-6 text-center">
					<Icon name="lucide:cloud-upload" class="w-9 h-9 text-slate-300 dark:text-slate-700" />
					<p class="m-0 text-slate-700 dark:text-slate-300">Connect a git service to publish to</p>
					<Button onclick={() => openHostConnect()}>Connect GitHub, GitLab…</Button>
				</div>
			{:else}
				<div class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-3">
					<span class="text-xs font-medium text-slate-600 dark:text-slate-300">Account</span>
					<div class="flex items-center gap-2">
						{#if account}<ProviderMark provider={account.provider} size="w-4 h-4" />{/if}
						<select class={selectClass} bind:value={accountId}>
							{#each accounts as entry (entry.accountId)}
								<option value={entry.accountId}>{entry.label}</option>
							{/each}
						</select>
					</div>

					<span class="text-xs font-medium text-slate-600 dark:text-slate-300">Owner</span>
					<select class={selectClass} bind:value={owner} disabled={loading || owners.length === 0}>
						{#each owners as entry (entry.login)}
							<option value={entry.login}>{entry.login}{entry.kind === 'org' ? ' (organisation)' : ''}</option>
						{/each}
					</select>

					<span class="text-xs font-medium text-slate-600 dark:text-slate-300">Name</span>
					<div>
						<input class={inputClass} bind:value={name} placeholder="my-project" />
						{#if name && !nameValid}<p class="m-0 mt-1 text-[11px] text-red-500">Letters, numbers, dots, dashes and underscores only.</p>{/if}
					</div>

					<span class="text-xs font-medium text-slate-600 dark:text-slate-300">Description</span>
					<input class={inputClass} bind:value={description} placeholder="Optional" maxlength="350" />

					<span class="text-xs font-medium text-slate-600 dark:text-slate-300">Visibility</span>
					<div class="inline-flex p-0.5 w-fit rounded-lg bg-slate-100 dark:bg-slate-800">
						{#each [{ id: true, label: 'Private', icon: 'lucide:lock' }, { id: false, label: 'Public', icon: 'lucide:globe' }] as option (option.label)}
							<button
								type="button"
								class="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md border-none cursor-pointer {isPrivate === option.id ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'bg-transparent text-slate-500'}"
								onclick={() => (isPrivate = option.id)}
							>
								<Icon name={option.icon as 'lucide:lock'} class="w-3.5 h-3.5" />{option.label}
							</button>
						{/each}
					</div>
				</div>

				{#if templates && (templates.gitignore.length > 0 || !templates.existing.readme)}
					<div class="space-y-2 pt-3 border-t border-slate-200 dark:border-slate-800">
						<p class="m-0 text-xs font-semibold text-slate-500">Add files</p>
						{#if templates.gitignore.length > 0 && !templates.existing.gitignore}
							<label class="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
								<span class="w-20 shrink-0">.gitignore</span>
								<select class={selectClass} bind:value={gitignore}>
									<option value="">None</option>
									{#each templates.gitignore as entry (entry.key)}
										<option value={entry.key}>{entry.name}{entry.key === templates.suggestedGitignore ? ' (matches this project)' : ''}</option>
									{/each}
								</select>
							</label>
						{/if}
						{#if templates.licenses.length > 0 && !templates.existing.license}
							<label class="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
								<span class="w-20 shrink-0">License</span>
								<select class={selectClass} bind:value={license}>
									<option value="">None</option>
									{#each templates.licenses as entry (entry.key)}
										<option value={entry.key}>{entry.name}</option>
									{/each}
								</select>
							</label>
						{/if}
						{#if !templates.existing.readme}
							<label class="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
								<input type="checkbox" bind:checked={readme} />
								Add a README with the name and description
							</label>
						{/if}
					</div>
				{/if}

				{#if templates?.needsFirstCommit}
					<label class="flex items-start gap-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
						<input type="checkbox" class="mt-0.5" bind:checked={firstCommit} />
						<span>
							This repository has no commits yet. Commit {templates.pendingFiles === 1 ? 'the 1 file' : `all ${templates.pendingFiles} files`} as "Initial commit" so there is something to push.
							<span class="block text-[11px] text-slate-500">Check the Changes list for anything that should not be published first.</span>
						</span>
					</label>
				{/if}

				<details class="group">
					<summary class="flex items-center gap-1 text-xs text-slate-500 cursor-pointer list-none">
						<Icon name="lucide:chevron-right" class="w-3.5 h-3.5 transition-transform group-open:rotate-90" />
						Remote
					</summary>
					<div class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 pt-2">
						<span class="text-xs text-slate-600 dark:text-slate-300">Name</span>
						<div>
							<input class={inputClass} bind:value={remoteName} />
							{#if remoteTaken}<p class="m-0 mt-1 text-[11px] text-red-500">A remote with this name already exists.</p>{/if}
						</div>
						<span class="text-xs text-slate-600 dark:text-slate-300">Protocol</span>
						<select class={selectClass} bind:value={protocol}>
							<option value="https">HTTPS — uses this account's sign-in</option>
							<option value="ssh">SSH — uses your SSH key</option>
						</select>
					</div>
				</details>

				{#if error}<p class="m-0 text-xs text-red-500 break-words">{error}</p>{/if}
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={onClose}>Cancel</Button>
		{#if accounts.length > 0}
			<Button loading={publishing} disabled={!canPublish || loading} onclick={publish}>
				{isPrivate ? 'Publish privately' : 'Publish publicly'}
			</Button>
		{/if}
	{/snippet}
</Modal>
