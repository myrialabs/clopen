<script lang="ts">
	/**
	 * Confirmation for anything that triggers a build or changes what is live.
	 *
	 * The spec's rule for this surface is that every such action is confirmed
	 * explicitly, and this is the one place that happens — the store's
	 * `runAction` does not ask, so anything wired straight to it would bypass
	 * the rule.
	 *
	 * The text names the CONSEQUENCE, not the verb. "Are you sure?" tells a
	 * reader nothing they did not know when they clicked; "this replaces what is
	 * live at acme.com" is the sentence that stops the wrong click. Production
	 * actions get the destructive styling, preview ones do not — a preview
	 * redeploy is a cheap, reversible thing and dressing it in red teaches
	 * people to ignore red.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import type { DeployAction, Deployment } from '$shared/types/deployments';

	interface Props {
		isOpen: boolean;
		action: DeployAction | null;
		deployment: Deployment | null;
		/** Hostnames this action would change, when it changes any. */
		aliases?: string[];
		onConfirm: () => void;
		onCancel: () => void;
	}

	let { isOpen = $bindable(), action, deployment, aliases = [], onConfirm, onCancel }: Props = $props();

	const isProduction = $derived(deployment?.environment === 'production');

	/** Actions that move traffic, as opposed to ones that only spend build time. */
	const movesTraffic = $derived(action === 'rollback' || action === 'promote');
	const isDestructive = $derived(
		movesTraffic || action === 'delete' || (action === 'redeploy' && isProduction)
	);

	const TITLES: Record<DeployAction, string> = {
		redeploy: 'Redeploy this build?',
		cancel: 'Cancel this build?',
		rollback: 'Roll production back to this build?',
		promote: 'Promote this build to production?',
		delete: 'Delete this deployment?'
	};

	const target = $derived(
		aliases.length > 0 ? aliases[0] : deployment?.url ?? 'this deployment'
	);

	const body = $derived.by(() => {
		if (!action || !deployment) return '';
		switch (action) {
			case 'redeploy':
				return isProduction
					? `This starts a new production build from the same commit. When it finishes it replaces what is live at ${target}.`
					: 'This starts a new preview build from the same commit. Nothing that is live changes.';
			case 'cancel':
				return 'This stops the build where it is. Anything already live is unaffected, and the build cannot be resumed — only started again.';
			case 'rollback':
				return `This points production traffic back at this build. Whatever is serving ${target} right now stops serving it.`;
			case 'promote':
				return `This makes this build the one serving production traffic at ${target}.`;
			case 'delete':
				// Worth spelling out: unlike every other action here, nothing about
				// this one can be undone or re-run.
				return `This removes the build, its logs and its URLs for good. It cannot be undone, and anything still linking to ${target} will stop resolving.`;
		}
	});
</script>

<Modal bind:isOpen onClose={onCancel} title={action ? TITLES[action] : ''} size="md">
	{#snippet children()}
		{#if action && deployment}
			<div class="flex flex-col gap-4">
				<div
					class="flex items-start gap-2.5 px-3 py-2.5 rounded-lg
						{isDestructive
						? 'bg-rose-500/10 text-rose-800 dark:text-rose-300'
						: 'bg-violet-500/10 text-violet-800 dark:text-violet-300'}"
				>
					<Icon
						name={isDestructive ? 'lucide:triangle-alert' : 'lucide:rocket'}
						class="w-4 h-4 shrink-0 mt-px"
					/>
					<p class="text-xs m-0 leading-relaxed">{body}</p>
				</div>

				<!--
					What is being acted on, spelled out. The list row was one of many
					and the user may have clicked the wrong one; this is the last
					moment that is cheap to notice.
				-->
				<dl class="flex flex-col gap-1.5 px-3 py-2.5 m-0 bg-slate-100 dark:bg-slate-800/60 rounded-lg text-xs">
					<div class="flex gap-2">
						<dt class="w-20 shrink-0 text-slate-500 dark:text-slate-500 m-0">Environment</dt>
						<dd class="m-0 text-slate-800 dark:text-slate-200 capitalize">{deployment.environment}</dd>
					</div>
					{#if deployment.branch}
						<div class="flex gap-2">
							<dt class="w-20 shrink-0 text-slate-500 dark:text-slate-500 m-0">Branch</dt>
							<dd class="m-0 text-slate-800 dark:text-slate-200 truncate">{deployment.branch}</dd>
						</div>
					{/if}
					{#if deployment.commitSha}
						<div class="flex gap-2">
							<dt class="w-20 shrink-0 text-slate-500 dark:text-slate-500 m-0">Commit</dt>
							<dd class="m-0 font-mono text-slate-800 dark:text-slate-200">{deployment.commitSha.slice(0, 8)}</dd>
						</div>
					{/if}
					{#if deployment.commitMessage}
						<div class="flex gap-2">
							<dt class="w-20 shrink-0 text-slate-500 dark:text-slate-500 m-0">Message</dt>
							<dd class="m-0 text-slate-800 dark:text-slate-200 truncate">{deployment.commitMessage.split('\n')[0]}</dd>
						</div>
					{/if}
				</dl>

				<div class="flex justify-end gap-2 pt-1">
					<Button size="sm" variant="outline" onclick={onCancel}>Keep as is</Button>
					<Button size="sm" variant={isDestructive ? 'danger' : 'primary'} onclick={onConfirm}>
						{action === 'cancel' ? 'Cancel the build' : TITLES[action].replace(/\?$/, '')}
					</Button>
				</div>
			</div>
		{/if}
	{/snippet}
</Modal>
