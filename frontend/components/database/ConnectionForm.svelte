<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import SshTunnelSection from './SshTunnelSection.svelte';
	import type { DBConnectionConfig, DBType } from '$shared/types/db-manager';
	import type { SSHTunnelConfig } from '$shared/types/ssh-tunnel';
	import {
		DB_TYPE_LABELS,
		DB_TYPE_COLORS,
		DB_DEFAULT_PORTS,
		DB_TYPES
	} from '$shared/types/db-manager';
	import {
		createConnection,
		updateConnection,
		testConnectionConfig,
		resetTestResult,
		dbManagerState
	} from '$frontend/stores/features/db-manager.svelte';

	interface Props {
		connection?: DBConnectionConfig | null;
		onSaved?: (conn: DBConnectionConfig) => void;
		onCancel?: () => void;
	}

	let { connection = null, onSaved, onCancel }: Props = $props();

	const isEdit = $derived(!!connection);

	// Initialize form fields; reset when connection prop changes (e.g. switching between edit targets)
	let name = $state('');
	let type = $state<DBType>('postgresql');
	let color = $state('');
	let path = $state('');
	let host = $state('localhost');
	let port = $state<number | ''>('');
	let database = $state('');
	let username = $state('');
	let password = $state('');
	let ssl = $state(false);
	let showPassword = $state(false);
	let sshTunnel = $state<SSHTunnelConfig | undefined>(undefined);

	$effect(() => {
		name = connection?.name ?? '';
		type = connection?.type ?? 'postgresql';
		color = connection?.color ?? '';
		path = connection?.path ?? '';
		host = connection?.host ?? 'localhost';
		port = connection?.port ?? '';
		database = connection?.database ?? '';
		username = connection?.username ?? '';
		password = connection?.password ?? '';
		ssl = connection?.ssl ?? false;
		sshTunnel = connection?.sshTunnel ?? undefined;
	});

	const isSqlite = $derived(type === 'sqlite');

	const defaultPort = $derived(DB_DEFAULT_PORTS[type]);

	// Track previous type to detect when user switches DB type (not reactive)
	let prevType: DBType = 'postgresql';

	// When type changes, auto-set default port if port is empty, matches the old type's default, or came from SQLite (no port)
	$effect(() => {
		const def = DB_DEFAULT_PORTS[type];
		const prevDef = DB_DEFAULT_PORTS[prevType];
		if (def && (!port || port === prevDef || prevDef === null)) port = def;
		prevType = type;
	});

	function buildConnectionPayload(includeMetadata = false): any {
		const data: any = { type };
		if (includeMetadata) {
			data.name = name;
			if (color) data.color = color;
		}
		if (isSqlite) {
			data.path = path;
		} else {
			data.host = host;
			if (port) data.port = Number(port);
			if (database) data.database = database;
			if (username) data.username = username;
			if (password) data.password = password;
			data.ssl = ssl;
		}
		if (sshTunnel?.enabled) data.sshTunnel = sshTunnel;
		return data;
	}

	async function handleTest() {
		resetTestResult();
		await testConnectionConfig(buildConnectionPayload());
	}

	async function handleSave() {
		const data = buildConnectionPayload(true);
		let result: DBConnectionConfig | null = null;
		if (isEdit && connection) {
			result = await updateConnection(connection.id, data);
		} else {
			result = await createConnection(data);
		}
		if (result) onSaved?.(result);
	}

	const isValid = $derived(
		name.trim().length > 0 && (isSqlite ? path.trim().length > 0 : host.trim().length > 0)
	);
</script>

