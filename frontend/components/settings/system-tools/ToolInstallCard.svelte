<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { browser } from '$frontend/app-environment';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import ws from '$frontend/utils/ws';
	import type { Terminal } from '@xterm/xterm';
	import type { FitAddon } from '@xterm/addon-fit';

	type ToolId = 'git' | 'claude' | 'opencode' | 'copilot' | 'chrome' | 'cloudflared';
	type SessionStatus = 'running' | 'success' | 'failed' | 'cancelled';

	interface ManualInstruction {
		label: string;
		command: string;
		docs?: string;
	}

	interface RecipeDTO {
		tool: ToolId;
		autoInstallable: boolean;
		unavailableReason?: string;
		displayCommand?: string;
		missingPrereqs: ToolId[];
		manualInstructions: ManualInstruction[];
		pendingCurlDownload?: {
			version: string;
			url: string;
			sha256: string;
			archKey: string;
		};
	}

	interface ToolStatusDTO {
		tool: ToolId;
		installed: boolean;
		version: string | null;
		source: string | null;
	}

	interface ActiveSession {
		sessionId: string;
		tool: ToolId;
		status: SessionStatus;
		exitCode: number | null;
		startedAt: number;
		endedAt: number | null;
		totalLines: number;
		recentLines: string[];
		displayCommand: string;
	}

	interface Props {
		tool: ToolId;
		title: string;
		description: string;
	}

	const { tool, title, description }: Props = $props();

	let status = $state<ToolStatusDTO | null>(null);
	let recipe = $state<RecipeDTO | null>(null);
	let isLoading = $state(true);

	let sessionId = $state<string | null>(null);
	let sessionStatus = $state<SessionStatus | null>(null);
	let exitCode = $state<number | null>(null);

	let confirmInstallOpen = $state(false);
	let confirmCancelOpen = $state(false);
	let manualOpen = $state(false);
	let errorMessage = $state<string | null>(null);

	let commandCopied = $state(false);
	let commandCopiedTimer: ReturnType<typeof setTimeout> | null = null;

	let termContainer = $state<HTMLDivElement | null>(null);
	let terminal: Terminal | null = null;
	let fitAddon: FitAddon | null = null;
	let terminalReady = $state(false);
	let pendingBuffer = '';
	const cleanups: Array<() => void> = [];

	const isRunning = $derived(sessionStatus === 'running');
	const hasSession = $derived(sessionId !== null && sessionStatus !== null);

	const confirmMessage = $derived.by(() => {
		if (!recipe) return '';
		const lines = [
			'The following command will run on the clopen server:',
			recipe.displayCommand ?? ''
		];
		if (recipe.pendingCurlDownload) {
			const { version, url, sha256, archKey } = recipe.pendingCurlDownload;
			lines.push(
				'',
				'This installer needs curl, which is not present on the server.',
				`Clopen will first download a verified static curl (${archKey}, v${version}):`,
				url,
				`SHA256: ${sha256}`
			);
		}
		return lines.join('\n');
	});

	async function refresh() {
		isLoading = true;
		try {
			const res = await ws.http('system-tools:status', { tool });
			status = res.status;
			recipe = res.recipe;
			if (res.activeSession && res.activeSession.status === 'running' && !sessionId) {
				attachSession(res.activeSession);
			}
		} catch {
			status = null;
			recipe = null;
		}
		isLoading = false;
	}

	function attachSession(session: ActiveSession) {
		sessionId = session.sessionId;
		sessionStatus = session.status;
		exitCode = session.exitCode;
		const replay = session.recentLines.join('\r\n');
		if (replay) writeToTerminal(replay + '\r\n');
	}

	function writeToTerminal(data: string) {
		if (terminal) {
			terminal.write(data);
		} else {
			pendingBuffer += data;
		}
	}

	async function initTerminal() {
		if (!browser || !termContainer || terminal) return;

		const [{ Terminal }, { FitAddon }] = await Promise.all([
			import('@xterm/xterm'),
			import('@xterm/addon-fit')
		]);

		await import('@xterm/xterm/css/xterm.css');

		terminal = new Terminal({
			theme: {
				background: '#0f172a',
				foreground: '#e2e8f0',
				cursor: '#22c55e',
				black: '#18181b',
				red: '#ef4444',
				green: '#22c55e',
				yellow: '#eab308',
				blue: '#60a5fa',
				magenta: '#a855f7',
				cyan: '#06b6d4',
				white: '#f4f4f5',
				brightBlack: '#52525b',
				brightRed: '#f87171',
				brightGreen: '#4ade80',
				brightYellow: '#facc15',
				brightBlue: '#60a5fa',
				brightMagenta: '#c084fc',
				brightCyan: '#22d3ee',
				brightWhite: '#ffffff'
			},
			fontSize: 11,
			fontFamily: 'JetBrains Mono, Monaco, "Cascadia Code", Consolas, monospace',
			lineHeight: 1.1,
			cursorBlink: false,
			cursorStyle: 'underline' as const,
			convertEol: true,
			scrollback: 5000,
			disableStdin: true,
			allowTransparency: false,
			cols: 120,
			rows: 18
		});

		fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.open(termContainer);
		fitAddon.fit();
		terminalReady = true;

		if (pendingBuffer) {
			terminal.write(pendingBuffer);
			pendingBuffer = '';
		}
	}

	function disposeTerminal() {
		if (terminal) {
			terminal.dispose();
			terminal = null;
			fitAddon = null;
			terminalReady = false;
		}
	}

	$effect(() => {
		if (termContainer && !terminal) {
			initTerminal();
		}
	});

	$effect(() => {
		if (terminalReady && fitAddon && termContainer) {
			const observer = new ResizeObserver(() => {
				fitAddon?.fit();
			});
			observer.observe(termContainer);
			return () => observer.disconnect();
		}
	});

	onMount(() => {
		cleanups.push(
			ws.on('system-tools:install-started', (payload) => {
				if (payload.tool !== tool) return;
				sessionId = payload.sessionId;
				sessionStatus = 'running';
				exitCode = null;
				errorMessage = null;
				pendingBuffer = '';
				if (terminal) {
					terminal.clear();
					terminal.reset();
				}
			}),
			ws.on('system-tools:install-stream', (payload) => {
				if (payload.sessionId !== sessionId) return;
				writeToTerminal(payload.line + '\r\n');
			}),
			ws.on('system-tools:install-finished', (payload) => {
				if (payload.sessionId !== sessionId) return;
				sessionStatus = payload.status;
				exitCode = payload.exitCode;
				if (payload.status === 'success') {
					dismissSession();
					refresh();
				}
			})
		);
		refresh();
	});

	onDestroy(() => {
		for (const cleanup of cleanups) cleanup();
		cleanups.length = 0;
		if (commandCopiedTimer) clearTimeout(commandCopiedTimer);
		disposeTerminal();
	});

	function requestInstall() {
		errorMessage = null;
		confirmInstallOpen = true;
	}

	async function doInstall() {
		if (!recipe?.autoInstallable) return;
		errorMessage = null;
		exitCode = null;
		sessionStatus = 'running';
		pendingBuffer = '';
		if (terminal) {
			terminal.clear();
			terminal.reset();
		}
		await tick();
		try {
			const res = await ws.http('system-tools:install-start', { tool });
			sessionId = res.sessionId;
		} catch (err: unknown) {
			errorMessage = err instanceof Error ? err.message : 'Failed to start install';
			sessionStatus = null;
		}
	}

	function requestCancel() {
		if (!sessionId) return;
		confirmCancelOpen = true;
	}

	async function doCancel() {
		if (!sessionId) return;
		try {
			await ws.http('system-tools:install-cancel', { sessionId });
		} catch {
			// Ignore — status will update via stream event
		}
	}

	function dismissSession() {
		sessionId = null;
		sessionStatus = null;
		exitCode = null;
		errorMessage = null;
		pendingBuffer = '';
		if (terminal) {
			terminal.clear();
			terminal.reset();
		}
	}

	async function copyToClipboard(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			commandCopied = true;
			if (commandCopiedTimer) clearTimeout(commandCopiedTimer);
			commandCopiedTimer = setTimeout(() => { commandCopied = false; }, 2000);
		} catch {
			// Ignore
		}
	}
