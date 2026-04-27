<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';
	import type {
		DbClientConnection,
		DbClientConnectionInput,
		DbClientHealth,
		DbDriver,
		DbSshAuthMethod
	} from '$shared/types/db-client';

	interface Props {
		connection?: DbClientConnection | null;
		onSaved?: (conn: DbClientConnection) => void;
		onCancel?: () => void;
	}

	const { connection = null, onSaved, onCancel }: Props = $props();

	const DEFAULT_PORTS: Record<DbDriver, number | null> = {
		mysql: 3306,
		postgres: 5432,
		mongodb: 27017,
		redis: 6379,
		sqlite: null
	};

	const DRIVER_LABELS: Record<DbDriver, string> = {
		mysql: 'MySQL',
		postgres: 'PostgreSQL',
		sqlite: 'SQLite',
		mongodb: 'MongoDB',
		redis: 'Redis'
	};

	const initial = untrack(() => connection);

	let name = $state(initial?.name ?? '');
	let driver = $state<DbDriver>(initial?.driver ?? 'mysql');
	let host = $state(initial?.host ?? '');
	let port = $state<number | null>(initial?.port ?? null);
	let username = $state(initial?.username ?? '');
	let password = $state(initial?.password ?? '');
	let database = $state(initial?.database ?? '');

	let sshEnabled = $state(initial?.ssh.enabled ?? false);
	let sshHost = $state(initial?.ssh.host ?? '');
	let sshPort = $state<number>(initial?.ssh.port ?? 22);
	let sshUsername = $state(initial?.ssh.username ?? '');
	let sshAuthMethod = $state<DbSshAuthMethod>(initial?.ssh.authMethod ?? 'password');
	let sshPassword = $state(initial?.ssh.password ?? '');
	let sshPrivateKey = $state(initial?.ssh.privateKey ?? '');
	let sshPassphrase = $state(initial?.ssh.passphrase ?? '');

	let testing = $state(false);
	let saving = $state(false);
	let testResult = $state<DbClientHealth | null>(null);
	let formError = $state<string | null>(null);

	const isSqlite = $derived(driver === 'sqlite');
	const showHostFields = $derived(!isSqlite);

	const hostPlaceholder = '127.0.0.1';
	const portPlaceholder = $derived(DEFAULT_PORTS[driver]?.toString() ?? '');

	const looksLikePkcs8Ed25519 = $derived(
		sshAuthMethod === 'key' &&
		sshPrivateKey.includes('BEGIN PRIVATE KEY') &&
		sshPrivateKey.length < 600
	);

	function onDriverChange(next: DbDriver): void {
		driver = next;
		// SQLite stores its file path in `database` and skips host/port — clear stale values
		// so they don't accidentally get persisted.
		if (next === 'sqlite') {
			host = '';
			port = null;
		}
	}

	function buildInput(): DbClientConnectionInput {
		const ssh = sshEnabled
			? {
					enabled: true,
					host: sshHost,
					port: sshPort || 22,
					username: sshUsername,
					authMethod: sshAuthMethod,
					password: sshAuthMethod === 'password' ? sshPassword : undefined,
					privateKey: sshAuthMethod === 'key' ? sshPrivateKey : undefined,
					passphrase: sshAuthMethod === 'key' ? sshPassphrase : undefined
				}
			: { enabled: false };

		const resolvedHost = showHostFields ? (host.trim() || hostPlaceholder) : undefined;
		const resolvedPort = showHostFields ? (port ?? DEFAULT_PORTS[driver] ?? undefined) : undefined;

		return {
			name: name.trim(),
			driver,
			host: resolvedHost,
			port: resolvedPort,
			username: username || undefined,
			password: password || undefined,
			database: database || undefined,
			ssh
		};
	}

	function validate(): string | null {
		if (!name.trim()) return 'Name is required';
		if (driver === 'sqlite' && !database.trim()) return 'SQLite needs a file path in Database field';
		if (sshEnabled) {
			if (!sshHost.trim()) return 'SSH host is required';
			if (!sshUsername.trim()) return 'SSH username is required';
			if (sshAuthMethod === 'password' && !sshPassword) return 'SSH password is required';
			if (sshAuthMethod === 'key' && !sshPrivateKey.trim()) return 'SSH private key is required';
		}
		return null;
	}

	async function onTest(): Promise<void> {
		const err = validate();
		if (err) {
			formError = err;
			testResult = null;
			return;
		}
		formError = null;
		testing = true;
		testResult = null;
		try {
			testResult = await dbClientStore.test(buildInput());
		} catch (e) {
			testResult = {
				ok: false,
				latencyMs: null,
				serverVersion: null,
				sshOk: null,
				error: e instanceof Error ? e.message : String(e)
			};
		} finally {
			testing = false;
		}
	}

	async function onSave(): Promise<void> {
		const err = validate();
		if (err) {
			formError = err;
			return;
		}
		formError = null;
		saving = true;
		try {
			const input = buildInput();
			const saved = connection
				? await dbClientStore.update(connection.id, input)
				: await dbClientStore.create(input);
			onSaved?.(saved);
		} catch (e) {
			formError = e instanceof Error ? e.message : 'Save failed';
		} finally {
			saving = false;
		}
	}
