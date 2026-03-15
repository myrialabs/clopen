<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { SSHTunnelConfig, SSHAuthMethod } from '$shared/types/ssh-tunnel';

	interface Props {
		value: SSHTunnelConfig | undefined;
		onchange: (tunnel: SSHTunnelConfig | undefined) => void;
	}

	const { value, onchange }: Props = $props();

	// ─── Local state (mirrors the SSH tunnel config) ───────────────────────────
	let enabled = $state(false);
	let host = $state('');
	let port = $state<number | ''>(22);
	let username = $state('');
	let authMethod = $state<SSHAuthMethod>('password');
	let password = $state('');
	let privateKey = $state('');
	let passphrase = $state('');
	let remoteHost = $state('');
	let remotePort = $state<number | ''>('');
	let showPassword = $state(false);
	let showPassphrase = $state(false);
	let expanded = $state(false);

	// Sync external value → local state when prop changes
	$effect(() => {
		if (value) {
			enabled = value.enabled;
			expanded = value.enabled;
			host = value.host ?? '';
			port = value.port ?? 22;
			username = value.username ?? '';
			authMethod = value.authMethod ?? 'password';
			password = value.password ?? '';
			privateKey = value.privateKey ?? '';
			passphrase = value.passphrase ?? '';
			remoteHost = value.remoteHost ?? '';
			remotePort = value.remotePort ?? '';
		}
	});

	// Emit changes upward whenever any field changes
	function emit() {
		if (!enabled) {
			onchange(undefined);
			return;
		}
		const tunnel: SSHTunnelConfig = {
			enabled: true,
			host,
			port: Number(port) || 22,
			username,
			authMethod
		};
		if (authMethod === 'password' && password) tunnel.password = password;
		if (authMethod === 'key') {
			if (privateKey) tunnel.privateKey = privateKey;
			if (passphrase) tunnel.passphrase = passphrase;
		}
		if (remoteHost) tunnel.remoteHost = remoteHost;
		if (remotePort) tunnel.remotePort = Number(remotePort);
		onchange(tunnel);
	}

	function toggleEnabled() {
		enabled = !enabled;
		expanded = enabled;
		emit();
	}
</script>