</script>

<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
	<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700/50">
		<div>
			<h3 class="font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
			<p class="text-xs text-slate-500 dark:text-slate-400">{description}</p>
		</div>

		{#if isLoading}
			<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400">
				<Icon name="lucide:loader" class="w-3 h-3 animate-spin" />
				Checking...
			</span>
		{:else if status?.installed}
			<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
				<span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>
				Installed
			</span>
		{:else}
			<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
				<span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>
				Not Installed
			</span>
		{/if}
	</div>

	<div class="px-5 py-4 space-y-3">
		{#if isLoading}
			<div class="flex items-center justify-center py-6">
				<Icon name="lucide:loader" class="w-5 h-5 animate-spin text-slate-400" />
			</div>
		{:else if status}
			{#if status.installed}
				<div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
					<Icon name="lucide:tag" class="w-4 h-4 text-slate-400" />
					<span>Version: <span class="font-mono font-medium text-slate-900 dark:text-slate-100">{status.version || 'Unknown'}</span></span>
				</div>
				{#if status.source}
					<div class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
						<Icon name="lucide:folder" class="w-3.5 h-3.5 shrink-0" />
						<span class="font-mono truncate">{status.source}</span>
					</div>
				{/if}
			{/if}

			{#if hasSession}
				<!-- Live / recent install output -->
				<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-950 overflow-hidden">
					<div class="flex items-center justify-between px-3 py-1.5 bg-slate-900 border-b border-slate-800 text-xs">
						<div class="flex items-center gap-2 text-slate-300">
							{#if isRunning}
								<Icon name="lucide:loader" class="w-3.5 h-3.5 animate-spin text-violet-400" />
								<span>Installing...</span>
							{:else if sessionStatus === 'success'}
								<Icon name="lucide:circle-check" class="w-3.5 h-3.5 text-green-400" />
								<span class="text-green-400">Success</span>
							{:else if sessionStatus === 'cancelled'}
								<Icon name="lucide:circle-slash" class="w-3.5 h-3.5 text-amber-400" />
								<span class="text-amber-400">Cancelled</span>
							{:else}
								<Icon name="lucide:circle-x" class="w-3.5 h-3.5 text-red-400" />
								<span class="text-red-400">Failed{exitCode !== null ? ` (exit ${exitCode})` : ''}</span>
							{/if}
						</div>
						{#if !isRunning}
							<button
								type="button"
								class="text-2xs text-slate-400 hover:text-slate-200 transition-colors"
								onclick={dismissSession}
							>
								Dismiss
							</button>
						{/if}
					</div>
					<div
						bind:this={termContainer}
						class="px-2 py-2 bg-slate-950 h-60"
					></div>
				</div>
			{/if}

			{#if errorMessage}
				<div class="flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50">
					<Icon name="lucide:circle-alert" class="w-4 h-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
					<span class="text-xs text-red-700 dark:text-red-300">{errorMessage}</span>
				</div>
			{/if}

			<!-- Action row -->
			<div class="flex flex-wrap items-center gap-2 pt-1">
				{#if isRunning}
					<button
						type="button"
						class="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-transparent bg-violet-600 text-white cursor-wait"
						disabled
					>
						<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
						Installing...
					</button>
					<button
						type="button"
						class="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
						onclick={requestCancel}
					>
						<Icon name="lucide:x" class="w-4 h-4" />
						Cancel
					</button>
				{:else if status.installed}
					<button
						type="button"
						class="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
						onclick={refresh}
					>
						<Icon name="lucide:refresh-cw" class="w-4 h-4" />
						Recheck
					</button>
				{:else if recipe?.autoInstallable}
					<button
						type="button"
						class="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-transparent bg-violet-600 text-white hover:bg-violet-700 transition-colors"
						onclick={requestInstall}
					>
						<Icon name="lucide:download" class="w-4 h-4" />
						Install
					</button>
					<button
						type="button"
						class="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
						onclick={refresh}
					>
						<Icon name="lucide:refresh-cw" class="w-4 h-4" />
						Recheck
					</button>
				{:else}
					<button
						type="button"
						class="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
						onclick={refresh}
					>
						<Icon name="lucide:refresh-cw" class="w-4 h-4" />
						Recheck
					</button>
				{/if}

				{#if recipe && recipe.manualInstructions.length > 0}
					<button
						type="button"
						class="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
						onclick={() => (manualOpen = !manualOpen)}
					>
						<Icon name={manualOpen ? 'lucide:chevron-up' : 'lucide:chevron-down'} class="w-3.5 h-3.5" />
						Manual instructions
					</button>
				{/if}
			</div>

			{#if recipe && !recipe.autoInstallable && !status.installed && recipe.unavailableReason}
				<div class="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-700/50">
					<Icon name="lucide:info" class="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
					<div class="text-xs text-amber-800 dark:text-amber-300 space-y-1">
						<p class="font-medium">Auto-install unavailable</p>
						<p class="text-amber-700 dark:text-amber-400">{recipe.unavailableReason}</p>
						{#if recipe.missingPrereqs.length > 0}
							<p class="text-amber-700 dark:text-amber-400">Missing prerequisite{recipe.missingPrereqs.length > 1 ? 's' : ''}: <span class="font-mono">{recipe.missingPrereqs.join(', ')}</span></p>
						{/if}
					</div>
				</div>
			{/if}

			{#if manualOpen && recipe && recipe.manualInstructions.length > 0}
				<div class="space-y-2.5 p-3 rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/60">
					{#each recipe.manualInstructions as instr, i (i)}
						<div class="space-y-1">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-semibold text-slate-700 dark:text-slate-300">{instr.label}</span>
								{#if instr.docs}
									<a
										href={instr.docs}
										target="_blank"
										rel="noopener noreferrer"
										class="inline-flex items-center gap-1 text-2xs text-violet-600 dark:text-violet-400 hover:underline"
									>
										<Icon name="lucide:external-link" class="w-3 h-3" />
										Docs
									</a>
								{/if}
							</div>
							<div class="relative group">
								<pre class="bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-200 rounded-md px-3 py-2 text-2xs font-mono overflow-x-auto">{instr.command}</pre>
								<button
									type="button"
									class="absolute top-1.5 right-1.5 flex items-center p-1 rounded-md transition-colors {commandCopied ? 'bg-violet-600/80 text-white' : 'bg-slate-300/80 dark:bg-slate-700/80 text-slate-600 dark:text-slate-300 hover:bg-slate-400/80 dark:hover:bg-slate-600'}"
									onclick={() => copyToClipboard(instr.command)}
									aria-label="Copy command"
								>
									<Icon name={commandCopied ? 'lucide:check' : 'lucide:copy'} class="w-3 h-3" />
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</div>

<Dialog
	bind:isOpen={confirmInstallOpen}
	onClose={() => (confirmInstallOpen = false)}
	type="info"
	title="Install {title}?"
	message={confirmMessage}
	confirmText="Install"
	cancelText="Cancel"
	onConfirm={doInstall}
/>

<Dialog
	bind:isOpen={confirmCancelOpen}
	onClose={() => (confirmCancelOpen = false)}
	type="warning"
	title="Cancel install?"
	message="This will terminate the running install process. Partial changes from the installer may remain on disk."
	confirmText="Cancel Install"
	cancelText="Keep Running"
	onConfirm={doCancel}
/>
