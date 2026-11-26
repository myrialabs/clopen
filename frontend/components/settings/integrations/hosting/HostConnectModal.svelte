<script lang="ts">
	/**
	 * Connect a git hosting account — every way in, cheapest first.
	 *
	 *   1. A login already on this machine (`gh`, `glab`, `tea`). One click,
	 *      LINKED by default so the token follows the CLI.
	 *   2. Sign in in the browser — the OAuth device flow, or the PKCE browser
	 *      flow where the service has no device grant.
	 *   3. A token, pasted. Always available, because it is the one method every
	 *      server and every policy accepts.
	 *
	 * git's own keychain is offered too, but only behind a button: reading it can
	 * raise an OS prompt, and nothing should do that unasked.
	 *
	 * The same dialog reconnects an existing account (`accountId`), so "Sign in
	 * again" is never a different screen from "Connect".
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Input from '$frontend/components/common/form/Input.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import ProviderMark from '$frontend/components/common/display/ProviderMark.svelte';
	import DeviceCodePanel from './DeviceCodePanel.svelte';
	import { untrack } from 'svelte';
	import ws from '$frontend/utils/ws';
	import { copyText } from '$frontend/utils/clipboard';
	import { debug } from '$shared/utils/logger';
	import { integrationsStore } from '$frontend/stores/features/integrations.svelte';
	import { closeHostConnect, hostConnectState, notifyHostConnected } from '$frontend/stores/ui/host-connect.svelte';
	import { GIT_HOST_KINDS } from '$shared/types/git-hosting';
	import type {
		BrowserFlowStart,
		DetectedCredential,
		DeviceFlowStart,
		GitHostKind,
		HostViewer,
		ServerProbeResult
	} from '$shared/types/git-hosting';
	import type { IntegrationProviderInfo } from '$shared/types/integrations';

	type Phase = 'pick' | 'connect' | 'done';

	let phase = $state<Phase>('pick');
	let provider = $state<GitHostKind | null>(null);
	let server = $state<'cloud' | 'self'>('cloud');
	let baseUrl = $state('');
	let probe = $state<ServerProbeResult | null>(null);
	let probing = $state(false);
	let detected = $state<DetectedCredential[]>([]);
	let detecting = $state(false);
	let ownClientId = $state('');
	let tokenFields = $state<Record<string, string>>({});
	let busy = $state<string | null>(null);
	let error = $state<string | null>(null);
	let deviceFlow = $state<DeviceFlowStart | null>(null);
	let browserFlow = $state<BrowserFlowStart | null>(null);
	let viewer = $state<HostViewer | null>(null);
	let connectedId = $state<string | null>(null);
	let callbackUri = $state('');

	type Other = 'browser' | 'keychain' | 'token';
	let expanded = $state<Other | null>(null);

	const OTHER_META: Record<Other, { icon: 'lucide:globe' | 'lucide:key-round' | 'lucide:text-cursor-input'; label: (service: string) => string }> = {
		browser: { icon: 'lucide:globe', label: (service) => `Sign in with ${service} in the browser` },
		keychain: { icon: 'lucide:key-round', label: () => "Use the credential git already saved" },
		token: { icon: 'lucide:text-cursor-input', label: () => 'Paste a token' }
	};

	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let activeFlowId: string | null = null;

	const info = $derived<IntegrationProviderInfo | null>(
		provider ? integrationsStore.providers.find((entry) => entry.id === provider) ?? null : null
	);
	const hosting = $derived(info?.hosting ?? null);
	const reconnecting = $derived(hostConnectState.accountId);
	const serviceName = $derived(info?.name ?? 'the service');

	/** The server root the flows should use. Empty = the cloud host. */
	const effectiveBase = $derived(
		hosting?.requiresServerUrl || server === 'self' ? normalise(baseUrl) : ''
	);
	const serverReady = $derived(!(hosting?.requiresServerUrl || server === 'self') || effectiveBase.length > 0);
	const methods = $derived(info?.authMethods ?? []);
	const offersDevice = $derived(methods.includes('oauth-device') && hosting?.deviceFlow === true);
	const offersBrowser = $derived(methods.includes('oauth-code') && hosting?.browserFlow === true);
	/** A bundled client id only reaches the cloud host. */
	const needsOwnApp = $derived(effectiveBase.length > 0 || !hosting?.hasBundledClientId);
	const oauthReady = $derived(!needsOwnApp || ownClientId.trim().length > 0);
	const tokenFieldList = $derived((info?.credentialFields ?? []).filter((field) => field.name !== 'baseUrl'));
	const tokenReady = $derived(
		serverReady && tokenFieldList.every((field) => !field.isRequired || (tokenFields[field.name] ?? '').trim().length > 0)
	);
	const usableDetected = $derived(detected.filter((entry) => entry.hasToken));
	const offersOAuth = $derived(offersDevice || offersBrowser);

	/**
	 * The way in shown up front: a login already on this machine, else the
	 * browser when it works without setup, else the token form. Everything else
	 * is one line under "Other ways".
	 */
	const primary = $derived.by((): 'cli' | 'browser' | 'token' | null => {
		if (usableDetected.length > 0) return 'cli';
		if (detecting && methods.includes('cli')) return null;
		if (offersOAuth && !needsOwnApp) return 'browser';
		return 'token';
	});

	const others = $derived.by((): Other[] => {
		const list: Other[] = [];
		if (offersOAuth && primary !== 'browser') list.push('browser');
		if (methods.includes('cli')) list.push('keychain');
		if (primary !== 'token') list.push('token');
		return list;
	});

	function normalise(raw: string): string {
		let value = raw.trim();
		if (!value) return '';
		if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
		return value.replace(/\/+$/, '');
	}

	/** Where to create a token, pointed at the server in use. */
	const tokenUrl = $derived.by(() => {
		const base = effectiveBase;
		switch (provider) {
			case 'github':
				return base ? `${base}/settings/tokens/new?scopes=repo,read:org,workflow&description=Clopen` : info?.docsUrl ?? null;
			case 'gitlab':
				return `${base || 'https://gitlab.com'}/-/user_settings/personal_access_tokens?name=Clopen&scopes=api,read_user,write_repository`;
			case 'gitea':
				return base ? `${base}/user/settings/applications` : null;
			default:
				return info?.docsUrl ?? null;
		}
	});

	/** Where to register the user's own OAuth app, on the server in use. */
	const appUrl = $derived.by(() => {
		const base = effectiveBase;
		switch (provider) {
			case 'github':
				return `${base || 'https://github.com'}/settings/applications/new`;
			case 'gitlab':
				return `${base || 'https://gitlab.com'}/-/user_settings/applications`;
			case 'gitea':
				return base ? `${base}/user/settings/applications` : null;
			default:
				return null;
		}
	});

	// Seed on every open — `openCount` changes even when the arguments do not.
	// Only the store is read here; everything written is untracked. Reading the
	// local `provider` back (it used to decide `phase`) made picking a service
	// re-run this effect, which put the dialog straight back on the picker.
	$effect(() => {
		void hostConnectState.openCount;
		if (!hostConnectState.isOpen) return;
		const wanted = hostConnectState.provider;
		const wantedBase = hostConnectState.baseUrl;
		untrack(() => {
			void integrationsStore.load();
			resetFlow();
			error = null;
			viewer = null;
			connectedId = null;
			ownClientId = '';
			tokenFields = {};
			expanded = null;
			probe = null;
			provider = wanted;
			baseUrl = wantedBase;
			server = wantedBase ? 'self' : 'cloud';
			phase = wanted ? 'connect' : 'pick';
		});
	});

	// Look for local logins whenever the target server settles.
	$effect(() => {
		const p = provider;
		const base = effectiveBase;
		if (!hostConnectState.isOpen || phase !== 'connect' || !p || !serverReady) {
			detected = [];
			return;
		}
		const handle = setTimeout(() => void detect(p, base), 300);
		return () => clearTimeout(handle);
	});

	// The redirect URI for a user's own browser-flow app, from the server that owns the port.
	$effect(() => {
		if (!hostConnectState.isOpen || !offersBrowser || callbackUri) return;
		void ws.http('integrations:hosting-callback-uri', {}).then((result) => (callbackUri = result.uri)).catch(() => {});
	});

	// Stop polling when the dialog goes away.
	$effect(() => {
		if (!hostConnectState.isOpen) resetFlow();
	});

	function pickService(kind: GitHostKind) {
		provider = kind;
		const entry = integrationsStore.providers.find((candidate) => candidate.id === kind);
		server = entry?.hosting?.requiresServerUrl ? 'self' : 'cloud';
		phase = 'connect';
	}

	async function detect(kind: GitHostKind, base: string) {
		detecting = true;
		try {
			const result = await ws.http('integrations:hosting-detect', { provider: kind, ...(base && { baseUrl: base }) });
			if (provider === kind) detected = result.found;
		} catch (err) {
			debug.warn('settings', 'Could not detect local git logins:', err);
			detected = [];
		} finally {
			detecting = false;
		}
	}

	async function checkServer() {
		const url = normalise(baseUrl);
		if (!url) return;
		probing = true;
		probe = null;
		try {
			probe = await ws.http('integrations:hosting-probe-server', { url });
		} catch (err) {
			probe = { provider: null, flavour: null, version: null, baseUrl: url };
			debug.warn('settings', 'Server probe failed:', err);
		} finally {
			probing = false;
		}
	}

	const probeMessage = $derived.by(() => {
		if (!probe) return null;
		if (!probe.provider) return { tone: 'warn' as const, text: 'Could not recognise this server. Check the address, or continue with a token.' };
		const names = { 'github-enterprise': 'GitHub Enterprise Server', gitlab: 'GitLab', gitea: 'Gitea', forgejo: 'Forgejo' } as const;
		const name = probe.flavour ? names[probe.flavour] : probe.provider;
		const version = probe.version ? ` ${probe.version}` : '';
		if (probe.provider !== provider) {
			return { tone: 'warn' as const, text: `This is a ${name}${version} server.`, switchTo: probe.provider };
		}
		return { tone: 'ok' as const, text: `${name}${version} found.` };
	});

	function target() {
		return {
			provider: provider!,
			...(reconnecting && { accountId: reconnecting })
		};
	}

	async function succeed(accountId: string, who: HostViewer | null) {
		resetFlow();
		connectedId = accountId;
		viewer = who;
		phase = 'done';
		await integrationsStore.refresh();
		notifyHostConnected(accountId);
		// Nothing to act on — close by itself, the way a sign-in should.
		if (!who || who.missingScopes.length === 0) setTimeout(() => {
			if (phase === 'done' && connectedId === accountId) closeHostConnect();
		}, 1400);
	}

	async function run(key: string, work: () => Promise<void>) {
		busy = key;
		error = null;
		try {
			await work();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = null;
		}
	}

	function useDetected(entry: DetectedCredential) {
		void run(`cli:${entry.host}`, async () => {
			const result = await ws.http('integrations:hosting-connect-cli', {
				...target(),
				host: entry.host,
				mode: entry.canLink ? 'linked' : 'copy'
			});
			await succeed(result.account.id, result.viewer);
		});
	}

	function useKeychain() {
		expanded = null;
		void run('keychain', async () => {
			const result = await ws.http('integrations:hosting-connect-keychain', {
				...target(),
				...(effectiveBase && { baseUrl: effectiveBase })
			});
			await succeed(result.account.id, result.viewer);
		});
	}

	function connectToken() {
		void run('token', async () => {
			const fields: Record<string, string> = {};
			for (const field of tokenFieldList) fields[field.name] = (tokenFields[field.name] ?? '').trim();
			if (effectiveBase) fields.baseUrl = effectiveBase;
			const result = await ws.http('integrations:hosting-connect-token', { ...target(), fields });
			await succeed(result.account.id, result.viewer);
		});
	}

	function startDevice() {
		void run('device', async () => {
			const flow = await ws.http('integrations:hosting-device-start', {
				...target(),
				...(effectiveBase && { baseUrl: effectiveBase }),
				...(ownClientId.trim() && { clientId: ownClientId.trim() })
			});
			deviceFlow = flow;
			watch(flow.flowId, flow.intervalSeconds);
		});
	}

	function startBrowser() {
		void run('browser', async () => {
			const flow = await ws.http('integrations:hosting-browser-start', {
				...target(),
				...(effectiveBase && { baseUrl: effectiveBase }),
				...(ownClientId.trim() && { clientId: ownClientId.trim() })
			});
			browserFlow = flow;
			window.open(flow.authorizeUrl, '_blank', 'noopener,noreferrer');
			watch(flow.flowId, 2);
		});
	}

	/** Poll the server-side flow until it settles. */
	function watch(flowId: string, intervalSeconds: number) {
		activeFlowId = flowId;
		const tick = async () => {
			if (activeFlowId !== flowId) return;
			try {
				const result = await ws.http('integrations:hosting-auth-poll', { flowId });
				if (activeFlowId !== flowId) return;
				if (result.status === 'pending') {
					pollTimer = setTimeout(tick, Math.max(intervalSeconds, 2) * 1000);
					return;
				}
				activeFlowId = null;
				deviceFlow = null;
				browserFlow = null;
				if (result.status === 'success' && result.accountId) {
					const who = await ws.http('hosting:viewer', { accountId: result.accountId }).catch(() => null);
					await succeed(result.accountId, who);
				} else if (result.status === 'expired') {
					error = 'The sign-in expired before it was approved. Start it again.';
				} else if (result.status === 'denied') {
					error = 'The sign-in was declined.';
				} else {
					error = result.error ?? 'The sign-in failed.';
				}
			} catch (err) {
				if (activeFlowId !== flowId) return;
				pollTimer = setTimeout(tick, Math.max(intervalSeconds, 2) * 1000);
				debug.warn('settings', 'Sign-in poll failed:', err);
			}
		};
		pollTimer = setTimeout(tick, Math.max(intervalSeconds, 2) * 1000);
	}

	function resetFlow() {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = null;
		const flowId = activeFlowId;
		activeFlowId = null;
		if (flowId) void ws.http('integrations:hosting-auth-cancel', { flowId }).catch(() => {});
		deviceFlow = null;
		browserFlow = null;
	}

	function reauthorize() {
		phase = 'connect';
		viewer = null;
		hostConnectState.accountId = connectedId;
	}

