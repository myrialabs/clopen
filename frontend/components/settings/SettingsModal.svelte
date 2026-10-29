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

	// Import settings components
	import AssistantSettings from './model/AssistantSettings.svelte';
	import GitSettings from './model/GitSettings.svelte';
	import ArtifactsSettings from './model/ArtifactsSettings.svelte';
	import AIEnginesSettings from './engines/AIEnginesSettings.svelte';
	import StackSettings from './stack/StackSettings.svelte';
	import IntegrationsSettings from './integrations/IntegrationsSettings.svelte';
	import SkillsSettings from './skills/SkillsSettings.svelte';
	import SubagentsSettings from './subagents/SubagentsSettings.svelte';
	import InstructionsSettings from './instructions/InstructionsSettings.svelte';
	import PermissionsSettings from './permissions/PermissionsSettings.svelte';
	import FileSharesSettings from './files/FileSharesSettings.svelte';
	import MemorySettings from './memory/MemorySettings.svelte';
	import MemoryModelSettings from './model/MemoryModelSettings.svelte';
	import ProfilesSettings from './profiles/ProfilesSettings.svelte';
	import GitIdentitiesSettings from './git/GitIdentitiesSettings.svelte';
	import AppearanceSettings from './appearance/AppearanceSettings.svelte';
	import NotificationSettings from './notifications/NotificationSettings.svelte';
	import ChatAppsSettings from './chat-apps/ChatAppsSettings.svelte';
	import AccessSettings from './access/AccessSettings.svelte';
	import FilesFoldersSettings from './files/FilesFoldersSettings.svelte';
	import SystemSettings from './system/SystemSettings.svelte';
	import AboutDeviceSettings, {
		prefetchDeviceInfo,
		prefetchProjectsOverview
	} from './system/AboutDeviceSettings.svelte';
	import TunnelSettings from './tunnel/TunnelSettings.svelte';
	import ScopedSection from './project/ScopedSection.svelte';
	import ProjectItemsPanel from './project/ProjectItemsPanel.svelte';
	import ProjectInstructionsPanel from './project/ProjectInstructionsPanel.svelte';
	import ProjectMcpPanel from './project/ProjectMcpPanel.svelte';
	import ProjectPermissionsPanel from './project/ProjectPermissionsPanel.svelte';

	// Responsive state
	let isMobileMenuOpen = $state(false);
	let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
	let searchQuery = $state('');
	let searchInputRef = $state<HTMLInputElement>();

	const isMobile = $derived(windowWidth < 768);
	const activeSection = $derived(settingsModalState.activeSection);

	// Group sections under their group header for the sidebar.
	const visibleGroups = settingsGroups
		.map(group => ({
			...group,
			sections: settingsSections.filter(s => s.group === group.id)
		}))
		.filter(g => g.sections.length > 0);

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

	// Focus the search input on open. Modal's own generic focus grabs the
	// first focusable element (the close button) after a 50ms delay, so this
	// runs slightly later to win the race. Skipped on mobile since the search
	// field sits off-canvas until the menu is opened.
	$effect(() => {
		if (settingsModalState.isOpen && !isMobile) {
			setTimeout(() => searchInputRef?.focus(), 60);
		}
	});

	// Prefetch Machine data the moment the modal opens so the slow
	// system:device-info probes and the projects:overview snapshot already run
	// in background while the user browses other tabs. Clicking Machine then
	// shows cached data instantly instead of a long skeleton like other tabs
	// that render from local stores.
	$effect(() => {
		if (settingsModalState.isOpen) {
			prefetchDeviceInfo();
			prefetchProjectsOverview();
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
							class="w-full py-2 pl-8.5 pr-3 bg-slate-100 dark:bg-slate-800/60 border border-transparent rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none transition-colors duration-150 focus:border-violet-500/40"
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
					{:else if activeSection === 'git-identities'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<GitIdentitiesSettings />
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
					{:else if activeSection === 'chat-apps'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<ChatAppsSettings />
						</div>
					{:else if activeSection === 'tunnel'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<TunnelSettings />
						</div>
					{:else if activeSection === 'engines'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<AIEnginesSettings />
						</div>
					{:else if activeSection === 'stack'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<StackSettings />
						</div>
					{:else if activeSection === 'integrations'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<ScopedSection
								title="Integrations"
								description="Connected services and MCP servers."
							>
								{#snippet global()}<IntegrationsSettings showHeader={false} />{/snippet}
								{#snippet project(projectId)}<ProjectMcpPanel {projectId} />{/snippet}
							</ScopedSection>
						</div>
					{:else if activeSection === 'skills'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<ScopedSection
								title="Skills"
								description="Reusable instructions and /commands."
							>
								{#snippet global()}<SkillsSettings showHeader={false} />{/snippet}
								{#snippet project(projectId)}<ProjectItemsPanel {projectId} kind="skill" />{/snippet}
							</ScopedSection>
						</div>
					{:else if activeSection === 'subagents'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<ScopedSection
								title="Subagents"
								description="Specialized agents to delegate tasks to."
							>
								{#snippet global()}<SubagentsSettings showHeader={false} />{/snippet}
								{#snippet project(projectId)}<ProjectItemsPanel {projectId} kind="subagent" />{/snippet}
							</ScopedSection>
						</div>
					{:else if activeSection === 'instructions'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<ScopedSection
								title="Instructions"
								description="Standing instructions for every engine."
							>
								{#snippet global()}<InstructionsSettings showHeader={false} />{/snippet}
								{#snippet project(projectId)}<ProjectInstructionsPanel {projectId} />{/snippet}
							</ScopedSection>
						</div>
					{:else if activeSection === 'permissions'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<ScopedSection
								title="Permissions"
								description="Allow or deny tools per engine."
							>
								{#snippet global()}<PermissionsSettings showHeader={false} />{/snippet}
								{#snippet project(projectId)}<ProjectPermissionsPanel {projectId} />{/snippet}
							</ScopedSection>
						</div>
					{:else if activeSection === 'file-shares'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<FileSharesSettings />
						</div>
					{:else if activeSection === 'memory'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<MemoryModelSettings />
						</div>
					{:else if activeSection === 'memory-graph'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<MemorySettings />
						</div>
					{:else if activeSection === 'profiles'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<ProfilesSettings />
						</div>
					{:else if activeSection === 'access'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<AccessSettings />
						</div>
					{:else if activeSection === 'files'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<FilesFoldersSettings />
						</div>
					{:else if activeSection === 'machine'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<AboutDeviceSettings />
						</div>
					{:else if activeSection === 'system'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<SystemSettings />
						</div>
					{/if}
				</div>
			</main>
		</div>
	{/snippet}
</Modal>
