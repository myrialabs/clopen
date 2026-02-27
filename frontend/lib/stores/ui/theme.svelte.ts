import type { Theme } from '$shared/types/ui';

// Theme store using Svelte 5 runes
export const themeStore = $state({
	current: {
		name: 'claude-modern',
		primary: '#D97757',
		secondary: '#4F46E5',
		background: '#F9FAFB',
		text: '#111827',
		mode: 'light' as const
	} as Theme,
	isDark: false,
	isSystemDark: false
});

// Derived values as functions (cannot export derived state from modules)
export function currentTheme() {
	return themeStore.current;
}

export function isDarkMode() {
	return themeStore.isDark;
}

// Theme presets
export const themes: Theme[] = [
	{
		name: 'claude-modern',
		primary: '#D97757',
		secondary: '#4F46E5',
		background: '#F9FAFB',
		text: '#111827',
		mode: 'light'
	},
	{
		name: 'claude-dark',
		primary: '#D97757',
		secondary: '#4F46E5',
		background: '#111827',
		text: '#F9FAFB',
		mode: 'dark'
	}
];

// Theme functions using Tailwind CSS v4 approach with optimized transitions
export function setTheme(theme: Theme) {
	themeStore.current = theme;
	themeStore.isDark = theme.mode === 'dark';

	// Apply theme to document using Tailwind v4 class-based dark mode
	if (typeof window !== 'undefined') {
		const htmlElement = document.documentElement;
		
		// Disable transitions during theme switch for performance
		htmlElement.classList.add('no-transitions');
		
		// Force a reflow to ensure the no-transitions class is applied
		htmlElement.offsetHeight;
		
		// Tailwind v4 class-based approach: only add 'dark' class when in dark mode
		// Light mode is the default state (no class needed)
		if (theme.mode === 'dark') {
			htmlElement.classList.add('dark');
		} else {
			htmlElement.classList.remove('dark');
		}
		
		// Set CSS custom properties for dynamic accent colors
		htmlElement.style.setProperty('--color-primary', theme.primary);
		htmlElement.style.setProperty('--color-secondary', theme.secondary);
		
		// Set color scheme for browser integration (important for form controls, scrollbars, etc.)
		htmlElement.style.colorScheme = theme.mode === 'dark' ? 'dark' : 'light';
		
		// Update meta theme-color for mobile browsers  
		updateThemeColor(theme.mode);
		
		// Re-enable transitions after a short delay to allow theme to settle
		setTimeout(() => {
			htmlElement.classList.remove('no-transitions');
		}, 50);
	}

	// Save to localStorage
	localStorage.setItem('claude-theme', JSON.stringify(theme));
}

// Helper function to update theme color meta tag
function updateThemeColor(mode: 'light' | 'dark') {
	let metaThemeColor = document.querySelector('meta[name="theme-color"]');
	if (!metaThemeColor) {
		metaThemeColor = document.createElement('meta');
		metaThemeColor.setAttribute('name', 'theme-color');
		document.head.appendChild(metaThemeColor);
	}
	
	// Set appropriate theme color
	const themeColor = mode === 'dark' ? '#0a0a0a' : '#ffffff';
	metaThemeColor.setAttribute('content', themeColor);
}

export function toggleDarkMode() {
	// Toggle to opposite mode
	const newMode: 'light' | 'dark' = themeStore.isDark ? 'light' : 'dark';

	// Use predefined themes for consistency
	const newTheme = newMode === 'dark' ? themes[1] : themes[0]; // claude-dark or claude-modern
	
	setTheme(newTheme);
	
	// Mark as manual theme choice
	localStorage.setItem('claude-theme-manual', 'true');
}

export function initializeTheme() {
	if (typeof window === 'undefined') return;
	
	// Check system preference
	const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
	themeStore.isSystemDark = isSystemDark;
	
	// Check for saved theme preference
	const savedTheme = localStorage.getItem('claude-theme');
	const isManualTheme = localStorage.getItem('claude-theme-manual') === 'true';
	
	let initialTheme: Theme;
	
	if (savedTheme && isManualTheme) {
		// Use saved manual theme preference
		try {
			initialTheme = JSON.parse(savedTheme);
		} catch {
			// Fallback to system preference if parsing fails
			initialTheme = isSystemDark ? themes[1] : themes[0];
		}
	} else {
		// Follow system preference
		initialTheme = isSystemDark ? themes[1] : themes[0];
	}
	
	// Sync store state with what was already applied by inline script
	themeStore.current = initialTheme;
	themeStore.isDark = initialTheme.mode === 'dark';
	
	// Only apply theme if it differs from current DOM state to avoid redundant operations
	const htmlElement = document.documentElement;
	const isDarkCurrentlyApplied = htmlElement.classList.contains('dark');
	
	if ((initialTheme.mode === 'dark') !== isDarkCurrentlyApplied) {
		setTheme(initialTheme);
	} else {
		// Just set CSS custom properties since theme class is already correct
		htmlElement.style.setProperty('--color-primary', initialTheme.primary);
		htmlElement.style.setProperty('--color-secondary', initialTheme.secondary);
	}

	// Listen for system theme changes
	window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
		themeStore.isSystemDark = e.matches;
		
		// Only follow system if no manual theme was set
		if (!localStorage.getItem('claude-theme-manual')) {
			const newTheme = e.matches ? themes[1] : themes[0];
			setTheme(newTheme);
		}
	});
}

export function setManualTheme(theme: Theme) {
	setTheme(theme);
	localStorage.setItem('claude-theme-manual', 'true');
}

export function useSystemTheme() {
	localStorage.removeItem('claude-theme-manual');
	const defaultTheme = themeStore.isSystemDark ? themes[1] : themes[0];
	setTheme(defaultTheme);
}
