<script lang="ts">
	/**
	 * One deployment: what it is, where it is reachable, and what can be done to it.
	 *
	 * Every action that triggers a build or moves traffic goes through the
	 * confirm dialog — none of them calls the store directly. Each is also gated
	 * by its capability flag rather than by a try-and-see, because the panel
	 * renders its controls before any call is made and a button that 404s on
	 * five of seven providers is worse than one that is absent.
	 *
	 * THE LOG OPENS ITSELF, for every state. It was behind a "Show the build log"
	 * button on the theory that a successful build's log is mostly dependency
	 * installation and not worth a request — but the log is the substance of this
	 * pane, and everything above it fits in a few lines. Hiding the only thing
	 * worth reading behind a click to save one request was the wrong trade.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import StateBadge from './StateBadge.svelte';
	import BuildLogView from './BuildLogView.svelte';
	import DomainList from './DomainList.svelte';
	import ActionButton from './ActionButton.svelte';
	import ConfirmActionDialog from './ConfirmActionDialog.svelte';
	import { deploymentsStore } from '$frontend/stores/features/deployments.svelte';
	import { copyText } from '$frontend/utils/clipboard';
	import { showInfo } from '$frontend/stores/ui/notification.svelte';
	import { relativeTime } from '$frontend/utils/relative-time';
	import type { DeployAction } from '$shared/types/deployments';
	import type { IconName } from '$shared/types/ui/icons';

	const detail = $derived(deploymentsStore.detail);
	const source = $derived(deploymentsStore.source);
	const capabilities = $derived(source?.capabilities ?? null);
	const busy = $derived(deploymentsStore.busyAction);

	let pendingAction = $state<DeployAction | null>(null);
	let confirmOpen = $state(false);

	const isLive = $derived(detail?.state === 'queued' || detail?.state === 'building');
	const failed = $derived(detail?.state === 'error');

	/** The address a reader would actually visit — the adapter orders these. */
	const primaryUrl = $derived(detail ? (detail.aliases[0] ?? detail.url) : null);

	/**
	 * Open the log for every deployment, streaming it when the build is running.
	 *
	 * The effect re-runs when the open deployment changes; both calls guard
	 * against repeating themselves.
	 */
	$effect(() => {
		const current = detail;
		if (!current || !capabilities?.logs) return;

		if (isLive && capabilities.streamLogs) void deploymentsStore.startFollowing();
		else if (!deploymentsStore.logs) void deploymentsStore.loadLogs();
	});

	function ask(action: DeployAction) {
		pendingAction = action;
		confirmOpen = true;
	}

	function confirm() {
		const action = pendingAction;
		confirmOpen = false;
		pendingAction = null;
		if (action && detail) void deploymentsStore.runAction(action, detail.id);
	}

	async function copyValue(value: string, what: string) {
		const ok = await copyText(value);
		showInfo(ok ? 'Copied' : 'Could not copy', ok ? `${what} copied.` : 'The clipboard refused the request.');
	}

	const logText = $derived(
		deploymentsStore.isStreaming ? deploymentsStore.streamText : (deploymentsStore.logs?.text ?? '')
	);

	/**
	 * Whether this build can be rolled back to.
	 *
	 * `isRollbackCandidate` is trusted when the provider states it. When it says
	 * NOTHING the action falls back to what is knowable — a ready production
	 * build that is not the live one — rather than being hidden, which is what
	 * the earlier `=== true` check did to every listing that omitted the field.
	 */
	const canRollBackToThis = $derived.by(() => {
		if (!detail || detail.isCurrent) return false;
		if (detail.isRollbackCandidate !== null) return detail.isRollbackCandidate;
		return detail.state === 'ready' && detail.environment === 'production';
	});

	/** Every action that is both supported here and sensible for this build. */
	const actions = $derived.by(() => {
		if (!detail || !capabilities) return [];
		const list: { id: DeployAction; label: string; icon: IconName; danger: boolean }[] = [];

		if (capabilities.cancel && isLive) {
			list.push({ id: 'cancel', label: 'Cancel build', icon: 'lucide:ban', danger: true });
		}
		if (capabilities.redeploy && !isLive) {
			list.push({ id: 'redeploy', label: 'Redeploy', icon: 'lucide:refresh-cw', danger: false });
		}
		if (capabilities.rollback && canRollBackToThis) {
			list.push({ id: 'rollback', label: 'Roll back to this', icon: 'lucide:undo-2', danger: true });
		}
		if (capabilities.promote && detail.state === 'ready' && !detail.isCurrent) {
			list.push({ id: 'promote', label: 'Promote to production', icon: 'lucide:arrow-up-from-line', danger: true });
		}
		// Never for what is serving production: the provider refuses it, and
		// offering a button whose only outcome is that refusal is noise.
		if (capabilities.deleteDeployment && !isLive && !detail.isCurrent) {
			list.push({ id: 'delete', label: 'Delete', icon: 'lucide:trash-2', danger: true });
		}
		return list;
	});
