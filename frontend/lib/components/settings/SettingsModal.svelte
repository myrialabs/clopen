<script lang="ts">
	import { fade, scale, fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import {
		settingsModalState,
		closeSettingsModal,
		setActiveSection,
		settingsSections,
		type SettingsSection
	} from '$frontend/lib/stores/ui/settings-modal.svelte';

	// Import settings components
	import ModelSettings from './model/ModelSettings.svelte';
	import AIEnginesSettings from './engines/AIEnginesSettings.svelte';
	import AppearanceSettings from './appearance/AppearanceSettings.svelte';
	import UserSettings from './user/UserSettings.svelte';
	import NotificationSettings from './notifications/NotificationSettings.svelte';
	import GeneralSettings from './general/GeneralSettings.svelte';
	import pkg from '../../../../package.json';

	// Responsive state
	let isMobileMenuOpen = $state(false);
	let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);

	const isMobile = $derived(windowWidth < 768);
	const isOpen = $derived(settingsModalState.isOpen);
	const activeSection = $derived(settingsModalState.activeSection);

	// Handle section change
	function handleSectionChange(section: SettingsSection) {
		setActiveSection(section);
		if (isMobile) {
			isMobileMenuOpen = false;
		}
	}

	// Handle backdrop click
	function handleBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget) {
			closeSettingsModal();
		}
	}

	// Handle keyboard events
	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			closeSettingsModal();
		}
	}

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

<svelte:window on:keydown={handleKeydown} on:resize={handleResize} />

{#if isOpen}
	<!-- Backdrop -->
	<div
		class="fixed inset-0 z-[100] flex items-center justify-center md:p-4 bg-black/60 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
		aria-labelledby="settings-title"
		tabindex="-1"
		onclick={handleBackdropClick}
		onkeydown={handleKeydown}
		in:fade={{ duration: 200, easing: cubicOut }}
		out:fade={{ duration: 150, easing: cubicOut }}
	>
		<!-- Modal Container -->
		<div
			role="dialog"
			aria-labelledby="settings-title"
			tabindex="-1"
			class="flex flex-col w-full max-w-225 h-[85vh] max-h-175 bg-slate-50 dark:bg-slate-950 border border-violet-500/20 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)] max-md:max-w-full max-md:h-screen max-md:max-h-screen max-md:rounded-none"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			in:scale={{ duration: 250, easing: cubicOut, start: 0.95 }}
			out:scale={{ duration: 150, easing: cubicOut, start: 0.95 }}
		>
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
						<Icon name={isMobileMenuOpen ? 'lucide:x' : 'lucide:menu'} class="w-5 h-5" />
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
					class="flex flex-col w-68 shrink-0 bg-white dark:bg-slate-900/98 border-r border-slate-200 dark:border-slate-800
						{isMobile
						? 'absolute left-0 top-0 bottom-0 z-10 w-70 shadow-[4px_0_20px_rgba(0,0,0,0.15)] dark:shadow-[4px_0_20px_rgba(0,0,0,0.3)] transition-transform duration-[250ms] ease-out'
						: ''}
						{isMobile && !isMobileMenuOpen ? '-translate-x-full' : 'translate-x-0'}"
				>
					{#if !isMobile}
						<header
							class="flex items-center justify-between py-5 px-4 pl-6.5 border-b border-slate-200 dark:border-slate-800"
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
						{#each settingsSections as section (section.id)}
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

					<footer class="p-4 border-t border-slate-200 dark:border-slate-800">
						<div class="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-500">
							<Icon name="lucide:info" class="w-4 h-4" />
							<span>Clopen v{pkg.version}</span>
						</div>
					</footer>
				</aside>

				<!-- Mobile Menu Overlay -->
				{#if isMobile && isMobileMenuOpen}
					<button
						type="button"
						class="absolute inset-0 z-[5] bg-black/40 border-none p-0 cursor-default"
						onclick={() => (isMobileMenuOpen = false)}
						aria-label="Close menu"
						in:fade={{ duration: 150 }}
						out:fade={{ duration: 100 }}
					></button>
				{/if}

				<!-- Content Area -->
				<main class="flex-1 flex flex-col min-w-0 overflow-hidden">
					<div class="flex-1 overflow-y-auto p-4 md:p-5">
						{#if activeSection === 'model'}
							<div in:fly={{ x: 20, duration: 200 }}>
								<ModelSettings />
							</div>
						{:else if activeSection === 'engines'}
							<div in:fly={{ x: 20, duration: 200 }}>
								<AIEnginesSettings />
							</div>
						{:else if activeSection === 'appearance'}
							<div in:fly={{ x: 20, duration: 200 }}>
								<AppearanceSettings />
							</div>
						{:else if activeSection === 'user'}
							<div in:fly={{ x: 20, duration: 200 }}>
								<UserSettings />
							</div>
						{:else if activeSection === 'notifications'}
							<div in:fly={{ x: 20, duration: 200 }}>
								<NotificationSettings />
							</div>
						{:else if activeSection === 'general'}
							<div in:fly={{ x: 20, duration: 200 }}>
								<GeneralSettings />
							</div>
						{/if}
					</div>
				</main>
			</div>
		</div>
	</div>
{/if}
