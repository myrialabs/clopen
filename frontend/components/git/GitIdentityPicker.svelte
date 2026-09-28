<script lang="ts">
	/**
	 * The per-project account override, next to the commit box.
	 *
	 * A dropdown rather than a link into Settings: the choice is scoped to THIS
	 * project and overrides the default, so sending the user to the screen that
	 * owns the default would have them change the wrong thing. Settings stays one
	 * click away for editing an account or adding one.
	 *
	 * "Use default" is a real option, not the absence of one — clearing the
	 * override is how a project goes back to following the default, and it has to
	 * be reachable after an override has been set.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { gitIdentityStore } from '$frontend/stores/features/git-identity.svelte';
	import { openSettingsModal } from '$frontend/stores/ui/settings-modal.svelte';
	import { debug } from '$shared/utils/logger';
	import type { ResolvedGitIdentity } from '$shared/types/git-identity';

	interface Props {
		projectId: string;
		resolved: ResolvedGitIdentity;
	}
	const { projectId, resolved }: Props = $props();

	let open = $state(false);
	let busy = $state(false);
	let anchorEl = $state<HTMLElement | null>(null);

	const identities = $derived(gitIdentityStore.identities);
	const defaultIdentity = $derived(gitIdentityStore.defaultIdentity);
	/** Empty string = following the default, which is what the radio compares against. */
	const selectedId = $derived(resolved.source === 'project' ? (resolved.identity?.id ?? '') : '');

	async function choose(identityId: string | null) {
		busy = true;
		try {
			await gitIdentityStore.bind(projectId, identityId);
			open = false;
		} catch (error) {
			debug.error('git', 'Changing this project\'s git account failed:', error);
		} finally {
			busy = false;
		}
	}

	function toggle() {
		// The list is only needed once the menu is opened, so it is fetched here
		// rather than on every mount of the commit form.
		if (!open) void gitIdentityStore.refresh();
		open = !open;
	}

	/** Close on an outside click, the way the other panel menus behave. */
	$effect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			if (anchorEl && !anchorEl.contains(event.target as Node)) open = false;
		};
		const onKeydown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') open = false;
		};
		document.addEventListener('pointerdown', onPointerDown, true);
		document.addEventListener('keydown', onKeydown);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown, true);
			document.removeEventListener('keydown', onKeydown);
		};
	});
</script>

<div class="relative min-w-0" bind:this={anchorEl}>
	<button
		type="button"
		class="flex items-center gap-1.5 px-0.5 text-[11px] text-slate-500 dark:text-slate-400 min-w-0 max-w-full hover:text-violet-600 dark:hover:text-violet-400 transition-colors text-left"
		title="Git account used for this project"
		onclick={toggle}
	>
		<Icon name="lucide:user-round-cog" class="w-3 h-3 shrink-0" />
		<span class="truncate">
			{resolved.identity?.name} &lt;{resolved.identity?.email}&gt;
		</span>
		{#if resolved.source === 'user-default'}
			<span class="shrink-0 text-slate-400 dark:text-slate-500" title="Following the default account">
				· default
			</span>
		{/if}
		{#if resolved.credentialIdentity}
			<span
				class="shrink-0 text-amber-600 dark:text-amber-400"
				title={`Pushing uses the credential from "${resolved.credentialIdentity.label}"`}
			>
				· push as {resolved.credentialIdentity.label}
			</span>
		{/if}
		<Icon name="lucide:chevron-down" class="w-3 h-3 shrink-0" />
	</button>

	{#if open}
		<div
			class="absolute top-full left-0 mt-1 z-50 w-64 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg py-1"
		>
			<p class="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">
				Account for this project
			</p>

			<button
				type="button"
				class="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-start gap-2 disabled:opacity-50"
				disabled={busy}
				onclick={() => choose(null)}
			>
				<Icon
					name={selectedId === '' ? 'lucide:check' : 'lucide:minus'}
					class="w-3.5 h-3.5 mt-0.5 shrink-0 {selectedId === '' ? 'text-violet-600' : 'text-transparent'}"
				/>
				<span class="min-w-0">
					<span class="block text-xs font-semibold text-slate-900 dark:text-slate-100">
						Use default
					</span>
					<span class="block text-[11px] text-slate-500 dark:text-slate-400 truncate">
						{defaultIdentity ? defaultIdentity.label : 'None set'}
					</span>
				</span>
			</button>

			{#each identities as identity (identity.id)}
				<button
					type="button"
					class="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-start gap-2 disabled:opacity-50"
					disabled={busy}
					onclick={() => choose(identity.id)}
				>
					<Icon
						name="lucide:check"
						class="w-3.5 h-3.5 mt-0.5 shrink-0 {selectedId === identity.id
							? 'text-violet-600'
							: 'text-transparent'}"
					/>
					<span class="min-w-0">
						<span class="block text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
							{identity.label}
						</span>
						<span class="block text-[11px] text-slate-500 dark:text-slate-400 truncate">
							{identity.email}
						</span>
					</span>
				</button>
			{/each}

			<div class="border-t border-slate-200 dark:border-slate-700 mt-1 pt-1">
				<button
					type="button"
					class="w-full text-left px-3 py-1.5 text-[11px] text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400"
					onclick={() => {
						open = false;
						openSettingsModal('git-identities');
					}}
				>
					Manage accounts…
				</button>
			</div>
		</div>
	{/if}
</div>
