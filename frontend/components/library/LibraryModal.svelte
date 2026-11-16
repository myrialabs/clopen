<script lang="ts">
	/**
	 * The Library — the know-how Clopen and every agent work with: skills,
	 * scripts, specialists, rules, toolsets, integrations and secrets. Split out
	 * of Settings so Settings can be only about how Clopen behaves.
	 */
	import { fly } from 'svelte/transition';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ScopedSection from '$frontend/components/settings/project/ScopedSection.svelte';
	import ProjectItemsPanel from '$frontend/components/settings/project/ProjectItemsPanel.svelte';
	import ProjectInstructionsPanel from '$frontend/components/settings/project/ProjectInstructionsPanel.svelte';
	import ProjectMcpPanel from '$frontend/components/settings/project/ProjectMcpPanel.svelte';
	import SkillsSettings from '$frontend/components/settings/skills/SkillsSettings.svelte';
	import SubagentsSettings from '$frontend/components/settings/subagents/SubagentsSettings.svelte';
	import InstructionsSettings from '$frontend/components/settings/instructions/InstructionsSettings.svelte';
	import ProfilesSettings from '$frontend/components/settings/profiles/ProfilesSettings.svelte';
	import IntegrationsSettings from '$frontend/components/settings/integrations/IntegrationsSettings.svelte';
	import ScriptsLibrary from './ScriptsLibrary.svelte';
	import SecretsLibrary from './SecretsLibrary.svelte';
	import SkillHistory from './SkillHistory.svelte';
	import { closeLibrary, libraryModalState, librarySections, setLibrarySection, type LibrarySection } from '$frontend/stores/ui/library-modal.svelte';

	let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
	let isMobileMenuOpen = $state(false);
	const isMobile = $derived(windowWidth < 768);
	const current = $derived(librarySections.find((section) => section.id === libraryModalState.activeSection) ?? librarySections[0]);

	function choose(section: LibrarySection) {
		setLibrarySection(section);
		if (isMobile) isMobileMenuOpen = false;
	}
</script>

<svelte:window onresize={() => (windowWidth = window.innerWidth)} />

<Modal
	isOpen={libraryModalState.isOpen}
	onClose={closeLibrary}
	bare
	mobileFullscreen
	ariaLabelledBy="library-title"
	className="flex flex-col w-full max-w-225 h-[85dvh] max-h-175 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]"
>
	{#snippet children()}
		{#if isMobile}
			<header class="flex items-center justify-between py-3 px-4 bg-slate-100 dark:bg-slate-900/95 border-b border-slate-200 dark:border-slate-800">
				<button type="button" class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer hover:bg-violet-500/10" onclick={() => (isMobileMenuOpen = !isMobileMenuOpen)} aria-label="Toggle menu">
					<Icon name={isMobileMenuOpen ? 'lucide:arrow-left' : 'lucide:menu'} class="w-5 h-5" />
				</button>
				<h2 id="library-title" class="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100 m-0">
					<Icon name={current.icon} class="w-5 h-5" />{current.label}
				</h2>
				<button type="button" class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer hover:bg-violet-500/10" onclick={closeLibrary} aria-label="Close library">
					<Icon name="lucide:x" class="w-5 h-5" />
				</button>
			</header>
		{/if}
		<div class="flex flex-1 min-h-0 relative">
			<aside
				class="flex flex-col w-65 shrink-0 bg-white dark:bg-slate-900/98 border-r border-slate-200 dark:border-slate-800
					{isMobile ? 'absolute left-0 top-0 bottom-0 z-10 w-70 shadow-xl transition-transform duration-250 ease-out' : ''}
					{isMobile && !isMobileMenuOpen ? '-translate-x-full' : 'translate-x-0'}"
			>
				{#if !isMobile}
					<header class="flex items-center justify-between py-3 px-4 pl-6.5 border-b border-slate-200 dark:border-slate-800">
						<span id="library-title" class="text-lg font-bold text-slate-900 dark:text-slate-100">Library</span>
						<button type="button" class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer hover:bg-violet-500/10" onclick={closeLibrary} aria-label="Close library">
							<Icon name="lucide:x" class="w-5 h-5" />
						</button>
					</header>
				{/if}
				<nav class="flex-1 overflow-y-auto p-3">
					{#each librarySections as section (section.id)}
						<button
							type="button"
							class="flex items-start gap-3 w-full py-3 px-3.5 bg-transparent border-none rounded-lg text-slate-500 text-sm text-left cursor-pointer transition-all duration-150 mb-1 hover:bg-violet-500/10
								{libraryModalState.activeSection === section.id ? 'bg-violet-500/10 dark:bg-violet-500/20 text-slate-900 dark:text-slate-100' : ''}"
							onclick={() => choose(section.id)}
						>
							<Icon name={section.icon} class="w-5 h-5 shrink-0 mt-0.5 {libraryModalState.activeSection === section.id ? 'text-violet-600' : ''}" />
							<div class="flex flex-col gap-0.5">
								<span class="font-semibold">{section.label}</span>
								<span class="text-xs text-slate-600 dark:text-slate-500 leading-tight">{section.description}</span>
							</div>
						</button>
					{/each}
				</nav>
			</aside>
			{#if isMobile && isMobileMenuOpen}
				<button type="button" class="absolute inset-0 z-[5] bg-black/40 border-none p-0 cursor-default" onclick={() => (isMobileMenuOpen = false)} aria-label="Close menu"></button>
			{/if}
			<main class="flex-1 flex flex-col min-w-0 overflow-hidden">
				<div class="flex-1 overflow-y-auto p-4 md:p-5">
					{#key libraryModalState.activeSection}
						<div in:fly={{ x: 20, duration: 200 }}>
							{#if libraryModalState.activeSection === 'skills'}
								<ScopedSection title="Skills" description="Know-how and /commands. Clopen adds its own.">
									{#snippet global()}<SkillsSettings showHeader={false} /><SkillHistory />{/snippet}
									{#snippet project(projectId)}<ProjectItemsPanel {projectId} kind="skill" />{/snippet}
								</ScopedSection>
							{:else if libraryModalState.activeSection === 'scripts'}
								<ScriptsLibrary />
							{:else if libraryModalState.activeSection === 'subagents'}
								<ScopedSection title="Specialists" description="Experts an agent can hand work to.">
									{#snippet global()}<SubagentsSettings showHeader={false} />{/snippet}
									{#snippet project(projectId)}<ProjectItemsPanel {projectId} kind="subagent" />{/snippet}
								</ScopedSection>
							{:else if libraryModalState.activeSection === 'rules'}
								<ScopedSection title="Rules" description="What every agent follows.">
									{#snippet global()}<InstructionsSettings showHeader={false} />{/snippet}
									{#snippet project(projectId)}<ProjectInstructionsPanel {projectId} />{/snippet}
								</ScopedSection>
							{:else if libraryModalState.activeSection === 'toolsets'}
								<ProfilesSettings />
							{:else if libraryModalState.activeSection === 'secrets'}
								<SecretsLibrary />
							{:else if libraryModalState.activeSection === 'integrations'}
								<ScopedSection title="Integrations" description="Connected apps and tools.">
									{#snippet global()}<IntegrationsSettings showHeader={false} />{/snippet}
									{#snippet project(projectId)}<ProjectMcpPanel {projectId} />{/snippet}
								</ScopedSection>
							{/if}
						</div>
					{/key}
				</div>
			</main>
		</div>
	{/snippet}
</Modal>
