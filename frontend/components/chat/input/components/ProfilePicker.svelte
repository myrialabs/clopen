<script lang="ts">
	import { untrack } from 'svelte';
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { appState } from '$frontend/stores/core/app.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { sessionState } from '$frontend/stores/core/sessions.svelte';
	import { userStore } from '$frontend/stores/features/user.svelte';
	import { chatModelState, patchCurrentSessionSelection } from '$frontend/stores/ui/chat-model.svelte';
	import { profilesStore } from '$frontend/stores/features/profiles.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import ws from '$frontend/utils/ws';
	import { CLIENT_ID } from '$frontend/utils/client-id';
	import { anchoredPopover } from '$frontend/utils/anchored-popover';
	import { debug } from '$shared/utils/logger';

	// Profiles are an optional feature — only surface the picker once at least one
	// profile exists, so instances that don't use them see no extra chrome.
	const available = $derived(profilesStore.available);
	const isAdmin = $derived(authStore.isAdmin);
	let projectDefaultId = $state<number | null>(null);

	// The profile is switchable at any point in a session. The backend resolves
	// the effective profile per stream (`resolveActiveProfileId`, called at
	// stream start), so a mid-session change simply scopes the next turn's
	// artifacts and MCP servers — there is no engine state to invalidate and
	// nothing to carry over. Only an in-flight stream blocks the picker.
	let open = $state(false);
	let searchQuery = $state('');
	let triggerButton = $state<HTMLButtonElement | null>(null);

	/**
	 * A picked profile that has since been deleted must not keep riding along
	 * with every turn as a dangling id — fall back to the project default
	 * (null). Local only: this is a correction, not a user pick, so it is not
	 * broadcast (each client corrects itself the same way).
	 */
	function dropStaleProfile(list: { id: number }[]) {
		const current = chatModelState.profileId;
		if (current === null || list.some(p => p.id === current)) return;
		debug.log('chat', `Selected profile ${current} no longer exists — falling back to project default`);
		chatModelState.profileId = null;
	}

	$effect(() => {
		void profilesStore.fetchAvailable().then(list => untrack(() => dropStaleProfile(list)));
	});
	// Re-check whenever the list or the selection changes (e.g. a profile is
	// deleted in Settings, or a session restores an id that is gone). An empty
	// list may simply not be loaded yet — the fetch above covers that case.
	$effect(() => {
		const list = available;
		void chatModelState.profileId;
		if (list.length === 0) return;
		untrack(() => dropStaleProfile(list));
	});

	// Project-default lookup. Guarded by a request token: on a fast project
	// switch an older response can land after a newer one and would otherwise
	// show project A's default while on project B.
	let defaultRequest = 0;
	$effect(() => {
		const projectId = projectState.currentProject?.id;
		untrack(() => {
			const request = ++defaultRequest;
			if (!projectId) { projectDefaultId = null; return; }
			void profilesStore.projectDefault(projectId).then(id => {
				if (request === defaultRequest) projectDefaultId = id;
			});
		});
	});

	// Listen for remote profile changes from collaborators (and this user's
	// other tabs/devices) in this session.
	$effect(() => {
		const unsub = ws.on('chat:profile-sync', (data: { senderId: string; clientId?: string; chatSessionId: string; profileId: number | null }) => {
			if (data.clientId ? data.clientId === CLIENT_ID : data.senderId === userStore.currentUser?.id) return;
			// Drop events for a session this tab has already switched away from.
			if (data.chatSessionId !== sessionState.currentSession?.id) return;
			chatModelState.profileId = data.profileId;
			patchCurrentSessionSelection({ profile_id: data.profileId });
		});
		return () => unsub();
	});

	// A stream starting closes the dropdown — no mid-turn picks.
	$effect(() => {
		if (appState.isLoading) untrack(() => close());
	});

	const selectedProfile = $derived(available.find(p => p.id === chatModelState.profileId) ?? null);
	const defaultProfile = $derived(
		projectDefaultId != null ? available.find(p => p.id === projectDefaultId) ?? null : null
	);

	const triggerLabel = $derived.by(() => {
		if (selectedProfile) return selectedProfile.name;
		if (defaultProfile) return `Default · ${defaultProfile.name}`;
		return 'No profile';
	});

	const filtered = $derived.by(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return available;
		return available.filter(p => `${p.name} ${p.description}`.toLowerCase().includes(q));
	});

	function toggle() {
		if (!open) searchQuery = '';
		open = !open;
	}
	function close() { open = false; }

	function select(profileId: number | null) {
		chatModelState.profileId = profileId;
		// Keep the session object truthful so code reading profile_id from it
		// (and the picker's init) sees this pick.
		patchCurrentSessionSelection({ profile_id: profileId });
		const chatSessionId = sessionState.currentSession?.id;
		if (chatSessionId) {
			ws.emit('chat:profile-sync', {
				senderId: userStore.currentUser?.id || '',
				clientId: CLIENT_ID,
				chatSessionId,
				profileId
			});
		}
		close();
	}

	// Admin: pin/unpin a profile as the shared project default (single-select).
	async function togglePin(profileId: number) {
		const projectId = projectState.currentProject?.id;
		if (!projectId) return;
		const next = projectDefaultId === profileId ? null : profileId;
		await profilesStore.setProjectDefault(projectId, next);
		// The project may have changed while the request was in flight.
		if (projectState.currentProject?.id === projectId) projectDefaultId = next;
	}
