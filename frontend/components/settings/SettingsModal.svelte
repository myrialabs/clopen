<script lang="ts">
	import { fly } from 'svelte/transition';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import {
		settingsModalState,
		closeSettingsModal,
		setActiveSection,
		settingsSections,
		type SettingsSection
	} from '$frontend/stores/ui/settings-modal.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { systemSettings } from '$frontend/stores/features/settings.svelte';

	// Import settings components
	import ModelSettings from './model/ModelSettings.svelte';
	import AIEnginesSettings from './engines/AIEnginesSettings.svelte';
	import SystemToolsSettings from './system-tools/SystemToolsSettings.svelte';
	import AppearanceSettings from './appearance/AppearanceSettings.svelte';
	import AccountSettings from './account/AccountSettings.svelte';
	import NotificationSettings from './notifications/NotificationSettings.svelte';
	import TeamSettings from './admin/UserManagement.svelte';
	import InviteManagement from './admin/InviteManagement.svelte';
	import SecuritySettings from './security/SecuritySettings.svelte';
	import SystemSettings from './system/SystemSettings.svelte';
	import TunnelSettings from './tunnel/TunnelSettings.svelte';

	// Responsive state
	let isMobileMenuOpen = $state(false);
	let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);

	const isMobile = $derived(windowWidth < 768);
	const activeSection = $derived(settingsModalState.activeSection);
	const isAdmin = $derived(authStore.isAdmin);
	const isNoAuth = $derived(systemSettings.authMode === 'none');

	// Filter sections: hide admin-only tabs for non-admins, hide team in no-auth mode
	const visibleSections = $derived(
		settingsSections.filter(s => {
			if (s.adminOnly && !isAdmin) return false;
			if (s.id === 'team' && isNoAuth) return false;
			return true;
		})
	);

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

				<nav class="flex-1 overflow-y-auto p-3">
					{#each visibleSections as section (section.id)}
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
					{#if activeSection === 'models'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<ModelSettings />
						</div>
					{:else if activeSection === 'appearance'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<AppearanceSettings />
						</div>
					{:else if activeSection === 'notifications'}
						<div in:fly={{ x: 20, duration: 200 }}>
							<NotificationSettings />
						</div>
					{:else if activeSection === 'tunnel'}
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
					{:else if activeSection === 'team' && isAdmin && !isNoAuth}
						<div in:fly={{ x: 20, duration: 200 }}>
							<TeamSettings />
							<div class="mt-6">
								<InviteManagement />
							</div>
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
			</main>
		</div>
	{/snippet}
</Modal>