<div class="flex flex-col gap-5 p-5 h-full overflow-y-auto">
	<!-- Header -->
	<div class="flex items-center gap-3">
		<div
			class="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
			style="background-color: {DB_TYPE_COLORS[type]}20"
		>
			<span style="color: {DB_TYPE_COLORS[type]}">
				<Icon name="lucide:database" class="w-5 h-5" />
			</span>
		</div>
		<div>
			<h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">
				{isEdit ? 'Edit Connection' : 'New Connection'}
			</h3>
			<p class="text-xs text-slate-500 dark:text-slate-400">Configure your database connection</p>
		</div>
	</div>

	<!-- DB Type selector -->
	<div>
		<label class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-2 uppercase tracking-wide">
			Database Type
		</label>
		<div class="grid grid-cols-4 gap-2">
			{#each DB_TYPES as dbType}
				<button
					type="button"
					class="flex flex-col items-center gap-1.5 py-2.5 px-2 rounded-lg border text-xs font-medium cursor-pointer transition-all duration-150
						{type === dbType
							? 'border-violet-500/60 bg-violet-500/10 text-violet-700 dark:text-violet-300'
							: 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/50 text-slate-600 dark:text-slate-400 hover:border-violet-400/50 hover:bg-violet-500/5'}"
					onclick={() => { type = dbType; resetTestResult(); }}
				>
					<span
						class="w-4 h-4 rounded-full shrink-0"
						style="background-color: {DB_TYPE_COLORS[dbType]}"
					></span>
					{DB_TYPE_LABELS[dbType]}
				</button>
			{/each}
		</div>
	</div>

	<!-- Connection name -->
	<div>
		<label class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
			Connection Name *
		</label>
		<input
			type="text"
			bind:value={name}
			placeholder="My Database"
			class="w-full px-3 py-2.5 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 transition-colors"
		/>
	</div>

	{#if isSqlite}
		<!-- SQLite: file path -->
		<div>
			<label class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
				Database File Path *
			</label>
			<input
				type="text"
				bind:value={path}
				placeholder="/path/to/database.db"
				class="w-full px-3 py-2.5 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 font-mono placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 transition-colors"
			/>
			<p class="mt-1 text-xs text-slate-500">Absolute path to the SQLite database file</p>
		</div>
	{:else}
		<!-- Server-based connection -->
		<div class="grid grid-cols-[1fr_auto] gap-3">
			<div>
				<label class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
					Host *
				</label>
				<input
					type="text"
					bind:value={host}
					placeholder="localhost"
					class="w-full px-3 py-2.5 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 transition-colors"
				/>
			</div>
			<div class="w-24">
				<label class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
					Port
				</label>
				<input
					type="number"
					bind:value={port}
					placeholder={String(defaultPort ?? '')}
					class="w-full px-3 py-2.5 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 transition-colors"
				/>
			</div>
		</div>

		<div>
			<label class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
				Database
			</label>
			<input
				type="text"
				bind:value={database}
				placeholder="mydb"
				class="w-full px-3 py-2.5 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 transition-colors"
			/>
		</div>

		<div class="grid grid-cols-2 gap-3">
			<div>
				<label class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
					Username
				</label>
				<input
					type="text"
					bind:value={username}
					placeholder="user"
					autocomplete="off"
					class="w-full px-3 py-2.5 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 transition-colors"
				/>
			</div>
			<div>
				<label class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
					Password
				</label>
				<div class="relative">
					<input
						type={showPassword ? 'text' : 'password'}
						bind:value={password}
						placeholder="••••••••"
						autocomplete="off"
						class="w-full px-3 py-2.5 pr-9 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 transition-colors"
					/>
					<button
						type="button"
						class="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
						onclick={() => (showPassword = !showPassword)}
					>
						<Icon name={showPassword ? 'lucide:eye-off' : 'lucide:eye'} class="w-4 h-4" />
					</button>
				</div>
			</div>
		</div>

		<!-- SSL toggle -->
		<label class="flex items-center gap-3 cursor-pointer select-none">
			<div
				class="w-9 h-5 rounded-full relative transition-colors duration-200 {ssl
					? 'bg-violet-600'
					: 'bg-slate-200 dark:bg-slate-700'}"
				role="switch"
				aria-checked={ssl}
				tabindex="0"
				onclick={() => (ssl = !ssl)}
				onkeydown={(e) => e.key === 'Enter' && (ssl = !ssl)}
			>
				<div
					class="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 {ssl
						? 'translate-x-4'
						: 'translate-x-0.5'}"
				></div>
			</div>
			<span class="text-sm text-slate-700 dark:text-slate-300">Use SSL / TLS</span>
		</label>
	{/if}

	<!-- SSH Tunnel (only for non-SQLite connections) -->
	{#if !isSqlite}
		<div>
			<label class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
				SSH Tunnel
			</label>
			<SshTunnelSection
				value={sshTunnel}
				onchange={(v) => { sshTunnel = v; }}
			/>
		</div>
	{/if}

	<!-- Test result -->
	{#if dbManagerState.testResult}
		<div
			class="flex items-start gap-3 px-3 py-3 rounded-lg text-sm {dbManagerState.testResult.success
				? 'bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/50'
				: 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50'}"
		>
			<Icon
				name={dbManagerState.testResult.success ? 'lucide:circle-check' : 'lucide:circle-x'}
				class="w-4 h-4 mt-0.5 shrink-0 {dbManagerState.testResult.success ? 'text-emerald-600' : 'text-red-500'}"
			/>
			<div class="flex-1 min-w-0">
				<p class="{dbManagerState.testResult.success ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600 dark:text-red-400'}">
					{dbManagerState.testResult.message}
				</p>
				{#if dbManagerState.testResult.version}
					<p class="text-xs text-slate-500 mt-0.5">Version: {dbManagerState.testResult.version}</p>
				{/if}
				{#if dbManagerState.testResult.latencyMs !== undefined}
					<p class="text-xs text-slate-500 mt-0.5">Latency: {dbManagerState.testResult.latencyMs}ms</p>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Actions -->
	<div class="flex items-center gap-2 mt-auto pt-3 border-t border-slate-200 dark:border-slate-800">
		<button
			type="button"
			class="flex items-center gap-2 px-3 py-2 bg-transparent border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-600 dark:text-slate-400 cursor-pointer transition-all duration-150 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
			onclick={handleTest}
			disabled={!isValid || dbManagerState.isTesting}
		>
			{#if dbManagerState.isTesting}
				<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
				</svg>
				Testing...
			{:else}
				<Icon name="lucide:zap" class="w-4 h-4" />
				Test Connection
			{/if}
		</button>

		<div class="flex-1"></div>

		{#if onCancel}
			<button
				type="button"
				class="px-3 py-2 bg-transparent border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-600 dark:text-slate-400 cursor-pointer transition-all hover:bg-slate-100 dark:hover:bg-slate-800"
				onclick={onCancel}
			>
				Cancel
			</button>
		{/if}

		<button
			type="button"
			class="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:bg-violet-600/50 rounded-lg text-sm font-medium text-white cursor-pointer transition-all duration-150 disabled:cursor-not-allowed"
			onclick={handleSave}
			disabled={!isValid}
		>
			<Icon name="lucide:save" class="w-4 h-4" />
			{isEdit ? 'Save Changes' : 'Save Connection'}
		</button>
	</div>
</div>
