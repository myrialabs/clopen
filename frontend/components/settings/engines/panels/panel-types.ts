// Per-engine status shapes. The parent (AIEnginesSettings) fetches these for the
// engine selector grid and passes them down to each panel as props.

export type BackendOS = 'windows' | 'macos' | 'linux';

export interface ClaudeCodeStatus {
	installed: boolean;
	version: string | null;
	activeAccount: { id: number; name: string } | null;
	accountsCount: number;
	backendOS: BackendOS;
}

export interface OpenCodeStatus {
	installed: boolean;
	version: string | null;
	backendOS: BackendOS;
}

export interface CopilotStatus {
	installed: boolean;
	version: string | null;
	activeAccount: { id: number; name: string } | null;
	accountsCount: number;
	backendOS: BackendOS;
}

export interface CodexStatus {
	installed: boolean;
	version: string | null;
	sdkVersion: string | null;
	activeAccount: { id: number; name: string; authMode: 'api_key' | 'chatgpt' | null } | null;
	accountsCount: number;
	backendOS: BackendOS;
}

export interface QwenStatus {
	installed: boolean;
	version: string | null;
	activeAccount: { id: number; name: string } | null;
	accountsCount: number;
	backendOS: BackendOS;
}

export interface PiStatus {
	installed: boolean;
	version: string | null;
	activeAccount: { id: number; name: string } | null;
	accountsCount: number;
	backendOS: BackendOS;
}

export interface ClineStatus {
	installed: boolean;
	version: string | null;
	activeAccount: { id: number; name: string } | null;
	accountsCount: number;
	backendOS: BackendOS;
}
