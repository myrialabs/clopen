<script lang="ts">
	import { fly } from 'svelte/transition';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import {
		settingsModalState,
		closeSettingsModal,
		setActiveSection,
		settingsSections,
		settingsGroups,
		type SettingsSection
	} from '$frontend/stores/ui/settings-modal.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { systemSettings } from '$frontend/stores/features/settings.svelte';

	// Import settings components
	import AssistantSettings from './model/AssistantSettings.svelte';
	import GitSettings from './model/GitSettings.svelte';
	import ArtifactsSettings from './model/ArtifactsSettings.svelte';
	import AIEnginesSettings from './engines/AIEnginesSettings.svelte';
	import SystemToolsSettings from './system-tools/SystemToolsSettings.svelte';
	import McpSettings from './mcp/McpSettings.svelte';
	import SkillsSettings from './skills/SkillsSettings.svelte';
	import CommandsSettings from './commands/CommandsSettings.svelte';
	import SubagentsSettings from './subagents/SubagentsSettings.svelte';
	import InstructionsSettings from './instructions/InstructionsSettings.svelte';
	import PermissionsSettings from './permissions/PermissionsSettings.svelte';
	import ProfilesSettings from './profiles/ProfilesSettings.svelte';
	import AppearanceSettings from './appearance/AppearanceSettings.svelte';
	import AccountSettings from './account/AccountSettings.svelte';
	import NotificationSettings from './notifications/NotificationSettings.svelte';
	import TeamSettings from './admin/UserManagement.svelte';
	import InviteManagement from './admin/InviteManagement.svelte';
	import SecuritySettings from './security/SecuritySettings.svelte';
	import SystemSettings from './system/SystemSettings.svelte';
	import TunnelSettings from './tunnel/TunnelSettings.svelte';
	import RestartAllEnginesButton from './engines/RestartAllEnginesButton.svelte';
	import { mcpServersStore } from '$frontend/stores/features/mcp-servers.svelte';
	import { skillsStore } from '$frontend/stores/features/skills.svelte';
	import { commandsStore } from '$frontend/stores/features/commands.svelte';
	import { subagentsStore } from '$frontend/stores/features/subagents.svelte';
	import { instructionsStore } from '$frontend/stores/features/instructions.svelte';
	import { permissionsStore } from '$frontend/stores/features/permissions.svelte';

	// Responsive state
	let isMobileMenuOpen = $state(false);
	let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
	let searchQuery = $state('');
	let searchInputRef = $state<HTMLInputElement>();

	const isMobile = $derived(windowWidth < 768);
	const activeSection = $derived(settingsModalState.activeSection);
	const isAdmin = $derived(authStore.isAdmin);
	const isNoAuth = $derived(systemSettings.authMode === 'none');

	// Filter sections: hide admin-only tabs for non-admins. Team stays visible for
	// admins in both modes; the No Login case renders an informational notice
	// inside the section instead of hiding it.
	const visibleSections = $derived(
		settingsSections.filter(s => {
			if (s.adminOnly && !isAdmin) return false;
			return true;
		})
	);

	// Group visible sections under their group header for the sidebar. Empty
	// groups are dropped so a hidden admin group leaves no orphan header.
	const visibleGroups = $derived(
		settingsGroups
			.map(group => ({
				...group,
				sections: visibleSections.filter(s => s.group === group.id)
			}))
			.filter(g => g.sections.length > 0)
	);

	// Further filter groups by the sidebar search query, matching against
	// label and description. Empty groups after filtering are dropped.
	const filteredGroups = $derived.by(() => {
		const query = searchQuery.trim().toLowerCase();
		if (!query) return visibleGroups;
		return visibleGroups
			.map(group => ({
				...group,
				sections: group.sections.filter(
					s =>
						s.label.toLowerCase().includes(query) ||
						s.description.toLowerCase().includes(query)
				)
			}))
			.filter(g => g.sections.length > 0);
	});

	// Handle section change
	function handleSectionChange(section: SettingsSection) {
		setActiveSection(section);
		if (isMobile) {
			isMobileMenuOpen = false;
		}
	}

	// Auto-redirect when current section becomes hidden
	$effect(() => {
		const isVisible = visibleSections.some(s => s.id === activeSection);
		if (!isVisible && visibleSections.length > 0) {
			setActiveSection(visibleSections[0].id);
		}
	});

	// Focus the search input on open. Modal's own generic focus grabs the
	// first focusable element (the close button) after a 50ms delay, so this
	// runs slightly later to win the race. Skipped on mobile since the search
	// field sits off-canvas until the menu is opened.
	$effect(() => {
		if (settingsModalState.isOpen && !isMobile) {
			setTimeout(() => searchInputRef?.focus(), 60);
		}
	});

	// Get current section info
	const currentSectionInfo = $derived(
		settingsSections.find((s) => s.id === activeSection) || settingsSections[0]
	);

	// Update window width on resize
	function handleResize() {
		windowWidth = window.innerWidth;
		if (!isMobile) {
			isMobileMenuOpen = false;
		}
	}
