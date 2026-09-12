<script lang="ts">
	/**
	 * Start a build — and, when the target cannot build yet, get it there.
	 *
	 * A PANEL, not a modal. It shares one dialog with the new-project flow:
	 * two modals reachable from two header buttons, both about deploying, made
	 * the user choose before knowing what either did.
	 *
	 * This dialog IS the confirmation for the action it starts, so the store does
	 * not ask again on top of it. Production is never preselected: a preview
	 * build costs build minutes, a production build replaces what the world
	 * sees, and the two must not be one keystroke apart.
	 *
	 * Two rules learned the hard way, both from the same failure.
	 *
	 * READINESS IS CHECKED BEFORE THE BUTTON IS OFFERED, and `blocked` disables
	 * it. Attaching a repository needs the provider ACCOUNT to hold a git
	 * connection, which is an OAuth flow on their site that no API token can
	 * supply. A button that cannot win is worse than no button, because the user
	 * only learns the prerequisite after committing to the action.
	 *
	 * FAILURES ARE RENDERED HERE, NOT AS A TOAST. These messages end in "set it
	 * up at <url>", and a toast takes the URL away a few seconds later — before
	 * it can be clicked. Anything a user has to act on stays on screen until
	 * they dismiss it.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import InlineError from './InlineError.svelte';
	import { deploymentsStore } from '$frontend/stores/features/deployments.svelte';

	interface Props {
		/** True while this panel is the visible tab — it fetches on becoming so. */
		isActive: boolean;
		onClose: () => void;
	}

	const { isActive, onClose }: Props = $props();

	let ref = $state('');
	let production = $state(false);
	let touchedRef = $state(false);
	let isConnecting = $state(false);
	let failure = $state<string | null>(null);

	const info = $derived(deploymentsStore.deployInfo);
	const loading = $derived(deploymentsStore.isLoadingDeployInfo);
	const capabilities = $derived(deploymentsStore.source?.capabilities ?? null);

	const needsRepo = $derived(info !== null && !info.canDeploy && info.suggestedRepo !== null);
	const providerCanConnect = $derived(capabilities?.connectRepository === true);

	/**
	 * Ready means verified ready. `unknown` still allows the attempt — refusing
	 * on the strength of a check we could not read would invent a dead end of our
	 * own — but it says so rather than showing a confident button.
	 */
	const connectState = $derived(info?.connectState ?? 'unavailable');
	const canPressConnect = $derived(
		needsRepo && providerCanConnect && (connectState === 'ready' || connectState === 'unknown')
	);
	const isBlocked = $derived(needsRepo && connectState === 'blocked');

	$effect(() => {
		if (!isActive) return;
		touchedRef = false;
		production = false;
		failure = null;
		void deploymentsStore.loadDeployInfo();
	});

	/**
	 * Branches worth one click, most likely first.
	 *
	 * The branch you are standing on beats the production branch as a guess,
	 * because the reason to open this dialog is usually the work in front of
	 * you — but both are offered, since the other one is the next most likely.
	 */
	const suggestions = $derived.by(() => {
		const list = [info?.currentBranch, info?.productionBranch].filter(
			(entry): entry is string => Boolean(entry)
		);
		return [...new Set(list)];
	});

	// Prefilled once, and not again — retyping over an edit because a refresh
	// landed is how a carefully typed branch name gets lost.
	$effect(() => {
		const branch = suggestions[0];
		if (!touchedRef && branch) ref = branch;
	});

	async function recheck() {
		failure = null;
		// Forced: the whole point of pressing this is that the cached answer is
		// the one we no longer believe.
		await deploymentsStore.loadDeployInfo({ force: true });
	}

	async function connect() {
		if (!info?.suggestedRepo || isConnecting) return;
		isConnecting = true;
		failure = null;
		try {
			await deploymentsStore.connectRepository(info.suggestedRepo, 'github');
		} catch (error) {
			// Kept on screen, with its link clickable. The pre-check should have
			// caught this, and when it did not, this is the only place the reason
			// survives long enough to be acted on.
			failure = error instanceof Error ? error.message : String(error);
		} finally {
			isConnecting = false;
		}
	}

	async function submit() {
		if (!ref.trim() || deploymentsStore.isDeploying) return;
		failure = null;
		try {
			await deploymentsStore.deploy(ref.trim(), production);
			onClose();
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
	}
</script>

	<div class="flex flex-col gap-4">
		<p class="text-sm text-slate-600 dark:text-slate-400 m-0">
			{#if info?.gitRepo}
				Builds <span class="font-mono text-slate-800 dark:text-slate-200">{info.gitRepo}</span> at
				the branch you name.
			{:else}
				Builds from the repository this deploy target is connected to.
			{/if}
		</p>

		{#if loading}
			<!--
				A shaped skeleton, not a bare spinner. This dialog asks the
				provider three things before it can render, and on a slow
				connection a lone spinner in an empty box gives no clue whether
				anything is coming.
			-->
			<div class="flex flex-col gap-3" aria-busy="true">
				<div class="flex flex-col gap-1.5">
					<div class="w-12 h-3 rounded bg-slate-200 dark:bg-slate-800 animate-pulse"></div>
					<div class="w-full h-9 rounded-md bg-slate-200 dark:bg-slate-800 animate-pulse"></div>
				</div>
				<div class="flex items-start gap-2.5">
					<div class="w-3.5 h-3.5 mt-0.5 rounded bg-slate-200 dark:bg-slate-800 animate-pulse"></div>
					<div class="flex flex-col gap-1 flex-1">
						<div class="w-40 h-3 rounded bg-slate-200 dark:bg-slate-800 animate-pulse"></div>
						<div class="w-full h-3 rounded bg-slate-200 dark:bg-slate-800 animate-pulse"></div>
					</div>
				</div>
				<p class="flex items-center gap-2 m-0 text-[11px] text-slate-500 dark:text-slate-500">
					<Icon name="lucide:loader-circle" class="w-3 h-3 animate-spin" />
					Checking what this target can build…
				</p>
			</div>
		{:else if info && !info.canDeploy}
			<div class="flex flex-col gap-3">
				<p
					class="flex items-start gap-2 px-3 py-2.5 m-0 rounded-lg text-xs leading-relaxed
						{isBlocked
						? 'bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300'
						: 'bg-amber-500/10 text-amber-800 dark:text-amber-300'}"
				>
					<Icon name="lucide:circle-alert" class="w-3.5 h-3.5 shrink-0 mt-px" />
					<span>
						{#if isBlocked || connectState === 'unknown'}
							{info.connectHint}
						{:else if needsRepo}
							This deploy target has no repository attached, so there is nothing to build from
							yet. Connect this project's own repository and it can be deployed from here — and
							from every push after that.
						{:else}
							{info.reason}
						{/if}
					</span>
				</p>

				{#if needsRepo && providerCanConnect}
					<div class="flex items-center gap-2 px-3 py-2.5 bg-slate-100 dark:bg-slate-800/60 rounded-lg">
						<Icon name="lucide:git-branch" class="w-3.5 h-3.5 shrink-0 text-slate-500" />
						<span class="flex-1 min-w-0 font-mono text-xs text-slate-800 dark:text-slate-200 truncate">
							{info.suggestedRepo}
						</span>

						{#if isBlocked && info.connectUrl}
							<!--
								A link out, not a disabled button with a tooltip. The
								missing piece lives in the provider's account settings and
								cannot be supplied from here.
							-->
							<a
								href={info.connectUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-1.5 h-8 shrink-0 px-2.5 text-xs font-medium bg-transparent border border-slate-300 dark:border-slate-600 rounded-md text-slate-700 dark:text-slate-300 no-underline transition-colors duration-150 hover:border-violet-500/50"
							>
								<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
								Set it up
							</a>
						{:else}
							<Button size="sm" disabled={!canPressConnect || isConnecting} onclick={connect}>
								{isConnecting ? 'Connecting…' : 'Connect'}
							</Button>
						{/if}
					</div>

					<div class="flex items-center gap-2 flex-wrap">
						<p class="flex-1 min-w-0 m-0 text-[11px] text-slate-500 dark:text-slate-500">
							{#if isBlocked}
								Set that up and check again — no need to close this.
							{:else}
								Read from this project's git remote.
							{/if}
						</p>

						{#if connectState === 'unknown' && info.connectUrl}
							<!--
								Offered alongside Connect rather than instead of it. We do
								not know that the app is missing — only that we could not
								confirm it is there — so the button stays the first move and
								this is the fallback if it fails.
							-->
							<a
								href={info.connectUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="shrink-0 text-xs text-slate-500 dark:text-slate-500 underline underline-offset-2 hover:text-slate-700 dark:hover:text-slate-300"
							>
								Install the app
							</a>
						{/if}

						<button
							type="button"
							class="shrink-0 text-xs text-violet-600 dark:text-violet-400 bg-transparent border-none cursor-pointer underline underline-offset-2"
							onclick={recheck}
						>
							Check again
						</button>
					</div>
				{/if}
			</div>
		{:else}
			<label class="flex flex-col gap-1.5">
				<span class="text-xs font-medium text-slate-700 dark:text-slate-300">Branch</span>
				<input
					type="text"
					class="w-full h-9 px-2.5 font-mono text-xs bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
					placeholder="main"
					value={ref}
					oninput={(event) => {
						touchedRef = true;
						ref = event.currentTarget.value;
					}}
					onkeydown={(event) => {
						if (event.key === 'Enter') void submit();
					}}
				/>

				{#if suggestions.length > 1}
					<span class="flex items-center gap-1.5 flex-wrap">
						{#each suggestions as branch (branch)}
							<button
								type="button"
								class="h-6 px-2 font-mono text-[11px] rounded border cursor-pointer transition-colors duration-150
									{ref === branch
									? 'border-violet-500/50 bg-violet-500/10 text-violet-700 dark:text-violet-300'
									: 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-violet-500/40'}"
								onclick={() => {
									touchedRef = true;
									ref = branch;
								}}
							>
								{branch}
								{#if branch === info?.currentBranch}
									<span class="text-slate-400 dark:text-slate-600">· checked out</span>
								{/if}
							</button>
						{/each}
					</span>
				{/if}
			</label>

			<label class="flex items-start gap-2.5 cursor-pointer">
				<input
					type="checkbox"
					class="mt-0.5 w-3.5 h-3.5 accent-rose-600 cursor-pointer"
					checked={production}
					onchange={(event) => (production = event.currentTarget.checked)}
				/>
				<span class="flex flex-col gap-0.5">
					<span class="text-xs font-medium text-slate-700 dark:text-slate-300">
						Deploy to production
					</span>
					<span class="text-[11px] text-slate-500 dark:text-slate-500">
						Off by default. A production build replaces what is live once it finishes; leave this
						off and you get a preview URL instead.
					</span>
				</span>
			</label>
		{/if}

		{#if failure}
			<InlineError message={failure} onDismiss={() => (failure = null)} />
		{/if}

		<div class="flex justify-end gap-2 pt-1">
			<Button size="sm" variant="outline" onclick={onClose}>Cancel</Button>
			{#if info?.canDeploy}
				<Button
					size="sm"
					variant={production ? 'danger' : 'primary'}
					disabled={!ref.trim() || deploymentsStore.isDeploying}
					onclick={submit}
				>
					{deploymentsStore.isDeploying
						? 'Starting…'
						: production
							? 'Deploy to production'
							: 'Deploy preview'}
				</Button>
			{/if}
		</div>
	</div>
