import type { BaseDialogOptions } from '../ui';

export interface AlertOptions extends BaseDialogOptions {}

export interface ConfirmOptions extends BaseDialogOptions {
	confirmText?: string;
	cancelText?: string;
}

export interface DialogState {
	alert: {
		isOpen: boolean;
		options: AlertOptions;
		resolve?: () => void;
	};
	confirm: {
		isOpen: boolean;
		options: ConfirmOptions;
		resolve?: (value: boolean) => void;
	};
}