</script>

<svelte:window on:resize={handleResize} />

<Modal
	isOpen={settingsModalState.isOpen}
	onClose={closeSettingsModal}
	bare
	mobileFullscreen
	ariaLabelledBy="settings-title"
	className="flex flex-col w-full max-w-225 h-[85dvh] max-h-175 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]"
>
	{#snippet children()}
		<!-- Mobile Header -->
		{#if isMobile}
			<header
				class="flex items-center justify-between py-3 px-4 bg-slate-100 dark:bg-slate-900/95 border-b border-slate-200 dark:border-slate-800"
			>
				<button
					type="button"
					class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={() => (isMobileMenuOpen = !isMobileMenuOpen)}
					aria-label="Toggle menu"
				>
					<Icon name={isMobileMenuOpen ? 'lucide:arrow-left' : 'lucide:menu'} class="w-5 h-5" />
				</button>
				<h2
					id="settings-title"
					class="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100 m-0"
				>
					<Icon name={currentSectionInfo.icon} class="w-5 h-5" />
					{currentSectionInfo.label}
				</h2>
				<button
					type="button"
					class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={closeSettingsModal}
					aria-label="Close settings"
				>
					<Icon name="lucide:x" class="w-5 h-5" />
				</button>
			</header>
		{/if}

		<div class="flex flex-1 min-h-0 relative">
			<!-- Sidebar -->
			<aside
				class="flex flex-col w-65 shrink-0 bg-white dark:bg-slate-900/98 border-r border-slate-200 dark:border-slate-800
					{isMobile
					? 'absolute left-0 top-0 bottom-0 z-10 w-70 shadow-[4px_0_20px_rgba(0,0,0,0.15)] dark:shadow-[4px_0_20px_rgba(0,0,0,0.3)] transition-transform duration-250 ease-out'
					: ''}
					{isMobile && !isMobileMenuOpen ? '-translate-x-full' : 'translate-x-0'}"
			>
				{#if !isMobile}
					<header
						class="flex items-center justify-between py-3 px-4 pl-6.5 border-b border-slate-200 dark:border-slate-800"
					>
						<div
							class="flex items-center gap-2.5 text-lg font-bold text-slate-900 dark:text-slate-100"
						>
							<span>Settings</span>
						</div>
						<button
							type="button"
							class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
							onclick={closeSettingsModal}
							aria-label="Close settings"
						>
							<Icon name="lucide:x" class="w-5 h-5" />
						</button>
					</header>
				{/if}

				<div class="p-3 pb-0">
					<div class="relative">
						<Icon
							name="lucide:search"
							class="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 dark:text-slate-500 pointer-events-none"
						/>
						<input
							type="text"
							placeholder="Search settings"
							bind:value={searchQuery}
							bind:this={searchInputRef}
							class="w-full py-2 pl-8.5 pr-3 bg-slate-100 dark:bg-slate-800/60 border border-transparent rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none transition-colors duration-150 focus:border-violet-500/40 focus:bg-white dark:focus:bg-slate-900"
						/>
					</div>
				</div>

				<nav class="flex-1 overflow-y-auto p-3">
					{#if filteredGroups.length === 0}
						<p class="px-3.5 py-3 text-sm text-slate-500 dark:text-slate-500">
							No settings match "{searchQuery}"
						</p>
					{/if}
					{#each filteredGroups as group (group.id)}
						<div class="mb-2">
							<h3 class="px-3.5 pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
								{group.label}
							</h3>
							{#each group.sections as section (section.id)}
								<button
									type="button"
									class="flex items-start gap-3 w-full py-3 px-3.5 bg-transparent border-none rounded-lg text-slate-500 text-sm text-left cursor-pointer transition-all duration-150 mb-1
										hover:bg-violet-500/10 hover:text-slate-600 dark:hover:text-slate-400
										{activeSection === section.id
										? 'bg-violet-500/10 dark:bg-violet-500/20 text-slate-900 dark:text-slate-100'
										: ''}"
									onclick={() => handleSectionChange(section.id)}
								>
									<Icon
										name={section.icon}
										class="w-5 h-5 shrink-0 mt-0.5 {activeSection === section.id
											? 'text-violet-600'
											: ''}"
									/>
									<div class="flex flex-col gap-0.5">
										<span class="font-semibold">{section.label}</span>
										<span
											class="text-xs text-slate-600 dark:text-slate-500 leading-tight {activeSection ===
											section.id
												? 'text-violet-600 dark:text-violet-400'
												: ''}">{section.description}</span
										>
									</div>
								</button>
							{/each}
						</div>
					{/each}
				</nav>
			</aside>

			<!-- Mobile Menu Overlay -->
			{#if isMobile && isMobileMenuOpen}
				<button
					type="button"
					class="absolute inset-0 z-[5] bg-black/40 border-none p-0 cursor-default"
					onclick={() => (isMobileMenuOpen = false)}
					aria-label="Close menu"
				></button>
			{/if}

			<!-- Content Area -->
			<main class="flex-1 flex flex-col min-w-0 overflow-hidden">
				<div class="flex-1 overflow-y-auto p-4 md:p-5">
					{#if activeSection === 'assistant'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<AssistantSettings />
						</div>
					{:else if activeSection === 'commit-message'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<GitSettings />
						</div>
					{:else if activeSection === 'artifacts'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<ArtifactsSettings />
						</div>
					{:else if activeSection === 'appearance'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<AppearanceSettings />
						</div>
					{:else if activeSection === 'notifications'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<NotificationSettings />
						</div>
					{:else if activeSection === 'tunnel' && isAdmin}
						<div in:fly={{ x: 20, duration: 200 }}>
							<TunnelSettings />
						</div>
					{:else if activeSection === 'account'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<AccountSettings />
						</div>
					{:else if activeSection === 'engines' && isAdmin}
						<div in:fly={{ x: 20, duration: 200 }}>
							<AIEnginesSettings />
						</div>
					{:else if activeSection === 'system-tools' && isAdmin}
						<div in:fly={{ x: 20, duration: 200 }}>
							<SystemToolsSettings />
						</div>
					{:else if activeSection === 'mcp' && isAdmin}
						<div in:fly={{ x: 20, duration: 200 }}>
							<McpSettings />
						</div>
					{:else if activeSection === 'skills' && isAdmin}
						<div in:fly={{ x: 20, duration: 200 }}>
							<SkillsSettings />
						</div>
					{:else if activeSection === 'commands' && isAdmin}
						<div in:fly={{ x: 20, duration: 200 }}>
							<CommandsSettings />
						</div>
					{:else if activeSection === 'subagents' && isAdmin}
						<div in:fly={{ x: 20, duration: 200 }}>
							<SubagentsSettings />
						</div>
					{:else if activeSection === 'instructions' && isAdmin}
						<div in:fly={{ x: 20, duration: 200 }}>
							<InstructionsSettings />
						</div>
					{:else if activeSection === 'permissions' && isAdmin}
						<div in:fly={{ x: 20, duration: 200 }}>
							<PermissionsSettings />
						</div>
					{:else if activeSection === 'profiles' && isAdmin}
						<div in:fly={{ x: 20, duration: 200 }}>
							<ProfilesSettings />
						</div>
					{:else if activeSection === 'team' && isAdmin}
						<div in:fly={{ x: 20, duration: 200 }}>
							{#if isNoAuth}
								<div class="py-1">
									<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Team</h3>
									<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">Manage team members and invites</p>
									<div class="flex items-start gap-3 p-4 bg-amber-500/5 dark:bg-amber-500/10 border border-amber-500/20 rounded-xl">
										<Icon name="lucide:info" class="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
										<div class="text-sm text-slate-700 dark:text-slate-300">
											<p class="font-semibold mb-1">Team management is only available in With Login mode</p>
											<p class="text-slate-600 dark:text-slate-400">
												The server is currently running in No Login mode, where a single anonymous user has full access. Switch the auth mode to With Login in
												<button type="button" class="text-violet-600 dark:text-violet-400 hover:underline cursor-pointer font-medium" onclick={() => setActiveSection('security')}>
													Settings &rarr; Security
												</button>
												to enable user invites, role assignment, and member removal.
											</p>
										</div>
									</div>
								</div>
							{:else}
								<TeamSettings />
								<div class="mt-6">
									<InviteManagement />
								</div>
							{/if}
						</div>
					{:else if activeSection === 'security' && isAdmin}
						<div in:fly={{ x: 20, duration: 200 }}>
							<SecuritySettings />
						</div>
					{:else if activeSection === 'system' && isAdmin}
						<div in:fly={{ x: 20, duration: 200 }}>
							<SystemSettings />
						</div>
					{/if}
				</div>

				<!-- Floating extensions restart banner (outside scroll area) -->
				{#if mcpServersStore.hasPendingChanges || skillsStore.hasPendingChanges || commandsStore.hasPendingChanges || subagentsStore.hasPendingChanges || instructionsStore.hasPendingChanges || permissionsStore.hasPendingChanges}
					<div class="shrink-0 flex items-center justify-between gap-3 p-3 mx-4 md:mx-5 mb-2 md:mb-3 bg-white/90 dark:bg-slate-950/90 backdrop-blur-sm border-t border-amber-500/20 -mt-1">
						<p class="text-xs text-slate-600 dark:text-slate-400">
							Changes apply after engines restart.
						</p>
						<RestartAllEnginesButton restartServerStyle onRestarted={() => { mcpServersStore.hasPendingChanges = false; skillsStore.hasPendingChanges = false; commandsStore.hasPendingChanges = false; subagentsStore.hasPendingChanges = false; instructionsStore.hasPendingChanges = false; permissionsStore.hasPendingChanges = false; }} />
					</div>
				{/if}
			</main>
		</div>
	{/snippet}
</Modal>
