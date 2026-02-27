/**
 * Files Store
 * File explorer state management
 */

import type { FileNode } from '$shared/types/filesystem';

interface FileState {
	files: FileNode[];
	selectedFile: FileNode | null;
	expandedFolders: Set<string>;
	isLoading: boolean;
	error: string | null;
}

// File state using Svelte 5 runes
export const fileState = $state<FileState>({
	files: [],
	selectedFile: null,
	expandedFolders: new Set<string>(),
	isLoading: false,
	error: null
});

// ========================================
// FILE MANAGEMENT
// ========================================

export function setFiles(files: FileNode[]) {
	fileState.files = files;
}

export function setSelectedFile(file: FileNode | null) {
	fileState.selectedFile = file;
}

export function toggleFolderExpansion(folderPath: string) {
	if (fileState.expandedFolders.has(folderPath)) {
		fileState.expandedFolders.delete(folderPath);
	} else {
		fileState.expandedFolders.add(folderPath);
	}
}

export function expandFolder(folderPath: string) {
	fileState.expandedFolders.add(folderPath);
}

export function collapseFolder(folderPath: string) {
	fileState.expandedFolders.delete(folderPath);
}

export function clearFiles() {
	fileState.files = [];
	fileState.selectedFile = null;
	fileState.expandedFolders.clear();
}

// ========================================
// STATE MANAGEMENT
// ========================================

export function setLoading(loading: boolean) {
	fileState.isLoading = loading;
}

export function setError(error: string | null) {
	fileState.error = error;
}

export function clearError() {
	fileState.error = null;
}