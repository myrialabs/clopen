/**
 * UI types barrel export
 */

export * from './theme';
export * from './notifications';
export * from './icons';
export * from './components';

// Common UI types moved from common/ui.ts
export type NotificationType = 'success' | 'error' | 'warning' | 'info';

export interface ButtonAction {
	label: string;
	action: () => void;
}

export interface BaseDialogOptions {
	title?: string;
	message: string;
	type?: NotificationType;
}