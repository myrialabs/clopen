<script lang="ts">
	/**
	 * Settings → Git Accounts.
	 *
	 * One list of reusable identities, and an editor. The editor is deliberately
	 * shaped around what a user is trying to do — "commit as me, push to this
	 * host" — rather than around the database row, so the credential fields only
	 * appear once a method has been chosen.
	 *
	 * Secrets are write-only. A stored key or token comes back from the server as
	 * a boolean, so the form shows "a key is stored" and leaves the field empty;
	 * submitting an empty field keeps what is stored rather than clearing it.
	 * Clearing is its own explicit action.
	 */
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Input from '$frontend/components/common/form/Input.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import { gitIdentityStore } from '$frontend/stores/features/git-identity.svelte';
	import { integrationsStore } from '$frontend/stores/features/integrations.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { debug } from '$shared/utils/logger';
	import type { GitIdentityAuthMethod, GitIdentityDTO } from '$shared/types/git-identity';

	interface Props {
		showHeader?: boolean;
	}
	const { showHeader = true }: Props = $props();

	const identities = $derived(gitIdentityStore.identities);
	const defaultIdentity = $derived(gitIdentityStore.defaultIdentity);
	const currentProjectId = $derived(projectState.currentProject?.id ?? null);

	const METHODS: { value: GitIdentityAuthMethod; label: string; hint: string }[] = [
		{ value: 'none', label: 'Attribution only', hint: 'Name and email. Pushing uses whatever this machine already provides.' },
		{ value: 'ssh-key', label: 'SSH key', hint: 'Generate one here or paste your own.' },
		{ value: 'https-token', label: 'HTTPS token', hint: 'A personal access token, stored encrypted.' },
		{ value: 'https-account', label: 'Connected account', hint: 'Borrow the token from an account in Integrations.' }
	];

	let editing = $state<GitIdentityDTO | null>(null);
	let showEditor = $state(false);
	let saving = $state(false);
	let formError = $state('');
	let generatedKey = $state<{ publicKey: string; fingerprint: string } | null>(null);
	let confirmDelete = $state<{ identity: GitIdentityDTO; projectCount: number } | null>(null);
	let copiedKey = $state(false);

	// The draft. `sshPrivateKey`/`httpsToken` stay empty for an existing identity
	// and are only sent when the user actually types one.
	let draft = $state({
		label: '',
		name: '',
		email: '',
		authMethod: 'none' as GitIdentityAuthMethod,
		hostsText: '',
		sshPrivateKey: '',
		sshPassphrase: '',
		httpsUsername: '',
		httpsToken: '',
		integrationAccountId: '' as string
	});

	const githubAccounts = $derived(
		integrationsStore.accounts.filter((a) => a.provider === 'github')
	);

	function openCreate() {
		editing = null;
		generatedKey = null;
		formError = '';
		draft = {
			label: '',
			name: '',
			email: '',
			authMethod: 'none',
			hostsText: 'github.com',
			sshPrivateKey: '',
			sshPassphrase: '',
			httpsUsername: '',
			httpsToken: '',
			integrationAccountId: ''
		};
		showEditor = true;
	}

	function openEdit(identity: GitIdentityDTO) {
		editing = identity;
		generatedKey = null;
		formError = '';
		draft = {
			label: identity.label,
			name: identity.name,
			email: identity.email,
			authMethod: identity.authMethod,
			hostsText: identity.hosts.join(', '),
			sshPrivateKey: '',
			sshPassphrase: '',
			httpsUsername: identity.httpsUsername ?? '',
			httpsToken: '',
			integrationAccountId: identity.integrationAccountId ?? ''
		};
		showEditor = true;
	}

	function parseHosts(text: string): string[] {
		return text
			.split(/[,\s]+/)
			.map((h) => h.trim().toLowerCase())
			.filter(Boolean);
	}

	async function save() {
		formError = '';
		saving = true;
		try {
			const hosts = parseHosts(draft.hostsText);
			const base = {
				label: draft.label.trim(),
				name: draft.name.trim(),
				email: draft.email.trim(),
				authMethod: draft.authMethod,
				hosts,
				httpsUsername: draft.httpsUsername.trim() || null,
				integrationAccountId: draft.integrationAccountId || null
			};

			// Only send a secret the user actually typed. Omitting the field is how
			// the server is told to keep the stored one.
			const secrets: Record<string, string> = {};
			if (draft.sshPrivateKey.trim()) secrets.sshPrivateKey = draft.sshPrivateKey;
			if (draft.sshPassphrase.trim()) secrets.sshPassphrase = draft.sshPassphrase;
			if (draft.httpsToken.trim()) secrets.httpsToken = draft.httpsToken;

			if (editing) {
				await gitIdentityStore.update(editing.id, { ...base, ...secrets });
			} else {
				await gitIdentityStore.create({ ...base, ...secrets });
			}
			showEditor = false;
			if (currentProjectId) await gitIdentityStore.fetchResolved(currentProjectId);
		} catch (error) {
			formError = error instanceof Error ? error.message : 'Could not save this identity';
			debug.error('git', 'Saving a git identity failed:', error);
		} finally {
			saving = false;
		}
	}

	async function generateKey(identity: GitIdentityDTO) {
		try {
			generatedKey = await gitIdentityStore.generateKey(identity.id);
			// The list changed underneath, so keep the editor showing live values.
			const fresh = gitIdentityStore.identities.find((i) => i.id === identity.id);
			if (fresh) editing = fresh;
		} catch (error) {
			formError = error instanceof Error ? error.message : 'Could not generate a key';
		}
	}

	async function askDelete(identity: GitIdentityDTO) {
		const projectCount = await gitIdentityStore.usage(identity.id);
		confirmDelete = { identity, projectCount };
	}

	async function doDelete() {
		if (!confirmDelete) return;
		try {
			await gitIdentityStore.remove(confirmDelete.identity.id);
			if (currentProjectId) await gitIdentityStore.fetchResolved(currentProjectId);
		} catch (error) {
			debug.error('git', 'Deleting a git identity failed:', error);
		} finally {
			confirmDelete = null;
		}
	}

	async function chooseDefault(identityId: string) {
		if (!identityId) return;
		try {
			await gitIdentityStore.setDefault(identityId);
			// Projects that inherit the default now resolve differently, so the
			// cached answers are dropped rather than left to show the old account.
			gitIdentityStore.invalidateResolved();
		} catch (error) {
			debug.error('git', 'Changing the default git account failed:', error);
		}
	}

	async function copyPublicKey(key: string) {
		try {
			await navigator.clipboard.writeText(key);
			copiedKey = true;
			setTimeout(() => (copiedKey = false), 1500);
		} catch (error) {
			debug.warn('git', 'Clipboard write failed:', error);
		}
	}

	function methodLabel(method: GitIdentityAuthMethod): string {
		return METHODS.find((m) => m.value === method)?.label ?? method;
	}

	onMount(() => {
		void gitIdentityStore.refresh();
		void integrationsStore.refresh();
		if (currentProjectId) void gitIdentityStore.fetchResolved(currentProjectId);
	});

	const publicKeyToShow = $derived(generatedKey?.publicKey ?? editing?.sshPublicKey ?? null);
