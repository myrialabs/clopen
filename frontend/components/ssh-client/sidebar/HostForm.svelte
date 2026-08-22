<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import PathBrowser from '$frontend/components/common/form/PathBrowser.svelte';
	import { sshClientStore } from '$frontend/stores/features/ssh-client.svelte';
	import type {
		SshAuthMethod,
		SshConnection,
		SshConnectionInput,
		SshHealth
	} from '$shared/types/ssh';

	interface Props {
		connection?: SshConnection | null;
		onSaved?: (connection: SshConnection) => void;
		onCancel?: () => void;
	}

	const { connection = null, onSaved, onCancel }: Props = $props();

	const AUTH_LABELS: Record<SshAuthMethod, string> = {
		password: 'Password',
		key: 'Private key (pasted)',
		'key-file': 'Private key file on the server',
		agent: 'ssh-agent'
	};

	const initial = untrack(() => connection);

	let name = $state(initial?.name ?? '');
	let host = $state(initial?.host ?? '');
	let port = $state<number>(initial?.port ?? 22);
	let username = $state(initial?.username ?? '');
	let authMethod = $state<SshAuthMethod>(initial?.authMethod ?? 'password');
	let password = $state('');
	let privateKey = $state('');
	let privateKeyPath = $state(initial?.privateKeyPath ?? '');
	let passphrase = $state('');
	let agentSocket = $state(initial?.agentSocket ?? '');
	let jumpConnectionId = $state<string>(initial?.jumpConnectionId ?? '');
	let initialPath = $state(initial?.initialPath ?? '');
	let keepaliveSeconds = $state<number>(initial?.keepaliveSeconds ?? 30);
	let strictHostKey = $state(initial?.strictHostKey ?? true);

	let keyFilePickerOpen = $state(false);
	let testing = $state(false);
	let saving = $state(false);
	let testResult = $state<SshHealth | null>(null);
	let formError = $state<string | null>(null);

	// A host cannot jump through itself, and only saved hosts can be jumped through.
	const jumpCandidates = $derived(
		sshClientStore.connections.filter((candidate) => candidate.id !== initial?.id)
	);

	// ssh2 cannot parse PKCS8 ed25519 keys; catching it here beats a cryptic
	// handshake failure later. Same check the db-client SSH form makes.
	const looksLikePkcs8Ed25519 = $derived(
		authMethod === 'key' && privateKey.includes('BEGIN PRIVATE KEY') && privateKey.length < 600
	);

	// An existing connection's secrets are never sent to the browser, so an empty
	// field means "unchanged" rather than "missing" when editing.
	const secretIsStored = $derived(initial !== null && initial.authMethod === authMethod);

	function buildInput(): SshConnectionInput {
		return {
			name: name.trim(),
			host: host.trim(),
			port: port || 22,
			username: username.trim(),
			authMethod,
			password: authMethod === 'password' ? password || undefined : undefined,
			privateKey: authMethod === 'key' ? privateKey || undefined : undefined,
			privateKeyPath: authMethod === 'key-file' ? privateKeyPath.trim() : undefined,
			passphrase:
				authMethod === 'key' || authMethod === 'key-file' ? passphrase || undefined : undefined,
			agentSocket: authMethod === 'agent' ? agentSocket.trim() : undefined,
			jumpConnectionId: jumpConnectionId || null,
			initialPath: initialPath.trim(),
			keepaliveSeconds,
			strictHostKey
		};
	}

	function validate(): string | null {
		if (!name.trim()) return 'Name is required';
		if (!host.trim()) return 'Host is required';
		if (!username.trim()) return 'Username is required';
		if (authMethod === 'password' && !password && !secretIsStored) return 'Password is required';
		if (authMethod === 'key' && !privateKey.trim() && !secretIsStored) {
			return 'Private key is required';
		}
		if (authMethod === 'key-file' && !privateKeyPath.trim()) return 'Key file path is required';
		return null;
	}

	async function onTest(): Promise<void> {
		const error = validate();
		if (error) {
			formError = error;
			testResult = null;
			return;
		}
		formError = null;
		testing = true;
		testResult = null;
		try {
			// Editing an existing host whose secret was not re-typed has nothing to
			// send, so test the saved record rather than the half-filled form.
			const formCarriesCredential =
				!secretIsStored ||
				password !== '' ||
				privateKey !== '' ||
				authMethod === 'agent' ||
				authMethod === 'key-file';
			testResult = await sshClientStore.test(
				formCarriesCredential || !initial ? buildInput() : { id: initial.id }
			);
		} catch (error) {
			testResult = {
				ok: false,
				latencyMs: null,
				serverBanner: null,
				remoteOs: null,
				hostKeyFingerprint: null,
				hostKeyChanged: false,
				suspended: false,
				error: error instanceof Error ? error.message : String(error)
			};
		} finally {
			testing = false;
		}
	}

	async function onSave(): Promise<void> {
		const error = validate();
		if (error) {
			formError = error;
			return;
		}
		formError = null;
		saving = true;
		try {
			const input = buildInput();
			const saved = connection
				? await sshClientStore.update(connection.id, input)
				: await sshClientStore.create(input);
			onSaved?.(saved);
		} catch (error) {
			formError = error instanceof Error ? error.message : 'Save failed';
		} finally {
			saving = false;
		}
	}

	const fieldClass =
		'px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100';
