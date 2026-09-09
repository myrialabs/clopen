<script lang="ts">
	/**
	 * ONE detail view for every row in the hub.
	 *
	 * Structured rather than stacked. The first version was a single scrolling
	 * column of headings, and it read badly for the reason flat forms usually do:
	 * "is it on", "whose credential is it", "what does it launch" and "which tools
	 * does it expose" are four different questions, and answering them in one
	 * column makes the enable toggle sit next to whatever happened to render last.
	 *
	 * So: a header that identifies the row, a status strip that owns on/off and
	 * health, and tabs for the rest. Tabs appear only when they have something to
	 * show — a built-in has no configuration and no account, and rendering an
	 * empty tab for it would be worse than not having one.
	 *
	 * A row projected from an account is read-only here. Its configuration is
	 * DERIVED, so an edit would be undone by the next re-projection; the
	 * credential is changed on the account instead.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import McpConfigForm from './McpConfigForm.svelte';
	import McpToolsPanel from './McpToolsPanel.svelte';
	import { McpConfigDraft, commandLine, transportLabel } from './mcp-config-draft.svelte';
	import { CAPABILITY_LABELS, CAPABILITY_SURFACES, CATEGORY_ICONS } from './capabilities';
	import { integrationsStore } from '$frontend/stores/features/integrations.svelte';
	import { mcpServersStore, type InstalledMcpServer, type McpHealthState } from '$frontend/stores/features/mcp-servers.svelte';
	import { getProviderIcon } from '$shared/constants/tool-icons';
	import { isDarkMode } from '$frontend/stores/ui/theme.svelte';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';
	import type { IntegrationAccountInfo, IntegrationProviderInfo } from '$shared/types/integrations';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		isOpen: boolean;
		server: InstalledMcpServer | null;
		account: IntegrationAccountInfo | null;
		provider: IntegrationProviderInfo | null;
		onClose: () => void;
		onReconfigureAccount: (account: IntegrationAccountInfo, provider: IntegrationProviderInfo) => void;
	}

	const { isOpen, server, account, provider, onClose, onReconfigureAccount }: Props = $props();

	type TabId = 'overview' | 'configuration' | 'tools' | 'advanced';

	const draft = new McpConfigDraft();

	let tab = $state<TabId>('overview');
	let savingConfig = $state(false);
	let configError = $state<string | null>(null);
	let configSaved = $state(false);
	let removing = $state(false);
	let confirmRemove = $state(false);
	let engineConfigs = $state<Record<string, string> | null>(null);
	let engineConfigError = $state<string | null>(null);

	const isBuiltIn = $derived(server?.source === 'internal');
	/** Derived from an account: its configuration is not the user's to edit here. */
	const isManaged = $derived(account !== null && server !== null);
	const canEditConfig = $derived(!!server && !isBuiltIn && !isManaged);

	const statuses = $derived(mcpServersStore.statuses);
	const checking = $derived(mcpServersStore.checking);
	const health = $derived(server ? statuses[server.id] : undefined);

	const title = $derived(server?.name ?? account?.label ?? provider?.name ?? '');

	const tabs = $derived.by<{ id: TabId; label: string }[]>(() => {
		const out: { id: TabId; label: string }[] = [{ id: 'overview', label: 'Overview' }];
		if (canEditConfig) out.push({ id: 'configuration', label: 'Configuration' });
		if (server && !isBuiltIn) out.push({ id: 'tools', label: 'Tools' });
		out.push({ id: 'advanced', label: 'Advanced' });
		return out;
	});

	/**
	 * Reload the draft, and drop back to Overview, whenever a different row is
	 * opened. Keeping the previous row's tab would land the user on a
	 * Configuration tab that no longer exists for what they just clicked.
	 */
	$effect(() => {
		const target = server;
		if (!isOpen) return;

		tab = 'overview';
		configError = null;
		configSaved = false;
		confirmRemove = false;
		engineConfigs = null;
		engineConfigError = null;

		if (!target) {
			draft.reset();
			return;
		}

		draft.transport = target.transport;
		const schema = target.configSchema ?? [];
		draft.fields = schema;
		draft.values = Object.fromEntries(
			schema.map(f => [f.name, (f.kind === 'header' ? target.headers[f.name] : target.env[f.name]) ?? ''])
		);
		draft.command = target.command ?? '';
		draft.argsText = (target.args ?? []).join('\n');
		// Stored keys the registry never declared are the user's own — show them
		// pre-filled in the Custom sections so they stay clearly distinct.
		const knownEnv = new Set(schema.filter(f => f.kind === 'env').map(f => f.name));
		const knownHeader = new Set(schema.filter(f => f.kind === 'header').map(f => f.name));
		draft.customEnv = Object.entries(target.env).filter(([k]) => !knownEnv.has(k)).map(([key, value]) => ({ key, value }));
		draft.customHeader = Object.entries(target.headers).filter(([k]) => !knownHeader.has(k)).map(([key, value]) => ({ key, value }));
	});

	function statusMeta(state: McpHealthState): { label: string; icon: IconName; class: string; dot: string } {
		switch (state) {
			case 'ok':
			case 'local':
				return { label: 'Connected', icon: 'lucide:circle-check', class: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' };
			case 'needs_auth':
				return { label: 'Needs sign-in', icon: 'lucide:lock', class: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' };
			case 'needs_config':
				return { label: 'Needs setup', icon: 'lucide:key', class: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' };
			case 'unreachable':
				return { label: 'Unreachable', icon: 'lucide:wifi-off', class: 'text-red-500 dark:text-red-400', dot: 'bg-red-500' };
			case 'error':
				return { label: 'Error', icon: 'lucide:triangle-alert', class: 'text-red-500 dark:text-red-400', dot: 'bg-red-500' };
		}
	}

	const mark = $derived.by(() => {
		const icon = provider ? getProviderIcon(provider.id) : null;
		if (!icon) return null;
		return isDarkMode() ? icon.dark : icon.light;
	});

	const fallbackIcon = $derived<IconName>(
		provider ? CATEGORY_ICONS[provider.category] : 'lucide:plug'
	);

	async function saveConfig() {
		if (!server || draft.missingRequired.length > 0) return;
		savingConfig = true;
		configError = null;
		try {
			const { env, headers } = draft.collect();
			const isStdio = server.transport === 'stdio';
			await mcpServersStore.updateConfig(
				server.id,
				env,
				headers,
				isStdio ? draft.command.trim() : undefined,
				isStdio ? draft.args() : undefined
			);
			configSaved = true;
			// Re-probe so the status reflects whatever was edited, without a manual
			// Re-check.
			void mcpServersStore.checkStatus(server.id);
		} catch (error) {
			configError = error instanceof Error ? error.message : 'Could not save';
		} finally {
			savingConfig = false;
		}
	}

	async function toggleEnabled() {
		if (!server) return;
		await mcpServersStore.toggle(server.id, !server.enabled);
	}

	async function authenticate() {
		if (!server) return;
		try {
			await mcpServersStore.authenticate(server.id);
		} catch (error) {
			debug.error('settings', 'MCP authenticate failed', error);
		}
	}

	async function loadEngineConfigs() {
		if (engineConfigs || !server) return;
		engineConfigError = null;
		try {
			const { configs } = await ws.http('mcp:engine-config', { id: server.id });
			engineConfigs = configs;
		} catch (error) {
			engineConfigError = error instanceof Error ? error.message : 'Could not read the engine config';
		}
	}

	// The Advanced tab is the only consumer, so fetch on arrival rather than on
	// open — it is a round trip per engine builder.
	$effect(() => {
		if (tab === 'advanced') void loadEngineConfigs();
	});

	async function remove() {
		removing = true;
		try {
			if (account) await integrationsStore.disconnect(account.id);
			else if (server) await mcpServersStore.uninstall(server.id);
			confirmRemove = false;
			onClose();
		} catch (error) {
			debug.error('settings', 'Remove integration failed', error);
		} finally {
			removing = false;
		}
	}
</script>

<!--
	One heading treatment for every section in this dialog.

	The action sits IN the heading as a text button rather than beside it as a
	full control: "Reconfigure" is a link to another dialog, not a primary action
	of this one, and a bordered button that size read as the loudest thing on the
	page.
-->
{#snippet sectionHeading(label: string, action?: { label: string; onclick: () => void })}
	<div class="flex items-center justify-between gap-2 mb-1.5">
		<h4 class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">{label}</h4>
		{#if action}
			<button
				type="button"
				onclick={action.onclick}
				class="text-xs font-semibold text-violet-600 hover:text-violet-700 dark:text-violet-400"
			>
				{action.label}
			</button>
		{/if}
	</div>
{/snippet}

<Modal {isOpen} onClose={onClose} size="lg">
	{#snippet header()}
		<div class="px-4 py-3 md:px-6 md:py-4 space-y-3">
			<div class="flex items-start gap-3">
				{#if mark}
					<span class="w-9 h-9 shrink-0 rounded-lg bg-slate-50 dark:bg-slate-800 p-1.5 [&>svg]:w-full [&>svg]:h-full">{@html mark}</span>
				{:else}
					<span class="w-9 h-9 shrink-0 rounded-lg bg-slate-50 dark:bg-slate-800 flex items-center justify-center">
						<Icon name={fallbackIcon} class="w-5 h-5 text-slate-400" />
					</span>
				{/if}
				<div class="flex-1 min-w-0">
					<h2 id="modal-title" class="text-base md:text-lg font-bold text-slate-900 dark:text-slate-100 truncate">{title}</h2>
					<div class="flex items-center gap-1.5 flex-wrap mt-1">
						{#if isBuiltIn}
							<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400">Built-in</span>
						{:else if isManaged}
							<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-600 dark:text-sky-400">Managed account</span>
						{:else if server}
							<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">Custom MCP</span>
						{/if}
						{#if server}
							<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">{transportLabel(server.transport)}</span>
							{#if server.version}
								<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">v{server.version}</span>
							{/if}
						{/if}
					</div>
				</div>
				<button
					type="button"
					class="p-1.5 md:p-2 -mt-1 -mr-1 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-violet-500/10 transition-colors shrink-0"
					onclick={onClose}
					aria-label="Close"
				>
					<Icon name="lucide:x" class="w-4 h-4 md:w-5 md:h-5" />
				</button>
			</div>

			<!-- Status strip. The enable switch lives here, labelled, rather than
			     floating beside whatever text happened to render last. -->
			{#if server}
				<div class="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800/50">
					<div class="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
						{#if !server.enabled}
							<span class="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400">
								<span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
								Disabled
							</span>
						{:else if isBuiltIn}
							<span class="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
								<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
								Runs in-process
							</span>
						{:else if checking[server.id]}
							<span class="inline-flex items-center gap-1.5 text-xs text-slate-400">
								<span class="w-3 h-3 border-2 border-slate-300 border-t-transparent rounded-full animate-spin"></span>
								Checking…
							</span>
						{:else if health}
							{@const meta = statusMeta(health.state)}
							<span class="inline-flex items-center gap-1.5 text-xs font-semibold {meta.class}">
								<span class="w-1.5 h-1.5 rounded-full {meta.dot}"></span>
								{meta.label}
							</span>
							{#if health.state === 'needs_auth'}
								<button type="button" onclick={authenticate} class="text-[11px] font-semibold text-violet-600 hover:text-violet-700 dark:text-violet-400">
									Authenticate
								</button>
							{/if}
						{:else}
							<span class="inline-flex items-center gap-1.5 text-xs text-slate-400">
								<span class="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600"></span>
								Not checked
							</span>
						{/if}
						{#if !isBuiltIn}
							<button
								type="button"
								onclick={() => server && mcpServersStore.checkStatus(server.id)}
								class="text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
							>
								Re-check
							</button>
						{/if}
					</div>
					<span class="text-[11px] font-semibold text-slate-400 shrink-0">{server.enabled ? 'Enabled' : 'Off'}</span>
					<button
						type="button"
						role="switch"
						aria-checked={server.enabled}
						onclick={toggleEnabled}
						class="relative w-10 h-6 rounded-full transition-colors shrink-0 {server.enabled ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-700'}"
						aria-label={server.enabled ? 'Disable' : 'Enable'}
					>
						<span class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform {server.enabled ? 'translate-x-4' : ''}"></span>
					</button>
				</div>
				{#if health?.message && health.state !== 'ok' && health.state !== 'local'}
					<p class="text-[11px] break-words {health.state === 'needs_auth' || health.state === 'needs_config' ? 'text-amber-600 dark:text-amber-400' : 'text-red-500 dark:text-red-400'}">
						{health.message}
					</p>
				{/if}
			{/if}

			{#if tabs.length > 1}
				<div class="flex gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg overflow-x-auto">
					{#each tabs as entry (entry.id)}
						<button
							type="button"
							class="px-3 py-1.5 text-sm font-semibold rounded-md transition-colors whitespace-nowrap
								{tab === entry.id
								? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
								: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
							onclick={() => (tab = entry.id)}
						>
							{entry.label}
						</button>
					{/each}
				</div>
			{/if}
		</div>
	{/snippet}

	{#snippet children()}
		<div class="text-sm">
			{#if tab === 'overview'}
				<div class="space-y-4">
					{#if server?.description ?? provider?.description}
						<p class="text-slate-600 dark:text-slate-300">{server?.description ?? provider?.description}</p>
					{/if}

					{#if server && !isBuiltIn}
						{@render sectionHeading(server.transport === 'stdio' ? 'Launches' : 'Connects to')}
						<p class="font-mono text-xs text-slate-600 dark:text-slate-300 break-all px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800/50">
							{commandLine(server)}
						</p>
					{/if}

					{#if account && provider}
						<div>
							{@render sectionHeading('Account', {
								label: 'Reconfigure',
								onclick: () => onReconfigureAccount(account, provider)
							})}
							<div class="rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
								{#each provider.credentialFields as field (field.name)}
									<div class="flex items-center gap-3 px-3 py-1.5 text-xs">
										<span class="w-28 shrink-0 text-slate-500 dark:text-slate-400">{field.label}</span>
										{#if account.configuredFields.includes(field.name)}
											<span class="inline-flex items-center gap-1 font-semibold text-emerald-600 dark:text-emerald-400">
												<Icon name="lucide:check" class="w-3.5 h-3.5" /> Set
											</span>
										{:else}
											<span class="text-slate-400">Not set</span>
										{/if}
									</div>
								{/each}
							</div>
						</div>

						<div>
							{@render sectionHeading('Capabilities')}
							{#if account.capabilities.length === 0}
								<p class="text-xs text-slate-400">
									None enabled — this account is connected but does nothing.
								</p>
							{:else}
								<div class="rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
									{#each account.capabilities as capability (capability)}
										<div class="flex items-center gap-3 px-3 py-1.5">
											<span class="w-28 shrink-0 text-xs font-semibold text-slate-700 dark:text-slate-300">{CAPABILITY_LABELS[capability]}</span>
											<span class="text-[11px] text-slate-400">{CAPABILITY_SURFACES[capability]}</span>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/if}

					{#if isManaged}
						<div class="flex items-start gap-2 p-3 bg-sky-500/5 border border-sky-500/20 rounded-lg text-sky-700 dark:text-sky-300">
							<Icon name="lucide:link" class="w-4 h-4 mt-0.5 shrink-0" />
							<span class="text-xs">
								Derived from the {account?.label} account, so its configuration is read-only
								here. Change the credential on the account and it is re-applied.
							</span>
						</div>
					{/if}

					{#if isBuiltIn}
						<div class="flex items-start gap-2 p-3 bg-violet-500/5 border border-violet-500/20 rounded-lg text-violet-700 dark:text-violet-300">
							<Icon name="lucide:box" class="w-4 h-4 mt-0.5 shrink-0" />
							<span class="text-xs">
								Built into Clopen and defined in code. It can be switched off, but there is
								nothing to configure and nothing to remove.
							</span>
						</div>
					{/if}
				</div>

			{:else if tab === 'configuration'}
				<div class="space-y-4">
					<McpConfigForm {draft} />

					{#if draft.missingRequired.length > 0}
						<p class="text-xs text-red-500">Required: {draft.missingRequired.map(f => f.name).join(', ')}</p>
					{/if}
					{#if configError}
						<p class="text-xs text-red-500">{configError}</p>
					{/if}
					{#if server?.transport !== 'stdio'}
						<p class="text-[11px] text-slate-400">
							For OAuth servers, leave these blank and use Authenticate instead — sign-in is
							managed for you and applied to every engine.
						</p>
					{/if}
					<div class="flex items-center gap-3">
						<Button
							variant="primary"
							size="sm"
							loading={savingConfig}
							disabled={draft.missingRequired.length > 0 || (server?.transport === 'stdio' && !draft.command.trim())}
							onclick={saveConfig}
						>Save configuration</Button>
						{#if configSaved}
							<span class="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
								<Icon name="lucide:check" class="w-3.5 h-3.5" /> Saved
							</span>
						{/if}
					</div>
				</div>

			{:else if tab === 'tools' && server}
				<McpToolsPanel {server} />

			{:else if tab === 'advanced'}
				<div class="space-y-5">
					{#if server}
						<div>
							{@render sectionHeading('Identifiers')}
							<div class="rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
								<div class="flex items-baseline gap-3 px-3 py-1.5 text-xs">
									<span class="w-28 shrink-0 text-slate-500 dark:text-slate-400">Namespace</span>
									<span class="font-mono text-slate-700 dark:text-slate-300 break-all">{server.namespace}</span>
								</div>
								<div class="flex items-baseline gap-3 px-3 py-1.5 text-xs">
									<span class="w-28 shrink-0 text-slate-500 dark:text-slate-400">Slug</span>
									<span class="font-mono text-slate-700 dark:text-slate-300 break-all">{server.slug}</span>
								</div>
								{#if server.registryName}
									<div class="flex items-baseline gap-3 px-3 py-1.5 text-xs">
										<span class="w-28 shrink-0 text-slate-500 dark:text-slate-400">Registry name</span>
										<span class="font-mono text-slate-700 dark:text-slate-300 break-all">{server.registryName}</span>
									</div>
								{/if}
							</div>
						</div>

						{#if !isBuiltIn}
							<div>
								{@render sectionHeading('Config each engine receives')}
								<p class="text-[11px] text-slate-400 -mt-1 mb-2">
									Not the stored row: every connector reaches an engine as a remote
									pointing at Clopen's own proxy.
								</p>
								{#if engineConfigError}
									<p class="text-xs text-red-500">{engineConfigError}</p>
								{:else if !engineConfigs}
									<p class="text-xs text-slate-400">Loading…</p>
								{:else if Object.keys(engineConfigs).length === 0}
									<p class="text-xs text-slate-400">Nothing — a disabled connector is handed to no engine.</p>
								{:else}
									<div class="space-y-2">
										{#each Object.entries(engineConfigs) as [engine, config] (engine)}
											<div class="space-y-1">
												<p class="text-[11px] font-semibold text-slate-400">{engine}</p>
												<pre class="max-h-40 overflow-auto p-3 text-[11px] font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-700 dark:text-slate-300">{config}</pre>
											</div>
										{/each}
									</div>
								{/if}
							</div>
						{/if}
					{/if}

					{#if account}
						<div>
							{@render sectionHeading('Projections')}
							<div class="rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
								{#each account.projections as projection (projection.capability + projection.targetKind)}
									<div class="flex items-baseline gap-3 px-3 py-1.5 text-xs">
										<span class="w-28 shrink-0 text-slate-500 dark:text-slate-400">{CAPABILITY_LABELS[projection.capability]}</span>
										<span class="text-slate-400">
											{projection.adopted ? 'adopted an existing row' : 'created a row'}
										</span>
									</div>
								{:else}
									<p class="px-3 py-1.5 text-xs text-slate-400">Nothing projected.</p>
								{/each}
							</div>
						</div>
					{/if}

					{#if !isBuiltIn && (account || server)}
						<div class="pt-1">
							<h4 class="text-[11px] font-semibold uppercase tracking-wide text-red-500/80 mb-1.5">Danger zone</h4>
							{#if confirmRemove}
								<div class="space-y-2 p-3 rounded-xl border border-red-500/20 bg-red-500/5">
									<p class="text-xs text-slate-600 dark:text-slate-300">
										{#if account}
											Disconnect <span class="font-semibold">{account.label}</span>? Its credential is
											deleted and every surface it created is released.
											{#if account.projections.some(p => p.adopted)}
												The connector it adopted stays, restored to the configuration it had before.
											{/if}
										{:else}
											Remove <span class="font-semibold">{server?.name}</span>? It will be removed from
											every engine. This can't be undone.
										{/if}
									</p>
									<div class="flex gap-2">
										<Button variant="ghost" size="sm" onclick={() => (confirmRemove = false)}>Cancel</Button>
										<Button variant="primary" size="sm" loading={removing} class="!bg-red-600 hover:!bg-red-700" onclick={remove}>
											{account ? 'Disconnect' : 'Remove'}
										</Button>
									</div>
								</div>
							{:else}
								<button
									type="button"
									onclick={() => (confirmRemove = true)}
									class="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-red-500 border border-red-500/20 hover:bg-red-500/5 transition-colors"
								>
									<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
									{account ? 'Disconnect account' : 'Remove connector'}
								</button>
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/snippet}
</Modal>
