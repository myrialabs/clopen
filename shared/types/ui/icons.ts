/**
 * Icon system types
 */

// Icon types for type safety
import type { lucideIconRegistry } from '$frontend/lib/components/common/lucide-icons';
import type { materialIconRegistry } from '$frontend/lib/components/common/material-icons';

// Individual icon type exports from auto-generated files
export type { LucideIconName } from '$frontend/lib/components/common/lucide-icons';
export type { MaterialIconName } from '$frontend/lib/components/common/material-icons';

// Combined icon registry type
const iconRegistry = {
	// ALL LUCIDE ICONS
	...({} as typeof lucideIconRegistry),

	// ALL MATERIAL ICON THEME ICONS  
	...({} as typeof materialIconRegistry),
} as const;

// Type for all supported icons
export type IconName = keyof typeof iconRegistry;