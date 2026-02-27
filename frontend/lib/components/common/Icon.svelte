<script lang="ts">
	// Import organized icon registries
	import { lucideIconRegistry } from './lucide-icons';
	import { materialIconRegistry } from './material-icons';
	import lucideData from '@iconify-json/lucide/icons.json';
	import materialData from '@iconify-json/material-icon-theme/icons.json';
	import type { IconName } from '$shared/types/ui/icons';
	import { debug } from '$shared/utils/logger';

	const iconRegistry = {
		// ALL LUCIDE ICONS
		...lucideIconRegistry,

		// ALL MATERIAL ICON THEME ICONS
		...materialIconRegistry,
	} as const;

	// Default dimensions for each icon library
	const defaultDimensions = {
		lucide: { width: lucideData.width || 24, height: lucideData.height || 24 },
		material: { width: materialData.width || 32, height: materialData.height || 32 }
	};

	interface Props {
		name: IconName;
		class?: string;
	}

	const { name, class: className = '' }: Props = $props();

	const icon = $derived(iconRegistry[name]);

	const svgContent = $derived.by(() => {
		if (!icon) {
			debug.warn('session', `Icon not found: ${name}`);
			return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="iconify ${className}" fill="currentColor"><rect x="3" y="3" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 9l6 6m-6 0l6-6"/></svg>`;
		}
		
		// Extract SVG body from icon data
		const body = icon.body || '';
		
		// Determine icon dimensions
		const iconPrefix = name.split(':')[0] as 'lucide' | 'material';
		const defaults = defaultDimensions[iconPrefix] || { width: 24, height: 24 };
		
		// Use icon-specific dimensions if available, otherwise use library defaults
		const width = icon.width || defaults.width;
		const height = icon.height || defaults.height;
		const top = icon.top || 0;
		
		// Create viewBox
		const viewBox = `0 ${top} ${width} ${height}`;
		
		return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" class="iconify ${className}" fill="currentColor">${body}</svg>`;
	});
</script>

{@html svgContent}