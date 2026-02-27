import type { IPty } from 'bun-pty';

// Store active PTY processes per session (shared between endpoints)
export const activePtyProcesses = new Map<string, IPty>();