</script>

<div class="flex flex-col gap-3">
	<label class="flex flex-col gap-1">
		<span class="text-xs text-slate-500 dark:text-slate-400">Name</span>
		<input type="text" bind:value={name} class={fieldClass} placeholder="Production web server" />
	</label>

	<div class="grid grid-cols-3 gap-2">
		<label class="col-span-2 flex flex-col gap-1">
			<span class="text-xs text-slate-500 dark:text-slate-400">Host</span>
			<input type="text" bind:value={host} placeholder="example.com" class={fieldClass} />
		</label>
		<label class="flex flex-col gap-1">
			<span class="text-xs text-slate-500 dark:text-slate-400">Port</span>
			<input type="number" bind:value={port} class={fieldClass} />
		</label>
	</div>

	<label class="flex flex-col gap-1">
		<span class="text-xs text-slate-500 dark:text-slate-400">Username</span>
		<input type="text" bind:value={username} placeholder="root" class={fieldClass} />
	</label>

	<label class="flex flex-col gap-1">
		<span class="text-xs text-slate-500 dark:text-slate-400">Authentication</span>
		<select bind:value={authMethod} class={fieldClass}>
			{#each Object.entries(AUTH_LABELS) as [value, label] (value)}
				<option {value}>{label}</option>
			{/each}
		</select>
	</label>

	{#if authMethod === 'password'}
		<label class="flex flex-col gap-1">
			<span class="text-xs text-slate-500 dark:text-slate-400">
				Password
				{#if secretIsStored}
					<span class="text-slate-400">(leave blank to keep the saved one)</span>
				{/if}
			</span>
			<input type="password" bind:value={password} class={fieldClass} />
		</label>
	{:else if authMethod === 'key'}
		<label class="flex flex-col gap-1">
			<span class="text-xs text-slate-500 dark:text-slate-400">
				Private key (PEM)
				{#if secretIsStored}
					<span class="text-slate-400">(leave blank to keep the saved one)</span>
				{/if}
			</span>
			<textarea
				bind:value={privateKey}
				rows="4"
				placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
				class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-xs text-slate-900 dark:text-slate-100"
			></textarea>
			{#if looksLikePkcs8Ed25519}
				<span class="text-xs text-amber-600 dark:text-amber-400">
					This looks like a PKCS8 ed25519 key. ssh2 cannot parse those — re-export as OpenSSH
					(<code>ssh-keygen -p -m PEM</code>) or use an RSA PKCS1 key.
				</span>
			{/if}
		</label>
	{:else if authMethod === 'key-file'}
		<label class="flex flex-col gap-1">
			<span class="text-xs text-slate-500 dark:text-slate-400">
				Key file path <span class="text-slate-400">(on the Clopen server)</span>
			</span>
			<div class="flex items-center gap-2">
				<input
					type="text"
					bind:value={privateKeyPath}
					placeholder="~/.ssh/id_ed25519"
					class="flex-1 min-w-0 {fieldClass}"
				/>
				<button
					type="button"
					class="flex shrink-0 p-2 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
					onclick={() => (keyFilePickerOpen = true)}
					title="Browse for a key file"
					aria-label="Browse for a key file"
				>
					<Icon name="lucide:folder-open" class="w-4 h-4" />
				</button>
			</div>
			<span class="text-xs text-slate-500 dark:text-slate-500">
				The key is read at connect time and never stored in Clopen's database.
			</span>
		</label>
	{:else}
		<label class="flex flex-col gap-1">
			<span class="text-xs text-slate-500 dark:text-slate-400">
				Agent socket <span class="text-slate-400">(optional)</span>
			</span>
			<input
				type="text"
				bind:value={agentSocket}
				placeholder="$SSH_AUTH_SOCK"
				class={fieldClass}
			/>
			<span class="text-xs text-slate-500 dark:text-slate-500">
				Leave blank to use the agent the Clopen server itself is running with.
			</span>
		</label>
	{/if}

	{#if authMethod === 'key' || authMethod === 'key-file'}
		<label class="flex flex-col gap-1">
			<span class="text-xs text-slate-500 dark:text-slate-400">
				Passphrase <span class="text-slate-400">(optional)</span>
			</span>
			<input type="password" bind:value={passphrase} class={fieldClass} />
		</label>
	{/if}

	<div class="border-t border-slate-200 dark:border-slate-800 pt-3 flex flex-col gap-3">
		<label class="flex flex-col gap-1">
			<span class="text-xs text-slate-500 dark:text-slate-400">
				Connect through <span class="text-slate-400">(optional jump host)</span>
			</span>
			<select bind:value={jumpConnectionId} class={fieldClass}>
				<option value="">Connect directly</option>
				{#each jumpCandidates as candidate (candidate.id)}
					<option value={candidate.id}>{candidate.name} ({candidate.host})</option>
				{/each}
			</select>
		</label>

		<label class="flex flex-col gap-1">
			<span class="text-xs text-slate-500 dark:text-slate-400">
				Start in <span class="text-slate-400">(optional remote directory)</span>
			</span>
			<input type="text" bind:value={initialPath} placeholder="/var/www" class={fieldClass} />
		</label>

		<label class="flex flex-col gap-1">
			<span class="text-xs text-slate-500 dark:text-slate-400">
				Keepalive <span class="text-slate-400">(seconds, 0 disables)</span>
			</span>
			<input type="number" bind:value={keepaliveSeconds} min="0" class={fieldClass} />
		</label>

		<button
			type="button"
			class="flex items-center justify-between w-full text-sm text-slate-700 dark:text-slate-300 cursor-pointer"
			onclick={() => (strictHostKey = !strictHostKey)}
		>
			<span class="flex items-center gap-2">
				<Icon name="lucide:shield-check" class="w-4 h-4" />
				Verify host key
			</span>
			<span
				class="text-xs px-2 py-0.5 rounded-full {strictHostKey
					? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300'
					: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'}"
			>
				{strictHostKey ? 'On' : 'Off'}
			</span>
		</button>
		<span class="text-xs text-slate-500 dark:text-slate-500 -mt-2">
			Blocks the connection if the host's key changes after the first connect. Turn off only on a
			network you trust.
		</span>
	</div>

	<PathBrowser
		bind:isOpen={keyFilePickerOpen}
		mode="file"
		title="Select Private Key"
		confirmText="Use Key"
		initialPath={privateKeyPath.trim()}
		allowFolderActions={false}
		onClose={() => (keyFilePickerOpen = false)}
		onSelect={(path) => {
			privateKeyPath = path;
			keyFilePickerOpen = false;
		}}
	/>

	{#if testResult}
		<div
			class="flex items-start gap-2 px-3 py-2 rounded-md text-xs {testResult.ok
				? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300'
				: 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'}"
		>
			<Icon
				name={testResult.ok ? 'lucide:circle-check' : 'lucide:circle-x'}
				class="w-4 h-4 shrink-0 mt-0.5"
			/>
			<div class="flex-1">
				{#if testResult.ok}
					<div class="font-semibold">Connected</div>
					<div class="opacity-80">
						{testResult.remoteOs ?? testResult.serverBanner ?? 'reachable'}
						{#if testResult.latencyMs !== null}
							• {testResult.latencyMs}ms
						{/if}
					</div>
					{#if testResult.hostKeyFingerprint}
						<div class="opacity-70 mt-0.5 wrap-anywhere">{testResult.hostKeyFingerprint}</div>
					{/if}
				{:else}
					<div class="font-semibold">
						{testResult.hostKeyChanged ? 'Host key changed' : 'Failed'}
					</div>
					<div class="opacity-80 whitespace-pre-wrap wrap-anywhere">
						{testResult.error ?? 'Unknown error'}
					</div>
				{/if}
			</div>
		</div>
	{/if}

	{#if formError}
		<div
			class="px-3 py-2 rounded-md text-xs bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300"
		>
			{formError}
		</div>
	{/if}

	<div class="flex items-center justify-end gap-2 pt-1">
		{#if onCancel}
			<button
				type="button"
				class="px-3 py-1.5 text-sm rounded-md text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
				onclick={onCancel}
				disabled={saving || testing}
			>
				Cancel
			</button>
		{/if}
		<button
			type="button"
			class="px-3 py-1.5 text-sm rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
			onclick={onTest}
			disabled={testing || saving}
		>
			{testing ? 'Testing…' : 'Test'}
		</button>
		<button
			type="button"
			class="px-3 py-1.5 text-sm rounded-md bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50"
			onclick={onSave}
			disabled={saving || testing}
		>
			{saving ? 'Saving…' : connection ? 'Update' : 'Create'}
		</button>
	</div>
</div>