<!-- ─── SSH Tunnel Section ──────────────────────────────────────────────────── -->
<div class="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
	<!-- Header / toggle row -->
	<button
		type="button"
		class="flex items-center gap-3 w-full px-3 py-2.5 bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-left"
		onclick={() => { expanded = !expanded; }}
	>
		<!-- Toggle switch -->
		<div
			class="w-8 h-4 rounded-full relative shrink-0 transition-colors duration-200 {enabled
				? 'bg-violet-600'
				: 'bg-slate-300 dark:bg-slate-600'}"
			role="switch"
			aria-checked={enabled}
			onclick={(e) => { e.stopPropagation(); toggleEnabled(); }}
			onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); toggleEnabled(); } }}
			tabindex="0"
		>
			<div
				class="absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform duration-200 {enabled
					? 'translate-x-4'
					: 'translate-x-0.5'}"
			></div>
		</div>

		<div class="flex items-center gap-2 flex-1 min-w-0">
			<Icon name="lucide:shield-check" class="w-3.5 h-3.5 {enabled ? 'text-violet-600' : 'text-slate-400'}" />
			<span class="text-xs font-semibold text-slate-700 dark:text-slate-300">
				SSH Tunnel (Port Forwarding)
			</span>
			{#if enabled}
				<span class="px-1.5 py-0.5 text-3xs font-medium bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 rounded">
					ENABLED
				</span>
			{/if}
		</div>

		<Icon
			name={expanded ? 'lucide:chevron-up' : 'lucide:chevron-down'}
			class="w-3.5 h-3.5 text-slate-400 shrink-0"
		/>
	</button>

	<!-- Expanded fields -->
	{#if expanded}
		<div class="p-4 flex flex-col gap-4 border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/40">
			<!-- SSH Host + Port -->
			<div class="grid grid-cols-[1fr_auto] gap-3">
				<div>
					<label class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
						SSH Host *
					</label>
					<input
						type="text"
						bind:value={host}
						oninput={emit}
						placeholder="bastion.example.com"
						class="w-full px-3 py-2 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 transition-colors"
					/>
				</div>
				<div class="w-20">
					<label class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
						Port
					</label>
					<input
						type="number"
						bind:value={port}
						oninput={emit}
						placeholder="22"
						class="w-full px-3 py-2 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 transition-colors"
					/>
				</div>
			</div>

			<!-- SSH Username -->
			<div>
				<label class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
					SSH Username *
				</label>
				<input
					type="text"
					bind:value={username}
					oninput={emit}
					placeholder="ubuntu"
					autocomplete="off"
					class="w-full px-3 py-2 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 transition-colors"
				/>
			</div>

			<!-- Auth Method toggle -->
			<div>
				<label class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
					Authentication
				</label>
				<div class="flex gap-2">
					<button
						type="button"
						class="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-all duration-150
							{authMethod === 'password'
								? 'border-violet-500/60 bg-violet-500/10 text-violet-700 dark:text-violet-300'
								: 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-violet-400/50'}"
						onclick={() => { authMethod = 'password'; emit(); }}
					>
						<Icon name="lucide:lock" class="w-3.5 h-3.5" />
						Password
					</button>
					<button
						type="button"
						class="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-all duration-150
							{authMethod === 'key'
								? 'border-violet-500/60 bg-violet-500/10 text-violet-700 dark:text-violet-300'
								: 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-violet-400/50'}"
						onclick={() => { authMethod = 'key'; emit(); }}
					>
						<Icon name="lucide:key-square" class="w-3.5 h-3.5" />
						SSH Key
					</button>
				</div>
			</div>

			<!-- Password auth -->
			{#if authMethod === 'password'}
				<div>
					<label class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
						SSH Password
					</label>
					<div class="relative">
						<input
							type={showPassword ? 'text' : 'password'}
							bind:value={password}
							oninput={emit}
							placeholder="••••••••"
							autocomplete="off"
							class="w-full px-3 py-2 pr-9 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 transition-colors"
						/>
						<button
							type="button"
							class="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
							onclick={() => (showPassword = !showPassword)}
						>
							<Icon name={showPassword ? 'lucide:eye-off' : 'lucide:eye'} class="w-3.5 h-3.5" />
						</button>
					</div>
				</div>
			{:else}
				<!-- Key auth -->
				<div>
					<label class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
						Private Key (PEM)
					</label>
					<textarea
						bind:value={privateKey}
						oninput={emit}
						placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
						rows="5"
						class="w-full px-3 py-2 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-900 dark:text-slate-100 font-mono placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 transition-colors resize-none"
					></textarea>
					<p class="mt-1 text-3xs text-slate-400">Paste your private key in PEM / OpenSSH format.</p>
				</div>

				<div>
					<label class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
						Passphrase <span class="font-normal normal-case text-slate-400">(optional)</span>
					</label>
					<div class="relative">
						<input
							type={showPassphrase ? 'text' : 'password'}
							bind:value={passphrase}
							oninput={emit}
							placeholder="Leave empty if key has no passphrase"
							autocomplete="off"
							class="w-full px-3 py-2 pr-9 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 transition-colors"
						/>
						<button
							type="button"
							class="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
							onclick={() => (showPassphrase = !showPassphrase)}
						>
							<Icon name={showPassphrase ? 'lucide:eye-off' : 'lucide:eye'} class="w-3.5 h-3.5" />
						</button>
					</div>
				</div>
			{/if}

			<!-- Optional remote overrides -->
			<details class="group">
				<summary class="cursor-pointer text-xs text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 select-none flex items-center gap-1.5">
					<Icon name="lucide:chevron-right" class="w-3 h-3 group-open:rotate-90 transition-transform" />
					Advanced: Override Remote Host / Port
				</summary>
				<div class="mt-3 grid grid-cols-[1fr_auto] gap-3">
					<div>
						<label class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
							Remote Host
						</label>
						<input
							type="text"
							bind:value={remoteHost}
							oninput={emit}
							placeholder="Defaults to connection host"
							class="w-full px-3 py-2 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 transition-colors"
						/>
					</div>
					<div class="w-24">
						<label class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
							Remote Port
						</label>
						<input
							type="number"
							bind:value={remotePort}
							oninput={emit}
							placeholder="—"
							class="w-full px-3 py-2 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 transition-colors"
						/>
					</div>
				</div>
			</details>
		</div>
	{/if}
</div>