</script>

<div class="space-y-5">
	{#if showHeader}
		<div>
			<h3 class="text-base font-bold text-slate-900 dark:text-slate-100">Git Accounts</h3>
			<p class="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
				Commit identity and push credentials.
			</p>
		</div>
	{/if}

	<!--
		The default, which is what every project uses unless it picks its own.
		Scoped to all projects rather than the current one: this screen is reached
		from Settings, where "this project" is not a meaningful scope — the
		per-project override lives in the Git panel, next to the commit box.
	-->
	{#if identities.length > 0}
		<div class="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
			<div class="flex items-start justify-between gap-3">
				<div class="min-w-0">
					<p class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
						Default account
					</p>
					{#if defaultIdentity}
						<p class="text-sm font-semibold text-slate-900 dark:text-slate-100 mt-1 truncate">
							{defaultIdentity.name} &lt;{defaultIdentity.email}&gt;
						</p>
					{:else}
						<p class="text-sm text-slate-600 dark:text-slate-300 mt-1">
							None chosen, so commits use whatever this machine is configured with.
						</p>
					{/if}
					<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
						Used by every project that has not chosen its own.
					</p>
				</div>
				<select
					class="text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 px-2 py-1.5 shrink-0"
					value={defaultIdentity?.id ?? ''}
					onchange={(e) => chooseDefault((e.currentTarget as HTMLSelectElement).value)}
				>
					{#each identities as identity (identity.id)}
						<option value={identity.id}>{identity.label}</option>
					{/each}
				</select>
			</div>
		</div>
	{/if}

	<!-- The list -->
	<div class="space-y-2">
		{#if identities.length === 0}
			<div class="rounded-lg border border-dashed border-slate-300 dark:border-slate-600 p-6 text-center">
				<Icon name="lucide:user-round-cog" class="w-8 h-8 mx-auto text-slate-400" />
				<p class="text-sm font-semibold text-slate-700 dark:text-slate-300 mt-2">
					No git accounts yet
				</p>
				<p class="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
					Add one and every commit you make in Clopen — from the Git panel, the terminal, or an
					agent — is authored by it.
				</p>
			</div>
		{:else}
			{#each identities as identity (identity.id)}
				<div class="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0">
							<div class="flex items-center gap-2 flex-wrap">
								<span class="text-sm font-bold text-slate-900 dark:text-slate-100">
									{identity.label}
								</span>
								{#if identity.isDefault}
									<span class="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300">
										Default
									</span>
								{/if}
								<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
									{methodLabel(identity.authMethod)}
								</span>
							</div>
							<p class="text-sm text-slate-600 dark:text-slate-300 mt-1 truncate">
								{identity.name} &lt;{identity.email}&gt;
							</p>
							{#if identity.hosts.length > 0}
								<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
									{identity.hosts.join(', ')}
								</p>
							{:else if identity.authMethod !== 'none'}
								<p class="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
									No host listed, so this credential is never used for a push.
								</p>
							{/if}
						</div>
						<div class="flex items-center gap-1 shrink-0">
							{#if !identity.isDefault}
								<button
									class="p-1.5 rounded-md text-slate-400 hover:text-violet-600 hover:bg-slate-100 dark:hover:bg-slate-800"
									title="Make this the default"
									onclick={() => chooseDefault(identity.id)}
								>
									<Icon name="lucide:star" class="w-4 h-4" />
								</button>
							{/if}
							<button
								class="p-1.5 rounded-md text-slate-400 hover:text-violet-600 hover:bg-slate-100 dark:hover:bg-slate-800"
								title="Edit"
								onclick={() => openEdit(identity)}
							>
								<Icon name="lucide:pencil" class="w-4 h-4" />
							</button>
							{#if identity.canDelete}
								<button
									class="p-1.5 rounded-md text-slate-400 hover:text-rose-600 hover:bg-slate-100 dark:hover:bg-slate-800"
									title="Delete"
									onclick={() => askDelete(identity)}
								>
									<Icon name="lucide:trash-2" class="w-4 h-4" />
								</button>
							{:else}
								<span
									class="p-1.5 text-slate-300 dark:text-slate-600"
									title="Mirrored from this machine's git config, so it cannot be deleted. Edit it instead."
								>
									<Icon name="lucide:lock" class="w-4 h-4" />
								</span>
							{/if}
						</div>
					</div>
				</div>
			{/each}
		{/if}

		<Button variant="outline" size="sm" onclick={openCreate}>
			<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
			Add account
		</Button>
	</div>
</div>

<!-- Editor -->
<Modal isOpen={showEditor} onClose={() => (showEditor = false)} title={editing ? `Edit ${editing.label}` : 'Add git account'} size="lg">
	<div class="space-y-4">
		<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
			<Input bind:value={draft.label} label="Label" placeholder="Work" required />
			<Input bind:value={draft.name} label="Name" placeholder="Ada Lovelace" required />
		</div>
		<Input bind:value={draft.email} label="Email" placeholder="ada@example.com" required />

		<div class="space-y-1">
			<span class="block text-sm font-semibold text-slate-700 dark:text-slate-300">
				Authentication
			</span>
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
				{#each METHODS as method (method.value)}
					<button
						class="text-left p-2.5 rounded-lg border transition-colors {draft.authMethod === method.value
							? 'border-violet-500 bg-violet-50 dark:bg-violet-900/20'
							: 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'}"
						onclick={() => (draft.authMethod = method.value)}
					>
						<span class="block text-sm font-semibold text-slate-900 dark:text-slate-100">
							{method.label}
						</span>
						<span class="block text-xs text-slate-500 dark:text-slate-400 mt-0.5">
							{method.hint}
						</span>
					</button>
				{/each}
			</div>
		</div>

		{#if draft.authMethod !== 'none'}
			<Input
				bind:value={draft.hostsText}
				label="Hosts"
				placeholder="github.com, git.company.com"
			/>
			<p class="text-xs text-slate-500 dark:text-slate-400 -mt-2">
				Which hosts this credential is for. A push is only authenticated with it when the
				remote's host is listed here.
			</p>
		{/if}

		{#if draft.authMethod === 'ssh-key'}
			<div class="space-y-2 rounded-lg border border-slate-200 dark:border-slate-700 p-3">
				{#if editing}
					<div class="flex items-center justify-between gap-2">
						<p class="text-sm text-slate-600 dark:text-slate-300">
							{editing.hasSshKey ? 'A private key is stored.' : 'No key stored yet.'}
						</p>
						<Button variant="outline" size="sm" onclick={() => generateKey(editing!)}>
							{editing.hasSshKey ? 'Replace with a new key' : 'Generate a key'}
						</Button>
					</div>
					{#if publicKeyToShow}
						<div class="space-y-1">
							<span class="block text-xs font-semibold text-slate-500 dark:text-slate-400">
								Public key — add this to your git host
							</span>
							<div class="flex items-start gap-2">
								<code class="flex-1 text-[11px] break-all bg-slate-100 dark:bg-slate-800 rounded p-2 text-slate-700 dark:text-slate-300">
									{publicKeyToShow}
								</code>
								<Button variant="ghost" size="sm" onclick={() => copyPublicKey(publicKeyToShow)}>
									<Icon name={copiedKey ? 'lucide:check' : 'lucide:copy'} class="w-4 h-4" />
								</Button>
							</div>
							{#if generatedKey?.fingerprint}
								<p class="text-[11px] text-slate-500 dark:text-slate-400">
									{generatedKey.fingerprint}
								</p>
							{/if}
						</div>
					{/if}
				{:else}
					<p class="text-sm text-slate-600 dark:text-slate-300">
						Save this account first, then generate a key — or paste your own below.
					</p>
				{/if}

				<div class="space-y-1">
					<label for="git-identity-private-key" class="block text-sm font-semibold text-slate-700 dark:text-slate-300">
						Paste a private key
					</label>
					<textarea
						id="git-identity-private-key"
						bind:value={draft.sshPrivateKey}
						rows="4"
						placeholder={editing?.hasSshKey ? 'Leave empty to keep the stored key' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
						class="block w-full px-3 py-2 text-xs font-mono border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
					></textarea>
				</div>
				<Input
					bind:value={draft.sshPassphrase}
					type="password"
					label="Passphrase"
					placeholder={editing?.hasSshPassphrase ? 'Stored — leave empty to keep it' : 'Only if your key needs one'}
				/>
			</div>
		{/if}

		{#if draft.authMethod === 'https-token'}
			<div class="space-y-3 rounded-lg border border-slate-200 dark:border-slate-700 p-3">
				<Input bind:value={draft.httpsUsername} label="Username" placeholder="your-github-username" />
				<Input
					bind:value={draft.httpsToken}
					type="password"
					label="Token"
					placeholder={editing?.hasHttpsToken ? 'Stored — leave empty to keep it' : 'ghp_…'}
				/>
			</div>
		{/if}

		{#if draft.authMethod === 'https-account'}
			<div class="space-y-2 rounded-lg border border-slate-200 dark:border-slate-700 p-3">
				{#if githubAccounts.length === 0}
					<p class="text-sm text-slate-600 dark:text-slate-300">
						No GitHub account is connected yet. Connect one in Settings → Integrations, then
						pick it here.
					</p>
				{:else}
					<span class="block text-sm font-semibold text-slate-700 dark:text-slate-300">
						Account
					</span>
					<select
						bind:value={draft.integrationAccountId}
						class="block w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
					>
						<option value="">Choose an account…</option>
						{#each githubAccounts as account (account.id)}
							<option value={account.id}>{account.label}</option>
						{/each}
					</select>
					<p class="text-xs text-slate-500 dark:text-slate-400">
						The token stays in Integrations, so rotating it there is enough.
					</p>
				{/if}
			</div>
		{/if}

		{#if formError}
			<p class="text-sm text-rose-600 dark:text-rose-400">{formError}</p>
		{/if}
	</div>

	{#snippet footer()}
		<div class="flex justify-end gap-2">
			<Button variant="ghost" onclick={() => (showEditor = false)}>Cancel</Button>
			<Button onclick={save} loading={saving} disabled={saving}>
				{editing ? 'Save' : 'Add account'}
			</Button>
		</div>
	{/snippet}
</Modal>

<!-- Delete confirmation -->
<Modal
	isOpen={confirmDelete !== null}
	onClose={() => (confirmDelete = null)}
	title="Delete this account?"
	size="sm"
>
	{#if confirmDelete}
		<div class="space-y-2">
			<p class="text-sm text-slate-700 dark:text-slate-300">
				<strong>{confirmDelete.identity.label}</strong> will be removed, along with its stored key
				or token.
			</p>
			{#if confirmDelete.projectCount > 0}
				<p class="text-sm text-amber-600 dark:text-amber-400">
					{confirmDelete.projectCount}
					{confirmDelete.projectCount === 1 ? 'project uses' : 'projects use'} it and will fall
					back to your default.
				</p>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		<div class="flex justify-end gap-2">
			<Button variant="ghost" onclick={() => (confirmDelete = null)}>Cancel</Button>
			<Button variant="danger" onclick={doDelete}>Delete</Button>
		</div>
	{/snippet}
</Modal>
