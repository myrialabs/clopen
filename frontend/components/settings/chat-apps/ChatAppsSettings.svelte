<script lang="ts">
	/**
	 * Chat Apps: control Clopen from a chat app (Telegram first).
	 *
	 * The bot is an integration account (one token); chats are linked to it,
	 * and each one can be switched off or unlinked. What a chat can do is the
	 * control catalog on the server, and the command reference below is read
	 * from it.
	 *
	 * Everything here is pushed: a chat pairing from the phone, a bot coming up or switching between webhook and polling all arrive as
	 * `chat-apps:changed`, so the page never needs reopening to be current.
	 */
	import { onMount } from 'svelte';
	import ws from '$frontend/utils/ws';
	import { integrationsStore } from '$frontend/stores/features/integrations.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { showConfirm } from '$frontend/stores/ui/dialog.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ProviderMark from '$frontend/components/common/display/ProviderMark.svelte';
	import ShareLinkCard from '$frontend/components/common/share/ShareLinkCard.svelte';
	import ConnectAccountModal from '$frontend/components/settings/integrations/ConnectAccountModal.svelte';
	import type { IntegrationProviderInfo } from '$shared/types/integrations';

	interface ChatLink {
		id: string;
		displayName: string | null;
		isEnabled: boolean;
		createdAt: string;
		lastUsedAt: string | null;
	}

	interface ChatBot {
		accountId: string;
		provider: string;
		label: string;
		botName: string | null;
		projectId: string | null;
		running: boolean;
		mode: 'webhook' | 'polling' | null;
		originSource: 'configured' | 'domain' | 'tunnel' | null;
		connection: 'connecting' | 'open' | 'closed' | null;
		error: string | null;
		control: boolean;
		links: ChatLink[];
	}

	interface CommandInfo {
		command: string;
		hint: string | null;
		description: string;
		group: string;
	}

	let bots = $state<ChatBot[]>([]);
	let commands = $state<CommandInfo[]>([]);
	let isLoading = $state(true);
	let pairing = $state<{ accountId: string; url: string; expiresAt: number } | null>(null);
	let pairingBusy = $state<string | null>(null);
	let now = $state(Date.now());
	let connectProvider = $state<IntegrationProviderInfo | null>(null);
	let busy = $state<string | null>(null);
	let showCommands = $state(false);

	const pairingRemaining = $derived(pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0);
	const commandGroups = $derived.by(() => {
		const groups = new Map<string, CommandInfo[]>();
		for (const command of commands) {
			const list = groups.get(command.group) ?? [];
			list.push(command);
			groups.set(command.group, list);
		}
		return [...groups.entries()];
	});

	function toast(type: 'success' | 'error', title: string, message: string) {
		addNotification({ type, title, message });
	}

	function errorText(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	async function load() {
		try {
			const result = await ws.http('chat-apps:bots', { requestOrigin: window.location.origin });
			const before = new Set(bots.flatMap((bot) => bot.links.map((link) => link.id)));
			bots = result as ChatBot[];
			// The phone just finished pairing: the code on screen has done its job.
			if (pairing && bots.some((bot) => bot.links.some((link) => !before.has(link.id)))) pairing = null;
		} catch (error) {
			toast('error', 'Chat apps', errorText(error));
		} finally {
			isLoading = false;
		}
	}

	async function loadCommands() {
		try {
			commands = await ws.http('chat-apps:commands', {});
		} catch {
			commands = [];
		}
	}

	/** Run a change, then reload. One action at a time per row. */
	async function act(key: string, title: string, task: () => Promise<unknown>) {
		busy = key;
		try {
			await task();
			await load();
		} catch (error) {
			toast('error', title, errorText(error));
		} finally {
			busy = null;
		}
	}

	async function startPairing(bot: ChatBot) {
		pairingBusy = bot.accountId;
		try {
			const result = await ws.http('chat-apps:pair', { accountId: bot.accountId });
			pairing = { accountId: bot.accountId, url: result.url, expiresAt: Date.parse(result.expiresAt) };
		} catch (error) {
			toast('error', 'Could not create a link', errorText(error));
		} finally {
			pairingBusy = null;
		}
	}

	function setEnabled(link: ChatLink) {
		void act(link.id, 'Could not save', () => ws.http('chat-apps:set-enabled', { linkId: link.id, enabled: !link.isEnabled }));
	}

	/** Close the link and QR, and withdraw the code: scanning it later does nothing. */
	function closePairing() {
		const open = pairing;
		pairing = null;
		if (open) void ws.http('chat-apps:pair-cancel', { accountId: open.accountId }).catch(() => {});
	}

	async function testLink(link: ChatLink) {
		busy = link.id;
		try {
			await ws.http('chat-apps:test', { linkId: link.id });
			toast('success', 'Test sent', 'Check the Telegram chat.');
		} catch (error) {
			toast('error', 'Test failed', errorText(error));
		} finally {
			busy = null;
		}
	}

	async function unlink(link: ChatLink) {
		const confirmed = await showConfirm({
			title: 'Unlink this chat?',
			message: 'The chat stops controlling Clopen. You can link it again any time.',
			confirmText: 'Unlink',
			type: 'warning'
		});
		if (confirmed) void act(link.id, 'Could not unlink', () => ws.http('chat-apps:unlink', { linkId: link.id }));
	}

	async function removeBot(bot: ChatBot) {
		const confirmed = await showConfirm({
			title: `Remove ${bot.botName ?? bot.label}?`,
			message: 'Clopen disconnects the bot and unlinks every chat on it. The bot itself stays in Telegram; you can connect it again with its token.',
			confirmText: 'Remove bot',
			type: 'error'
		});
		if (confirmed) void act(bot.accountId, 'Could not remove the bot', () => integrationsStore.disconnect(bot.accountId));
	}

	async function connectBot() {
		await integrationsStore.load();
		connectProvider = integrationsStore.providers.find((provider) => provider.id === 'telegram') ?? null;
	}

	function deliveryLabel(bot: ChatBot): string {
		if (!bot.control) return 'Control is switched off for this bot';
		if (!bot.running) return bot.error ? `Not running: ${bot.error}` : 'Starting…';
		if (bot.connection === 'connecting') return 'Connecting to Telegram…';
		if (bot.connection === 'closed') return 'Disconnected from Telegram';
		if (bot.mode === 'polling') return 'Connected (polling)';
		return `Connected (webhook via ${bot.originSource === 'tunnel' ? 'a tunnel' : bot.originSource === 'domain' ? "this server's address" : 'the configured URL'})`;
	}

	function deliveryTone(bot: ChatBot): string {
		if (!bot.control || bot.error || bot.connection === 'closed') return 'bg-red-500';
		if (!bot.running || bot.connection === 'connecting') return 'bg-amber-500 animate-pulse';
		return 'bg-emerald-500';
	}

	function chatName(link: ChatLink): string {
		return link.displayName ?? 'Telegram chat';
	}

	function formatCountdown(seconds: number): string {
		return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
	}

	onMount(() => {
		void load();
		void loadCommands();
		const offChanged = ws.on('chat-apps:changed', () => void load());
		const offIntegrations = ws.on('integrations:changed', () => void load());
		const timer = setInterval(() => {
			now = Date.now();
			if (pairing && pairing.expiresAt <= now) pairing = null;
		}, 1000);
		return () => {
			offChanged();
			offIntegrations();
			clearInterval(timer);
		};
	});
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Chat Apps</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">Control Clopen from your phone through a chat app.</p>

	<div class="flex flex-col gap-3.5">
		<div
			class="p-4 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl transition-all duration-150 hover:border-violet-500/20"
		>
			<div class="flex items-center gap-3.5">
				<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-sky-500/10 dark:bg-sky-500/15">
					<ProviderMark provider="telegram" size="w-5.5 h-5.5" fallback="lucide:send" />
				</div>
				<div class="flex flex-col gap-0.5 min-w-0">
					<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Telegram</div>
					<div class="text-xs text-slate-600 dark:text-slate-500">Link your chat, then just type.</div>
				</div>
			</div>

			<div class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-col gap-3">
				{#if isLoading}
					<div class="text-xs text-slate-500">Loading…</div>
				{:else if bots.length === 0}
					<div class="flex flex-col gap-2">
						<p class="text-xs text-slate-600 dark:text-slate-500">
							No bot is connected yet. Create one with @BotFather in Telegram and paste its token here, then link your chat to it.
						</p>
						<div>
							<button
								type="button"
								class="inline-flex items-center gap-1.5 py-2 px-3.5 bg-violet-500/10 border border-violet-500/20 dark:border-violet-500/25 rounded-lg text-violet-600 dark:text-violet-400 text-xs font-semibold cursor-pointer transition-all duration-150 hover:bg-violet-500/20 hover:border-violet-600 dark:hover:border-violet-500/40"
								onclick={connectBot}
							>
								<Icon name="lucide:plus" class="w-3.5 h-3.5" />
								<span>Connect a Telegram bot</span>
							</button>
						</div>
					</div>
				{:else}
					{#each bots as bot (bot.accountId)}
						<div class="flex flex-col gap-2.5" class:opacity-60={busy === bot.accountId}>
							<div class="flex items-center justify-between gap-2">
								<div class="flex flex-col min-w-0">
									<span class="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">
										{bot.botName ?? bot.label}
									</span>
									<span class="flex items-center gap-1.5 text-xs text-slate-500">
										<span class="w-1.5 h-1.5 rounded-full shrink-0 {deliveryTone(bot)}"></span>
										<span class="truncate">{deliveryLabel(bot)}</span>
									</span>
								</div>
								<div class="flex items-center gap-1.5 shrink-0">
									<button
										type="button"
										disabled={!bot.running || !bot.control || pairingBusy === bot.accountId}
										class="inline-flex items-center gap-1.5 py-2 px-3.5 bg-violet-500/10 border border-violet-500/20 dark:border-violet-500/25 rounded-lg text-violet-600 dark:text-violet-400 text-xs font-semibold cursor-pointer transition-all duration-150 hover:bg-violet-500/20 hover:border-violet-600 dark:hover:border-violet-500/40 disabled:opacity-50 disabled:cursor-not-allowed"
										onclick={() => startPairing(bot)}
									>
										<Icon name="lucide:link" class="w-3.5 h-3.5" />
										<span>{bot.links.length > 0 ? 'Link another chat' : 'Link my chat'}</span>
									</button>
									<button
										type="button"
										title="Remove this bot"
										aria-label="Remove this bot"
										disabled={busy === bot.accountId}
										class="flex items-center justify-center w-8.5 h-8.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 cursor-pointer transition-colors hover:text-red-600 hover:border-red-500/40 dark:hover:text-red-400 disabled:opacity-50"
										onclick={() => removeBot(bot)}
									>
										<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
									</button>
								</div>
							</div>

							{#if !bot.control}
								<p class="text-xs text-amber-700 dark:text-amber-400">
									Turn on "Control Clopen" for this bot in Settings → Integrations to use it.
								</p>
							{/if}

							{#if pairing?.accountId === bot.accountId}
								<div class="flex flex-col gap-1.5">
									<div class="flex items-start justify-between gap-2">
										<p class="text-xs text-slate-600 dark:text-slate-500">
											Scan with your phone or open the link, then tap <span class="font-semibold">Start</span> in Telegram.
										</p>
										<button
											type="button"
											title="Close and cancel this link"
											aria-label="Close and cancel this link"
											class="inline-flex items-center gap-1 shrink-0 py-1 px-2 rounded-md text-xs text-slate-500 cursor-pointer transition-colors hover:text-red-600 hover:bg-red-500/10 dark:hover:text-red-400"
											onclick={closePairing}
										>
											<Icon name="lucide:x" class="w-3.5 h-3.5" />
											<span>Cancel link</span>
										</button>
									</div>
									<ShareLinkCard url={pairing.url} qr="always" qrSize={148} caption="Opens the bot in Telegram" linkify>
										{#snippet meta()}
											<span class="text-xs text-slate-500">Expires in {formatCountdown(pairingRemaining)} · works once</span>
										{/snippet}
									</ShareLinkCard>
								</div>
							{/if}

							{#each bot.links as link (link.id)}
								<div
									class="flex flex-col gap-2 p-3 rounded-lg border bg-white/60 dark:bg-slate-900/40 border-slate-200 dark:border-slate-700/80"
									class:opacity-60={busy === link.id}
								>
									<div class="flex items-center justify-between gap-2">
										<div class="flex items-center gap-2 min-w-0">
											<Icon name="lucide:smartphone" class="w-3.5 h-3.5 shrink-0 text-slate-500" />
											<span class="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">{chatName(link)}</span>
										</div>

										<label class="flex items-center gap-2 shrink-0 text-xs text-slate-500" title={link.isEnabled ? 'This chat can control Clopen' : 'This chat can do nothing until it is switched on'}>
											<span>{link.isEnabled ? 'On' : 'Off'}</span>
											<span class="relative inline-block w-10 h-5.5">
												<input
													type="checkbox"
													checked={link.isEnabled}
													disabled={busy === link.id}
													onchange={() => setEnabled(link)}
													class="opacity-0 w-0 h-0"
												/>
												<span
													class="absolute cursor-pointer inset-0 bg-slate-600/40 rounded-3xl transition-all duration-200
													before:absolute before:content-[''] before:h-4 before:w-4 before:left-0.75 before:bottom-0.75 before:bg-white before:rounded-full before:transition-all before:duration-200
													{link.isEnabled ? 'bg-gradient-to-br from-violet-600 to-purple-600 before:translate-x-4.5' : ''}"
												></span>
											</span>
										</label>
									</div>

									<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
										<button
											type="button"
											class="inline-flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400 hover:underline cursor-pointer disabled:opacity-50"
											disabled={busy === link.id || !link.isEnabled}
											onclick={() => testLink(link)}
										>
											<Icon name="lucide:send" class="w-3 h-3" />
											<span>Send test</span>
										</button>
										<button
											type="button"
											class="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-red-600 dark:hover:text-red-400 cursor-pointer disabled:opacity-50"
											disabled={busy === link.id}
											onclick={() => unlink(link)}
										>
											<Icon name="lucide:unlink" class="w-3 h-3" />
											<span>Unlink</span>
										</button>
									</div>
								</div>
							{/each}
						</div>
					{/each}
				{/if}
			</div>
		</div>

		<!-- What a chat can do: read from the control catalog, not written here. -->
		<div class="p-4 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
			<button
				type="button"
				class="flex items-center justify-between w-full text-left cursor-pointer"
				onclick={() => (showCommands = !showCommands)}
				aria-expanded={showCommands}
			>
				<span class="flex flex-col gap-0.5">
					<span class="text-sm font-semibold text-slate-900 dark:text-slate-100">What a chat can do</span>
					<span class="text-xs text-slate-600 dark:text-slate-500">The same list as the bot's / menu.</span>
				</span>
				<Icon name="lucide:chevron-right" class="w-4 h-4 shrink-0 text-slate-500 transition-transform duration-150 {showCommands ? 'rotate-90' : ''}" />
			</button>
			{#if showCommands}
				<div class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-col gap-4">
					<p class="text-xs text-slate-600 dark:text-slate-500">
						Type to chat, or send photos and files. Reply to an earlier message to continue from there, or edit one you sent to rewrite it. Going back asks first, because it restores files.
					</p>
					{#each commandGroups as [group, entries] (group)}
						<div class="flex flex-col gap-2">
							<div class="text-xs font-semibold text-slate-700 dark:text-slate-300">{group}</div>
							{#each entries as entry (entry.command)}
								<div class="flex flex-col gap-0.5">
									<div class="flex items-center gap-2">
										<span class="font-mono text-xs text-violet-700 dark:text-violet-300">/{entry.command}{entry.hint ? ` ${entry.hint}` : ''}</span>
									</div>
									<span class="text-xs text-slate-600 dark:text-slate-500">{entry.description}</span>
								</div>
							{/each}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>

<!-- The hub's own connect dialog, embedded, so connecting never detours through Settings → Integrations. -->
<ConnectAccountModal
	provider={connectProvider}
	onClose={() => (connectProvider = null)}
	onConnected={() => {
		connectProvider = null;
		void load();
	}}
/>
