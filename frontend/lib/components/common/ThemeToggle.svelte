<!--
  ThemeToggle.svelte
  
  Theme toggle component for switching between light/dark/system modes
-->

<script lang="ts">
	import Icon from './Icon.svelte';
	import { themeStore, setTheme as setStoreTheme, themes } from '$frontend/lib/stores/ui/theme.svelte';

	let isOpen = $state(false);
	
	// Get current theme mode
	const currentMode = $derived(themeStore.current.mode);

	function toggleTheme() {
		// Simple toggle between light and dark
		const newTheme = themeStore.current.mode === 'light' ? themes[1] : themes[0];
		setStoreTheme(newTheme);
		isOpen = false;
	}

	function getThemeIcon(mode: string) {
		switch (mode) {
			case 'light':
				return 'lucide:sun';
			case 'dark':
				return 'lucide:moon';
			default:
				return 'lucide:monitor';
		}
	}
</script>

<div class="relative">
	<button
		class="p-2 rounded-lg text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
		onclick={toggleTheme}
		aria-label="Toggle theme"
	>
		<Icon name={getThemeIcon(currentMode)} class="w-5 h-5" />
	</button>
</div>