</script>

{#if deploymentsStore.isLoadingDetail && !detail}
	<div class="flex items-center justify-center flex-1">
		<Icon name="lucide:loader-circle" class="w-5 h-5 text-slate-400 animate-spin" />
	</div>
{:else if !detail}
	<div class="flex flex-col items-center justify-center gap-2 flex-1 px-8 text-center">
		<Icon name="lucide:mouse-pointer-click" class="w-8 h-8 text-slate-300 dark:text-slate-700" />
		<p class="text-sm text-slate-600 dark:text-slate-400 m-0">Pick a deployment to see its build.</p>
	</div>
{:else}
	<div class="flex flex-col min-h-0 flex-1">
		<div class="flex flex-col gap-3 px-4 py-3 shrink-0 border-b border-slate-200 dark:border-slate-800">
			<div class="flex items-center gap-2 flex-wrap">
				<StateBadge state={detail.state} detail={detail.stateDetail} />
				<span class="text-xs text-slate-500 dark:text-slate-500 capitalize">{detail.environment}</span>
				{#if detail.isCurrent}
					<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
						Live
					</span>
				{/if}
				{#if detail.source}
					<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
						{detail.source}
					</span>
				{/if}

				<div class="flex items-center gap-1 ml-auto shrink-0">
					{#if primaryUrl}
						<a
							href="https://{primaryUrl}"
							target="_blank"
							rel="noopener noreferrer"
							class="inline-flex items-center gap-1.5 h-8 px-2.5 text-xs font-medium bg-violet-600 hover:bg-violet-700 border-none rounded-md text-white no-underline transition-colors duration-150"
						>
							<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
							Open site
						</a>
						<button
							type="button"
							class="inline-flex items-center justify-center w-8 h-8 bg-transparent border border-slate-300 dark:border-slate-600 rounded-md text-slate-500 cursor-pointer transition-colors duration-150 hover:border-violet-500/50"
							onclick={() => copyValue(`https://${primaryUrl}`, 'Deployment URL')}
							aria-label="Copy the deployment URL"
							title="Copy URL"
						>
							<Icon name="lucide:link" class="w-3.5 h-3.5" />
						</button>
					{/if}
					{#if detail.inspectorUrl}
						<a
							href={detail.inspectorUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="inline-flex items-center justify-center w-8 h-8 bg-transparent border border-slate-300 dark:border-slate-600 rounded-md text-slate-500 no-underline transition-colors duration-150 hover:border-violet-500/50"
							aria-label="Open the build page at the provider"
							title="Build page"
						>
							<Icon name="lucide:square-arrow-out-up-right" class="w-3.5 h-3.5" />
						</a>
					{/if}
				</div>
			</div>

			<h3 class="text-base font-semibold text-slate-900 dark:text-slate-100 m-0 truncate">
				{detail.commitMessage?.split('\n')[0] || detail.branch || detail.name}
			</h3>

			<!--
				Facts and domains SIDE BY SIDE. Stacked, the facts used half the
				width and left the other half blank while pushing the log down —
				and the log is what the pane is for.
			-->
			<div class="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-3">
				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 m-0 text-xs items-baseline">
					{#if detail.branch}
						<dt class="text-slate-500 dark:text-slate-500 m-0">Branch</dt>
						<dd class="m-0 text-slate-800 dark:text-slate-200 truncate">{detail.branch}</dd>
					{/if}
					{#if detail.commitSha}
						<dt class="text-slate-500 dark:text-slate-500 m-0">Commit</dt>
						<dd class="m-0 flex items-center gap-1 min-w-0">
							<span class="font-mono text-slate-800 dark:text-slate-200">{detail.commitSha.slice(0, 8)}</span>
							<button
								type="button"
								class="shrink-0 bg-transparent border-none p-0 text-slate-400 dark:text-slate-600 cursor-pointer hover:text-slate-700 dark:hover:text-slate-200"
								onclick={() => copyValue(detail.commitSha ?? '', 'Commit')}
								aria-label="Copy the commit sha"
							>
								<Icon name="lucide:copy" class="w-3 h-3" />
							</button>
						</dd>
					{/if}
					<dt class="text-slate-500 dark:text-slate-500 m-0">Created</dt>
					<dd class="m-0 text-slate-800 dark:text-slate-200">{relativeTime(detail.createdAt)}</dd>
					{#if detail.durationMs !== null}
						<dt class="text-slate-500 dark:text-slate-500 m-0">Built in</dt>
						<dd class="m-0 text-slate-800 dark:text-slate-200">{Math.round(detail.durationMs / 1000)}s</dd>
					{/if}
					{#if detail.creator}
						<dt class="text-slate-500 dark:text-slate-500 m-0">By</dt>
						<dd class="m-0 text-slate-800 dark:text-slate-200 truncate">{detail.creator}</dd>
					{/if}
					{#if detail.framework}
						<dt class="text-slate-500 dark:text-slate-500 m-0">Framework</dt>
						<dd class="m-0 text-slate-800 dark:text-slate-200 truncate">{detail.framework}</dd>
					{/if}
				</dl>

				{#if detail.aliases.length > 0}
					<div class="flex flex-col gap-1 min-w-0">
						<span class="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-600">
							Domains
						</span>
						<DomainList domains={detail.aliases} branch={detail.branch} />
					</div>
				{/if}
			</div>

			{#if detail.errorCode || detail.errorMessage}
				<p class="flex items-start gap-2 px-2.5 py-2 m-0 bg-rose-500/10 rounded-md text-xs text-rose-700 dark:text-rose-300">
					<Icon name="lucide:circle-alert" class="w-3.5 h-3.5 shrink-0 mt-px" />
					<span>{detail.errorCode ? `${detail.errorCode}: ` : ''}{detail.errorMessage ?? 'The build failed.'}</span>
				</p>
			{/if}

			<div class="flex flex-wrap items-center gap-1.5">
				{#if failed && capabilities?.logs}
					<ActionButton
						label="Send log to chat"
						icon="lucide:message-square-code"
						busy={deploymentsStore.isSendingLogs}
						disabled={busy !== null}
						onclick={() => deploymentsStore.sendLogsToChat(detail.id)}
					/>
				{/if}

				{#each actions as action (action.id)}
					<ActionButton
						label={action.label}
						icon={action.icon}
						danger={action.danger}
						busy={busy === action.id}
						disabled={busy !== null && busy !== action.id}
						onclick={() => ask(action.id)}
					/>
				{/each}
			</div>
		</div>

		{#if capabilities?.logs}
			<!--
				No wrapper, no inset panel. The log IS the rest of the pane, and
				boxing it inside a bordered card cost padding on four sides and made
				a short log look like an empty container someone forgot to fill.
			-->
			<BuildLogView
				text={logText}
				isLoading={deploymentsStore.isLoadingLogs}
				isStreaming={deploymentsStore.isStreaming}
				phase={deploymentsStore.streamPhase}
				truncated={deploymentsStore.logs?.truncated ?? false}
			/>
		{/if}
	</div>

	<ConfirmActionDialog
		bind:isOpen={confirmOpen}
		action={pendingAction}
		deployment={detail}
		aliases={detail.aliases}
		onConfirm={confirm}
		onCancel={() => {
			confirmOpen = false;
			pendingAction = null;
		}}
	/>
{/if}
