/**
 * Application state types
 */

import type { Project, ChatSession } from '../database/schema';
import type { FileNode } from '../filesystem';
import type { ToastNotification } from '../ui/notifications';

export interface PageInfo {
	title: string;
	description: string;
	actions?: import('svelte').Snippet;
}

export interface AppState {
	currentProject: Project | null;
	currentSession: ChatSession | null;
	currentView: string;
	files: FileNode[];
	isLoading: boolean;
	notifications: ToastNotification[];
	pageInfo: PageInfo;
}