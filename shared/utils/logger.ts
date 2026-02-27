/**
 * Custom Logger Module - debug
 *
 * Provides filtered logging capabilities with label-based categorization.
 * All logs can be filtered by label, method type, and text content.
 */

export type LogLabel =
	// Chat
	| 'chat'
	| 'checkpoint'
	| 'snapshot'
	
	// Preview
	| 'preview'
	| 'webcodecs'

	// File
	| 'file'
	
	// Terminal
	| 'terminal'
	
	// Git
	| 'git'
	
	// Communication
	| 'websocket'
	| 'mcp'
	| 'notification'
	
	// Configuration
	| 'project'
	| 'workspace'
	| 'settings'
	| 'engine'
	| 'tunnel'
	
	// User
	| 'user'
	| 'session'
	
	// System
	| 'server'
	| 'database'
	| 'migration'
	| 'seeder';
export type LogMethod = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace';

interface LoggerConfig {
	enabled: boolean; // Global enable/disable based on NODE_ENV (production = disabled)
	filterLabels: LogLabel[] | null; // null = show all, array = only show specified labels
	filterMethods: LogMethod[] | null; // null = show all, array = only show specified methods
	filterText: string | null; // null = no text filter, string = only show logs containing this text (case-sensitive)
}

// Default configuration - null means no filtering
// enabled = true in development, false in production
const config: LoggerConfig = {
	enabled: process.env.NODE_ENV !== 'production',
	filterLabels: null,
	filterMethods: null,
	filterText: null
};

/**
 * Check if a log should be displayed based on current filters
 */
function shouldLog(label: LogLabel, method: LogMethod, args: any[]): boolean {
	// Global enable/disable check first
	if (!config.enabled) {
		return false;
	}

	// Filter by label
	if (config.filterLabels !== null && !config.filterLabels.includes(label)) {
		return false;
	}

	// Filter by method
	if (config.filterMethods !== null && !config.filterMethods.includes(method)) {
		return false;
	}

	// Filter by text (case-sensitive)
	if (config.filterText !== null) {
		// Convert all arguments to string for searching
		const argsString = args
			.map((arg) => {
				if (typeof arg === 'object') {
					try {
						return JSON.stringify(arg);
					} catch {
						return String(arg);
					}
				}
				return String(arg);
			})
			.join(' ');

		// Case-sensitive search
		if (!argsString.includes(config.filterText)) {
			return false;
		}
	}

	return true;
}

/**
 * Format log output with label prefix
 */
function formatOutput(label: LogLabel, args: any[]): any[] {
	const d = new Date();
	const timestamp =
		`${String(d.getHours()).padStart(2, '0')}:` +
		`${String(d.getMinutes()).padStart(2, '0')}:` +
		`${String(d.getSeconds()).padStart(2, '0')}.` +
		`${String(d.getMilliseconds()).padStart(3, '0')}`;

	return [`[${timestamp}] [${label}]`, ...args];
}

/**
 * Core logging function
 */
function createLogMethod(method: LogMethod) {
	return (label: LogLabel, ...args: any[]): void => {
		if (shouldLog(label, method, args)) {
			const output = formatOutput(label, args);
			console[method](...output);
		}
	};
}

// Export the debug logger object
export const debug = {
	log: createLogMethod('log'),
	info: createLogMethod('info'),
	warn: createLogMethod('warn'),
	error: createLogMethod('error'),
	debug: createLogMethod('debug'),
	trace: createLogMethod('trace'),
};
