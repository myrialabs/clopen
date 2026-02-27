/**
 * Xterm.js Components Module
 * 
 * Modular terminal components using xterm.js
 * Provides reusable terminal functionality with proper Svelte 5 integration
 */

// Main terminal component
export { default as XTerm } from './XTerm.svelte';

// Terminal configuration and utilities
export { terminalConfig, formatDirectory } from './terminal-config';
export { XTermService } from './xterm-service';

// Terminal types
export type { XTermProps, XTermMethods } from './types';