</script>

<div class="flex flex-col gap-3">
	<label class="flex flex-col gap-1">
		<span class="text-xs text-slate-500 dark:text-slate-400">Name</span>
		<input
			type="text"
			bind:value={name}
			class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
		/>
	</label>

	<label class="flex flex-col gap-1">
		<span class="text-xs text-slate-500 dark:text-slate-400">Driver</span>
		<select
			value={driver}
			onchange={(e) => onDriverChange((e.currentTarget as HTMLSelectElement).value as DbDriver)}
			class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
		>
			{#each Object.entries(DRIVER_LABELS) as [value, label] (value)}
				<option {value}>{label}</option>
			{/each}
		</select>
	</label>

	{#if showHostFields}
		<div class="grid grid-cols-3 gap-2">
			<label class="col-span-2 flex flex-col gap-1">
				<span class="text-xs text-slate-500 dark:text-slate-400">Host</span>
				<input
					type="text"
					bind:value={host}
					placeholder={hostPlaceholder}
					class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
				/>
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-xs text-slate-500 dark:text-slate-400">Port</span>
				<input
					type="number"
					value={port ?? ''}
					placeholder={portPlaceholder}
					oninput={(e) => {
						const v = (e.currentTarget as HTMLInputElement).value;
						port = v === '' ? null : Number(v);
					}}
					class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
				/>
			</label>
		</div>

		<div class="grid grid-cols-2 gap-2">
			<label class="flex flex-col gap-1">
				<span class="text-xs text-slate-500 dark:text-slate-400">Username</span>
				<input
					type="text"
					bind:value={username}
					class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
				/>
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-xs text-slate-500 dark:text-slate-400">Password</span>
				<input
					type="password"
					bind:value={password}
					class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
				/>
			</label>
		</div>
	{/if}

	<label class="flex flex-col gap-1">
		<span class="text-xs text-slate-500 dark:text-slate-400">
			Database
			{#if !isSqlite}
				<span class="text-slate-400">(optional — leave blank to list all)</span>
			{:else}
				<span class="text-slate-400">(file path)</span>
			{/if}
		</span>
		<input
			type="text"
			bind:value={database}
			placeholder={isSqlite ? '/absolute/path/to.db' : ''}
			class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
		/>
	</label>

	<!-- SSH section -->
	<div class="border-t border-slate-200 dark:border-slate-800 pt-3">
		<button
			type="button"
			class="flex items-center justify-between w-full text-sm font-medium text-slate-700 dark:text-slate-300 cursor-pointer"
			onclick={() => (sshEnabled = !sshEnabled)}
		>
			<span class="flex items-center gap-2">
				<Icon name="lucide:key" class="w-4 h-4" />
				SSH Tunnel
			</span>
			<span
				class="text-xs px-2 py-0.5 rounded-full {sshEnabled
					? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300'
					: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'}"
			>
				{sshEnabled ? 'On' : 'Off'}
			</span>
		</button>

		{#if sshEnabled}
			<div class="mt-3 flex flex-col gap-2">
				<div class="grid grid-cols-3 gap-2">
					<label class="col-span-2 flex flex-col gap-1">
						<span class="text-xs text-slate-500 dark:text-slate-400">SSH Host</span>
						<input
							type="text"
							bind:value={sshHost}
							class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
						/>
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs text-slate-500 dark:text-slate-400">SSH Port</span>
						<input
							type="number"
							bind:value={sshPort}
							class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
						/>
					</label>
				</div>

				<label class="flex flex-col gap-1">
					<span class="text-xs text-slate-500 dark:text-slate-400">SSH Username</span>
					<input
						type="text"
						bind:value={sshUsername}
						class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
					/>
				</label>

				<label class="flex flex-col gap-1">
					<span class="text-xs text-slate-500 dark:text-slate-400">SSH Auth Method</span>
					<select
						bind:value={sshAuthMethod}
						class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
					>
						<option value="password">Password</option>
						<option value="key">Private Key</option>
					</select>
				</label>

				{#if sshAuthMethod === 'password'}
					<label class="flex flex-col gap-1">
						<span class="text-xs text-slate-500 dark:text-slate-400">SSH Password</span>
						<input
							type="password"
							bind:value={sshPassword}
							class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
						/>
					</label>
				{:else}
					<label class="flex flex-col gap-1">
						<span class="text-xs text-slate-500 dark:text-slate-400">SSH Private Key (PEM)</span>
						<textarea
							bind:value={sshPrivateKey}
							rows="4"
							placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
							class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-xs text-slate-900 dark:text-slate-100"
						></textarea>
						{#if looksLikePkcs8Ed25519}
							<span class="text-xs text-amber-600 dark:text-amber-400">
								This looks like a PKCS8 ed25519 key. ssh2 cannot parse those — re-export as OpenSSH (`ssh-keygen -p -m PEM`) or use an RSA PKCS1 key.
							</span>
						{/if}
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs text-slate-500 dark:text-slate-400">Passphrase (optional)</span>
						<input
							type="password"
							bind:value={sshPassphrase}
							class="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100"
						/>
					</label>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Test result -->
	{#if testResult}
		<div
			class="flex items-start gap-2 px-3 py-2 rounded-md text-xs {testResult.ok
				? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300'
				: 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'}"
		>
			<Icon name={testResult.ok ? 'lucide:circle-check' : 'lucide:circle-x'} class="w-4 h-4 shrink-0 mt-0.5" />
			<div class="flex-1">
				{#if testResult.ok}
					<div class="font-semibold">Connected</div>
					<div class="opacity-80">
						{testResult.serverVersion ?? 'unknown version'}
						{#if testResult.latencyMs !== null}
							• {testResult.latencyMs}ms
						{/if}
						{#if testResult.sshOk === true}
							• ssh ok
						{/if}
					</div>
				{:else}
					<div class="font-semibold">Failed</div>
					<div class="opacity-80 wrap-anywhere">{testResult.error ?? 'Unknown error'}</div>
					{#if testResult.sshOk === false}
						<div class="opacity-80">SSH tunnel failed.</div>
					{/if}
				{/if}
			</div>
		</div>
	{/if}

	{#if formError}
		<div class="px-3 py-2 rounded-md text-xs bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300">
			{formError}
		</div>
	{/if}

	<div class="flex items-center justify-end gap-2 pt-1">
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
