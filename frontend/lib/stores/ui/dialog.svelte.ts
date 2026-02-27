import type { AlertOptions, ConfirmOptions, DialogState } from '$shared/types/stores/dialog';

const dialogState = $state<DialogState>({
	alert: {
		isOpen: false,
		options: {
			message: ''
		}
	},
	confirm: {
		isOpen: false,
		options: {
			message: ''
		}
	}
});

export const showAlert = (options: AlertOptions): Promise<void> => {
	return new Promise((resolve) => {
		dialogState.alert = {
			isOpen: true,
			options,
			resolve
		};
	});
};

export const showConfirm = (options: ConfirmOptions): Promise<boolean> => {
	return new Promise((resolve) => {
		dialogState.confirm = {
			isOpen: true,
			options,
			resolve
		};
	});
};

export const closeAlert = () => {
	if (dialogState.alert.resolve) {
		dialogState.alert.resolve();
	}
	dialogState.alert.isOpen = false;
};

export const closeConfirm = (confirmed: boolean) => {
	if (dialogState.confirm.resolve) {
		dialogState.confirm.resolve(confirmed);
	}
	dialogState.confirm.isOpen = false;
};

export const dialogStore = {
	get alert() {
		return dialogState.alert;
	},
	get confirm() {
		return dialogState.confirm;
	}
};