</script>

{#snippet browserSignIn()}
	{#if deviceFlow}
		<DeviceCodePanel flow={deviceFlow} {serviceName} onCancel={resetFlow} />
	{:else if browserFlow}
		<div class="flex items-center gap-2 p-3 rounded-xl border border-violet-500/30 bg-violet-500/5 text-xs text-slate-600 dark:text-slate-300">
			<Icon name="lucide:loader-circle" class="w-4 h-4 animate-spin shrink-0" />
			<span class="flex-1">Finish signing in on the page that opened. <a href={browserFlow.authorizeUrl} target="_blank" rel="noopener noreferrer" class="text-violet-600 dark:text-violet-400">Open it again</a></span>
			<button type="button" class="bg-transparent border-none p-0 text-[11px] underline underline-offset-2 text-slate-500 cursor-pointer" onclick={resetFlow}>Cancel</button>
		</div>
	{:else}
		<div class="space-y-2">
			{#if needsOwnApp}
				<!-- Only asked when there is no app to use: a self-hosted server,
				     or a build without one. -->
				<Input label="OAuth app client ID" placeholder="Client ID of your own OAuth app" bind:value={ownClientId} />
				<p class="m-0 text-[11px] text-slate-500">
					{offersDevice ? 'Enable the device flow on the app.' : 'Make it a public client with this redirect URI:'}
					{#if !offersDevice && callbackUri}
						<button type="button" class="font-mono bg-transparent border-none p-0 text-[11px] text-violet-600 dark:text-violet-400 cursor-pointer break-all" onclick={() => void copyText(callbackUri)} title="Copy">{callbackUri}</button>
					{/if}
					{#if appUrl}<a href={appUrl} target="_blank" rel="noopener noreferrer" class="text-violet-600 dark:text-violet-400">Register an app</a>{/if}
				</p>
			{/if}
			<Button class="w-full" loading={busy === 'device' || busy === 'browser'} disabled={busy !== null || !oauthReady} onclick={offersDevice ? startDevice : startBrowser}>
				<ProviderMark provider={provider ?? ''} size="w-4 h-4" />
				<span class="ml-2">Sign in with {serviceName}</span>
			</Button>
		</div>
	{/if}
{/snippet}

{#snippet tokenForm()}
	<div class="space-y-2">
		{#each tokenFieldList as field (field.name)}
			<Input
				label={field.label}
				type={field.isSecret ? 'password' : 'text'}
				placeholder={field.placeholder ?? ''}
				value={tokenFields[field.name] ?? ''}
				onchange={(next) => (tokenFields = { ...tokenFields, [field.name]: next })}
			/>
		{/each}
		<div class="flex items-center justify-between gap-2">
			{#if tokenUrl}
				<a href={tokenUrl} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400" title={hosting ? `Scopes: ${hosting.scopes.join(', ')}` : undefined}>
					<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
					Create a token with the right scopes
				</a>
			{:else}<span></span>{/if}
			<Button size="sm" loading={busy === 'token'} disabled={busy !== null || !tokenReady} onclick={connectToken}>Connect</Button>
		</div>
	</div>
{/snippet}

<Modal
	isOpen={hostConnectState.isOpen}
	onClose={closeHostConnect}
	title={phase === 'pick' ? 'Connect a git service' : reconnecting ? `Sign in to ${serviceName} again` : `Connect ${serviceName}`}
	size="md"
>
	{#snippet children()}
		<div class="space-y-4 text-sm">
			{#if phase === 'pick'}
				<p class="text-xs text-slate-500 dark:text-slate-400 m-0">
					Connect once to publish repositories, pick remotes and push without a separate credential.
				</p>
				<div class="grid grid-cols-2 gap-2">
					{#each GIT_HOST_KINDS as kind (kind)}
						{@const entry = integrationsStore.providers.find((candidate) => candidate.id === kind)}
						{#if entry}
							<button
								type="button"
								class="flex items-center gap-2.5 p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-left cursor-pointer hover:border-violet-500/50"
								onclick={() => pickService(kind)}
							>
								<ProviderMark provider={kind} size="w-6 h-6" />
								<span class="flex flex-col min-w-0">
									<span class="font-semibold text-slate-900 dark:text-slate-100">{entry.name}</span>
									<span class="text-[11px] text-slate-500 truncate">
										{entry.hosting?.requiresServerUrl ? 'Your own server' : entry.hosting?.selfHosted ? 'Cloud or self-hosted' : entry.hosting?.defaultHost}
									</span>
								</span>
							</button>
						{/if}
					{/each}
				</div>
			{:else if phase === 'done'}
				<div class="flex flex-col items-center gap-3 py-4 text-center">
					{#if viewer?.avatarUrl}
						<img src={viewer.avatarUrl} alt="" class="w-12 h-12 rounded-full" />
					{:else}
						<Icon name="lucide:circle-check" class="w-10 h-10 text-emerald-500" />
					{/if}
					<p class="m-0 font-semibold text-slate-900 dark:text-slate-100">
						{viewer ? `Signed in as ${viewer.login}` : 'Connected'}
					</p>
					{#if viewer && viewer.missingScopes.length > 0}
						<div class="flex items-start gap-2 p-3 text-left rounded-lg border border-amber-500/40 bg-amber-500/10">
							<Icon name="lucide:triangle-alert" class="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
							<div class="flex flex-col gap-2 text-xs text-amber-800 dark:text-amber-200">
								<span>
									The token is missing {viewer.missingScopes.map((scope) => `"${scope}"`).join(', ')}.
									Some actions — pushing CI files, private repositories — will be refused until it has them.
								</span>
								<span><Button size="sm" variant="outline" onclick={reauthorize}>Reconnect with the right access</Button></span>
							</div>
						</div>
					{/if}
				</div>
			{:else if info && hosting}
				<!-- Which server — only where there is a choice to make. -->
				{#if hosting.selfHosted}
					<div class="space-y-2">
						{#if !hosting.requiresServerUrl}
							<div class="inline-flex p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800">
								{#each [{ id: 'cloud', label: hosting.defaultHost ?? 'Cloud' }, { id: 'self', label: 'Self-hosted' }] as option (option.id)}
									<button
										type="button"
										class="px-3 py-1 text-xs font-medium rounded-md border-none cursor-pointer {server === option.id ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'bg-transparent text-slate-500'}"
										onclick={() => (server = option.id as 'cloud' | 'self')}
									>
										{option.label}
									</button>
								{/each}
							</div>
						{/if}
						{#if hosting.requiresServerUrl || server === 'self'}
							<div class="flex items-end gap-2">
								<div class="flex-1">
									<Input label="Server URL" placeholder="https://git.your-company.com" bind:value={baseUrl} />
								</div>
								<Button variant="outline" size="sm" loading={probing} disabled={!baseUrl.trim()} onclick={checkServer}>Check</Button>
							</div>
							{#if probeMessage}
								<p class="flex items-center gap-1.5 m-0 text-[11px] {probeMessage.tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}">
									<Icon name={probeMessage.tone === 'ok' ? 'lucide:circle-check' : 'lucide:info'} class="w-3.5 h-3.5" />
									{probeMessage.text}
									{#if probeMessage.switchTo}
										<button type="button" class="bg-transparent border-none p-0 underline underline-offset-2 text-[11px] cursor-pointer text-inherit" onclick={() => pickService(probeMessage.switchTo!)}>Connect it as that instead</button>
									{/if}
								</p>
							{/if}
						{/if}
					</div>
				{/if}

				{#if serverReady}
					<!-- ONE recommended way in, chosen for the user. -->
					{#if primary === 'cli'}
						<div class="space-y-2">
							{#each usableDetected as entry (`${entry.source}:${entry.host}`)}
								<button
									type="button"
									class="flex items-center gap-3 w-full p-3 rounded-xl border border-violet-500/40 bg-violet-500/5 text-left cursor-pointer hover:bg-violet-500/10 disabled:opacity-60"
									disabled={busy !== null}
									onclick={() => useDetected(entry)}
								>
									<ProviderMark provider={info.id} size="w-6 h-6" />
									<span class="flex-1 min-w-0">
										<span class="block text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
											Continue as {entry.login ? `@${entry.login}` : entry.host}
										</span>
										<span class="block text-[11px] text-slate-500">Uses your {entry.source} login · stays in sync with it</span>
									</span>
									{#if busy === `cli:${entry.host}`}
										<Icon name="lucide:loader-circle" class="w-4 h-4 animate-spin text-violet-500" />
									{:else}
										<Icon name="lucide:arrow-right" class="w-4 h-4 text-violet-500" />
									{/if}
								</button>
							{/each}
						</div>
					{:else if primary === 'browser'}
						{@render browserSignIn()}
					{:else if primary === 'token'}
						{@render tokenForm()}
					{:else if detecting}
						<p class="flex items-center gap-1.5 m-0 text-xs text-slate-400"><Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />Looking for a login on this machine…</p>
					{/if}

					<!-- Every other way in, one line each, opened one at a time. -->
					{#if others.length > 0}
						<div class="pt-1">
							<p class="m-0 mb-1 text-[11px] font-semibold text-slate-400">Other ways to sign in</p>
							<div class="rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
								{#each others as other (other)}
									<div>
										<button
											type="button"
											class="flex items-center gap-2 w-full px-3 py-2 text-left text-xs bg-transparent border-none text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 disabled:opacity-60"
											disabled={busy !== null}
											onclick={() => (other === 'keychain' ? useKeychain() : (expanded = expanded === other ? null : other))}
										>
											<Icon name={OTHER_META[other].icon} class="w-3.5 h-3.5 shrink-0 text-slate-400" />
											<span class="flex-1">{OTHER_META[other].label(serviceName)}</span>
											{#if busy === other}
												<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
											{:else if other !== 'keychain'}
												<Icon name={expanded === other ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3.5 h-3.5 text-slate-400" />
											{/if}
										</button>
										{#if expanded === other}
											<div class="px-3 pb-3">
												{#if other === 'browser'}{@render browserSignIn()}{:else}{@render tokenForm()}{/if}
											</div>
										{/if}
									</div>
								{/each}
							</div>
						</div>
					{/if}
				{/if}

				{#if error}
					<p class="m-0 text-xs text-red-500 break-words">{error}</p>
				{/if}

				<p class="flex items-center gap-1.5 m-0 text-[11px] text-slate-400">
					<Icon name="lucide:lock" class="w-3 h-3" />
					Verified before saving, stored encrypted.
				</p>
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		{#if phase === 'connect' && !hostConnectState.provider && !reconnecting}
			<Button variant="ghost" onclick={() => { resetFlow(); error = null; phase = 'pick'; }}>Back</Button>
			<span class="flex-1"></span>
		{/if}
		<Button variant="ghost" onclick={closeHostConnect}>{phase === 'done' ? 'Done' : 'Cancel'}</Button>
	{/snippet}
</Modal>
