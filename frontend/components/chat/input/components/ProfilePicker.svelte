<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { sessionState } from '$frontend/stores/core/sessions.svelte';
	import { userStore } from '$frontend/stores/features/user.svelte';
	import { chatModelState } from '$frontend/stores/ui/chat-model.svelte';
	import { profilesStore } from '$frontend/stores/features/profiles.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import ws from '$frontend/utils/ws';

	// Profiles are an optional feature — only surface the picker once at least one
	// profile exists, so instances that don't use them see no extra chrome.
	const available = $derived(profilesStore.available);
	const isAdmin = $derived(authStore.isAdmin);
	let projectDefaultId = $state<number | null>(null);

	// Once the session has any activity, the active profile is locked for the rest
	// of the session — mirrors the engine lock in EngineModelPicker. Switching
	// profiles mid-session can route to a different server, so we pin it after the
	// first message and keep it locked (not just while loading).
	const hasStartedChat = $derived(
		sessionState.messages.some(m => m.type === 'user') || sessionState.hasMessageHistory
	);

	let open = $state(false);
	let searchQuery = $state('');
	let triggerButton = $state<HTMLButtonElement | null>(null);
	let dropdownStyle = $state('');

	$effect(() => {
		void profilesStore.fetchAvailable();
	});
	$effect(() => {
		const projectId = projectState.currentProject?.id;
		untrack(() => {
			if (!projectId) { projectDefaultId = null; return; }
			void profilesStore.projectDefault(projectId).then(id => { projectDefaultId = id; });
		});
	});

	// Listen for remote profile changes from other collaborators in this session.
	$effect(() => {
		const unsub = ws.on('chat:profile-sync', (data: { senderId: string; profileId: number | null }) => {
			if (data.senderId === userStore.currentUser?.id) return;
			chatModelState.profileId = data.profileId;
			if (sessionState.currentSession) {
				sessionState.currentSession = { ...sessionState.currentSession, profile_id: data.profileId };
			}
		});
		return () => unsub();
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

	function positionDropdown() {
		if (!triggerButton) return;
		const rect = triggerButton.getBoundingClientRect();
		const bottom = window.innerHeight - rect.top + 6;
		dropdownStyle = `position: fixed; left: ${rect.left}px; bottom: ${bottom}px; z-index: 9999;`;
	}

	function toggle() {
		if (!open) { positionDropdown(); searchQuery = ''; }
		open = !open;
	}
	function close() { open = false; }

	function select(profileId: number | null) {
		chatModelState.profileId = profileId;
		const chatSessionId = sessionState.currentSession?.id;
		if (chatSessionId) {
			ws.emit('chat:profile-sync', {
				senderId: userStore.currentUser?.id || '',
				chatSessionId,
				profileId
			});
		}
		close();
	}

	// Admin: pin/unpin a profile as the shared project default (single-select).
	async function togglePin(profileId: number, event: MouseEvent) {
		event.stopPropagation();
		const projectId = projectState.currentProject?.id;
		if (!projectId) return;
		const next = projectDefaultId === profileId ? null : profileId;
		await profilesStore.setProjectDefault(projectId, next);
		projectDefaultId = next;
	}
</script>

{#if available.length > 0}
	<button
		bind:this={triggerButton}
		type="button"
		class="flex items-center gap-1.5 px-2 py-1 text-xs rounded-lg transition-all duration-150
			bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700
			text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700
			disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-slate-100 dark:disabled:hover:bg-slate-800"
		onclick={toggle}
		disabled={hasStartedChat}
		title={hasStartedChat ? 'Profile is locked for this session' : 'Active profile for this session'}
	>
		<Icon name="lucide:layers" class="w-3.5 h-3.5" />
		<span class="font-medium max-w-32 truncate">{triggerLabel}</span>
		<Icon name={hasStartedChat ? 'lucide:lock' : 'lucide:chevron-down'} class="w-3 h-3" />
	</button>

	{#if open}
		<div class="fixed inset-0" style="z-index: 9998;" onclick={close}></div>
		<div style={dropdownStyle} class="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden w-64 max-h-80 flex flex-col">
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

			<div class="overflow-y-auto py-1">
				<!-- None → fall back to the project default (or truly no profile). -->
				<button
					type="button"
					class="group flex items-center gap-2.5 w-full px-3 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-700/50"
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
						<button
							type="button"
							class="group flex items-start gap-2.5 w-full px-3 py-2 text-left transition-all duration-150
								{isSelected ? 'bg-violet-50 dark:bg-violet-900/20' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'}"
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
							{#if isAdmin && projectState.currentProject}
								<span role="button" tabindex="0"
									class="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded text-slate-400 hover:text-amber-500 hover:bg-amber-500/10 transition-colors cursor-pointer {isDefault ? '' : 'opacity-0 group-hover:opacity-100'}"
									onclick={(e) => togglePin(profile.id, e)}
									onkeydown={(e) => e.key === 'Enter' && togglePin(profile.id, e as unknown as MouseEvent)}
									title={isDefault ? 'Unpin as project default' : 'Pin as project default'}>
									<Icon name={isDefault ? 'lucide:pin-off' : 'lucide:pin'} class="w-3.5 h-3.5" />
								</span>
							{/if}
						</button>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
{/if}
