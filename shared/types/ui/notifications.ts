/**
 * Notification and toast types
 */

import type { NotificationType, ButtonAction } from './index';

export interface ToastNotification {
	id: string;
	type: NotificationType;
	title: string;
	message: string;
	duration?: number;
	actions?: ButtonAction[];
}