</script>

{#if available.length > 0}
	<button
		bind:this={triggerButton}
		type="button"
		class="flex items-center gap-1.5 px-2 py-1 pointer-coarse:min-h-8 text-xs rounded-lg transition-all duration-150
			bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700
			text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700
			disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-slate-100 dark:disabled:hover:bg-slate-800"
		onclick={toggle}
		disabled={appState.isLoading}
		title="Active profile for this session"
		aria-haspopup="listbox"
		aria-expanded={open}
	>
		<Icon name="lucide:layers" class="w-3.5 h-3.5" />
		<span class="font-medium max-w-32 truncate">{triggerLabel}</span>
		<Icon name="lucide:chevron-down" class="w-3 h-3" />
	</button>

	{#if open}
		<div class="fixed inset-0" style="z-index: 9998;" onclick={close}></div>
		<div
			use:anchoredPopover={{ anchor: triggerButton, onClose: close, maxHeight: 320, gap: 6 }}
			style="position: fixed; z-index: 9999;"
			class="origin-bottom-left bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden w-64 max-w-[calc(100vw-1rem)] flex flex-col"
			transition:scale={{ duration: 130, easing: cubicOut, start: 0.95, opacity: 0 }}
		>
			<!-- Search (matches the model dropdown) -->
			<div class="px-2 py-2 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
				<div class="relative">
					<Icon name="lucide:search" class="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
					<input
						type="text"
						bind:value={searchQuery}
						placeholder="Search profiles..."
						class="w-full pl-6 pr-2 py-1 text-xs bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 rounded-md outline-none focus:ring-1 focus:ring-violet-500/40 focus:border-violet-500 transition-colors text-slate-800 dark:text-slate-200 placeholder-slate-400"
					/>
				</div>
			</div>

			<div class="overflow-y-auto py-1" role="listbox" aria-label="Profiles">
				<!-- None → fall back to the project default (or truly no profile). -->
				<button
					type="button"
					role="option"
					aria-selected={chatModelState.profileId === null}
					data-popover-item
					class="flex items-center gap-2.5 w-full px-3 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-700/50 focus-visible:outline-none focus-visible:bg-slate-100 dark:focus-visible:bg-slate-700"
					onclick={() => select(null)}
				>
					<div class="flex-shrink-0 w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center
						{chatModelState.profileId === null ? 'border-violet-600' : 'border-slate-300 dark:border-slate-600'}">
						{#if chatModelState.profileId === null}<div class="w-1.5 h-1.5 rounded-full bg-violet-600"></div>{/if}
					</div>
					<span class="text-xs text-slate-700 dark:text-slate-300">
						{defaultProfile ? `Project default (${defaultProfile.name})` : 'No profile'}
					</span>
				</button>

				{#if filtered.length === 0}
					<p class="px-3 py-3 text-xs text-slate-500 text-center">No profile matches.</p>
				{:else}
					{#each filtered as profile (profile.id)}
						{@const isSelected = chatModelState.profileId === profile.id}
						{@const isDefault = projectDefaultId === profile.id}
						<!-- Row = select button + sibling pin button (a button can't nest
						     another interactive element). -->
						<div class="group flex items-stretch transition-all duration-150
							{isSelected ? 'bg-violet-50 dark:bg-violet-900/20' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'}">
							<button
								type="button"
								role="option"
								aria-selected={isSelected}
								data-popover-item
								class="flex items-start gap-2.5 flex-1 min-w-0 pl-3 py-2 text-left focus-visible:outline-none focus-visible:bg-slate-100 dark:focus-visible:bg-slate-700
									{isAdmin && projectState.currentProject ? 'pr-1' : 'pr-3'}"
								onclick={() => select(profile.id)}
							>
								<div class="flex-shrink-0 w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center mt-0.5
									{isSelected ? 'border-violet-600' : 'border-slate-300 dark:border-slate-600'}">
									{#if isSelected}<div class="w-1.5 h-1.5 rounded-full bg-violet-600"></div>{/if}
								</div>
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-1.5">
										<span class="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">{profile.name}</span>
										{#if isDefault}<Icon name="lucide:pin" class="w-3 h-3 text-amber-500 flex-shrink-0" />{/if}
									</div>
									{#if profile.description}
										<div class="text-3xs text-slate-400 dark:text-slate-500 truncate">{profile.description}</div>
									{/if}
								</div>
							</button>
							{#if isAdmin && projectState.currentProject}
								<!-- Always visible on touch (no hover there), with a full-size
								     tap target so it can't be hit by accident from the row. -->
								<button
									type="button"
									class="flex-shrink-0 self-center flex items-center justify-center w-6 h-6 pointer-coarse:w-9 pointer-coarse:h-9 mr-2 rounded text-slate-400 hover:text-amber-500 hover:bg-amber-500/10 focus-visible:opacity-100 transition-colors cursor-pointer
										{isDefault ? '' : 'opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100'}"
									onclick={() => togglePin(profile.id)}
									title={isDefault ? 'Unpin as project default' : 'Pin as project default'}
									aria-label={isDefault ? `Unpin ${profile.name} as project default` : `Pin ${profile.name} as project default`}
								>
									<Icon name={isDefault ? 'lucide:pin-off' : 'lucide:pin'} class="w-3.5 h-3.5" />
								</button>
							{/if}
						</div>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
{/if}
