/**
 * XTerm Types
 * 
 * TypeScript definitions for xterm component
 */

import type { TerminalSession } from '$shared/types/terminal';

export interface XTermProps {
	session?: TerminalSession;
	class?: string;
	hasActiveProject?: boolean;
	projectPath?: string;
	isExecuting?: boolean;
	onExecuteCommand?: (command: string, terminalSize?: { cols: number; rows: number }) => Promise<void>;
	onClearSession?: () => void;
}

export interface XTermMethods {
	clear(): void;
	fit(): void;
	scrollToBottom(): void;
	writeData(data: string): void;
	getSelectedText(): string;
	clearSelection(): void;
}

export interface TerminalSize {
	cols: number;
	rows: number;
}