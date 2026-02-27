/**
 * File system related types
 */

import type { IconName } from '../ui/icons';

export interface FileNode {
	name: string;
	path: string;
	type: 'file' | 'directory';
	children?: FileNode[];
	size?: number;
	modified?: Date;
	icon?: IconName;
}

export interface FileChange {
	path: string;
	type: 'created' | 'modified' | 'deleted';
	timestamp: string;
	diff?: string;
}