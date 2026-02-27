import type { ToastNotification } from '$shared/types/ui/notifications';

// Notification store using Svelte 5 runes
export const notificationStore = $state({
	notifications: [] as ToastNotification[],
	maxNotifications: 5
});

// Derived values as functions (cannot export derived state from modules)
export function hasNotifications() {
	return notificationStore.notifications.length > 0;
}

export function notificationCount() {
	return notificationStore.notifications.length;
}

// Notification management functions
export function addNotification(notification: Omit<ToastNotification, 'id'>) {
	const newNotification: ToastNotification = {
		id: Date.now().toString(),
		...notification,
		duration: notification.duration || 5000 // Default 5 seconds
	};

	notificationStore.notifications.push(newNotification);

	// Remove oldest notification if we exceed max
	if (notificationStore.notifications.length > notificationStore.maxNotifications) {
		notificationStore.notifications.shift();
	}

	return newNotification;
}

export function removeNotification(id: string) {
	notificationStore.notifications = notificationStore.notifications.filter((n) => n.id !== id);
}

export function clearNotifications() {
	notificationStore.notifications = [];
}

export function updateNotification(id: string, updates: Partial<ToastNotification>) {
	const index = notificationStore.notifications.findIndex((n) => n.id === id);
	if (index !== -1) {
		notificationStore.notifications[index] = {
			...notificationStore.notifications[index],
			...updates
		};
	}
}

// Convenience functions for different notification types
export function showSuccess(title: string, message: string, duration?: number) {
	return addNotification({
		type: 'success',
		title,
		message,
		duration
	});
}

export function showError(title: string, message: string, duration?: number) {
	return addNotification({
		type: 'error',
		title,
		message,
		duration: duration || 8000 // Errors should stay longer
	});
}

export function showWarning(title: string, message: string, duration?: number) {
	return addNotification({
		type: 'warning',
		title,
		message,
		duration: duration || 6000
	});
}

export function showInfo(title: string, message: string, duration?: number) {
	return addNotification({
		type: 'info',
		title,
		message,
		duration
	});
}

// Show notification with actions
export function showNotificationWithActions(
	type: ToastNotification['type'],
	title: string,
	message: string,
	actions: Array<{ label: string; action: () => void }>,
	duration?: number
) {
	return addNotification({
		type,
		title,
		message,
		actions,
		duration: duration || 10000 // Notifications with actions should stay longer
	});
}

// Show progress notification
export function showProgressNotification(title: string, message: string) {
	return addNotification({
		type: 'info',
		title,
		message,
		duration: 0 // Don't auto-dismiss progress notifications
	});
}

// Auto-dismiss notification after delay
export function autoRemoveNotification(id: string, delay: number) {
	setTimeout(() => {
		removeNotification(id);
	}, delay);
}

// Initialize notifications
export function initializeNotifications() {
	// Clear any existing notifications on initialization
	clearNotifications();
}

// Handle global error notifications
export function showGlobalError(error: Error | string) {
	const message = typeof error === 'string' ? error : error.message;
	return showError('Error', message);
}

// Handle API error notifications
export function showApiError(error: any) {
	const message =
		error?.response?.data?.message || error?.message || 'An unexpected error occurred';
	return showError('API Error', message);
}

// Handle network error notifications
export function showNetworkError() {
	return showError('Network Error', 'Please check your internet connection and try again');
}

// Handle validation error notifications
export function showValidationError(message: string) {
	return showWarning('Validation Error', message);
}

// Handle success operations
export function showOperationSuccess(operation: string) {
	return showSuccess('Success', `${operation} completed successfully`);
}

// Handle file operation notifications
export function showFileOperationSuccess(operation: string, fileName: string) {
	return showSuccess('File Operation', `${operation} "${fileName}" successfully`);
}

export function showFileOperationError(operation: string, fileName: string, error: string) {
	return showError('File Operation Failed', `Failed to ${operation} "${fileName}": ${error}`);
}
