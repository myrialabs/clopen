/**
 * TARGETED Process Management for Terminal Command Cancellation
 * Tracks specific session processes without affecting external terminals
 */

import type { Subprocess } from 'bun';

import { debug } from '$shared/utils/logger';
// Store active child processes globally
const activeProcesses = new Map<string, Subprocess>();
// Store child process trees for comprehensive cleanup
const processTreeMap = new Map<string, number[]>();
// Track manually terminated sessions
const manuallyTerminatedSessions = new Set<string>();
// Platform detection
const isWindows = process.platform === 'win32';

export function setActiveProcess(sessionId: string, process: Subprocess) {
	debug.log('server', '🔧 Setting active process for session:', sessionId, 'PID:', process.pid);
	
	// Clean up any existing process for this session first
	const existingProcess = activeProcesses.get(sessionId);
	if (existingProcess && existingProcess.pid) {
		debug.log('server', '🧹 Cleaning up existing process for session:', sessionId);
		try {
			// Use nuclear cleanup for existing process
			nuclearProcessCleanup(sessionId);
		} catch (error) {
			debug.log('server', '⚠️ Failed to clean existing process:', error);
		}
	}
	
	activeProcesses.set(sessionId, process);
	processTreeMap.set(sessionId, []);
	
	// Add cleanup handlers - ONLY cleanup tracking, not nuclear
	process.exited.then((code) => {
		debug.log('server', `🏁 Process for session ${sessionId} exited with code ${code}`);
		// Just cleanup tracking - don't force kill other processes
		activeProcesses.delete(sessionId);
		processTreeMap.delete(sessionId);
		// Clean up manual termination tracking after some time
		setTimeout(() => {
			manuallyTerminatedSessions.delete(sessionId);
		}, 5000);
	}).catch((error) => {
		debug.log('server', `❌ Process error for session ${sessionId}:`, error);
		// Just cleanup tracking - don't force kill other processes
		activeProcesses.delete(sessionId);
		processTreeMap.delete(sessionId);
		// Clean up manual termination tracking
		setTimeout(() => {
			manuallyTerminatedSessions.delete(sessionId);
		}, 5000);
	});
	
	// Start monitoring child processes for this session
	if (process.pid) {
		startChildProcessMonitoring(sessionId, process.pid);
	}
}

// Track child processes without aggressive monitoring
function startChildProcessMonitoring(sessionId: string, parentPid: number) {
	const monitorInterval = setInterval(async () => {
		try {
			// Only monitor if session still exists and process is alive
			if (!activeProcesses.has(sessionId)) {
				clearInterval(monitorInterval);
				return;
			}
			
			const childPids = await discoverChildProcesses(parentPid);
			const currentChildren = processTreeMap.get(sessionId) || [];
			
			// Add new children to tracking (passive monitoring only)
			for (const childPid of childPids) {
				if (!currentChildren.includes(childPid)) {
					debug.log('server', `🔍 Discovered new child process: ${childPid} for session: ${sessionId}`);
					currentChildren.push(childPid);
				}
			}
			
			processTreeMap.set(sessionId, currentChildren);
			
		} catch (error) {
			debug.log('server', '⚠️ Child process monitoring error:', error);
			// Don't kill anything on monitoring errors
		}
	}, 5000); // Check every 5 seconds (less aggressive)
	
	// Clean up monitoring after reasonable time
	setTimeout(() => {
		clearInterval(monitorInterval);
	}, 300000); // Stop after 5 minutes max
}

// NUCLEAR: Discover all child processes of a parent
async function discoverChildProcesses(parentPid: number): Promise<number[]> {
	const childPids: number[] = [];
	
	try {
		if (isWindows) {
			// Windows: Use WMIC to find all children recursively
			const proc = Bun.spawn(['wmic', 'process', 'where', `ParentProcessId=${parentPid}`, 'get', 'ProcessId', '/format:csv'], {
				stdout: 'pipe',
				stderr: 'ignore'
			});
			const output = await new Response(proc.stdout).text();
			
			const lines = output.split('\n');
			for (const line of lines) {
				const match = line.match(/,(\d+)$/);
				if (match) {
					const childPid = parseInt(match[1]);
					childPids.push(childPid);
					
					// Recursively find grandchildren
					const grandChildren = await discoverChildProcesses(childPid);
					childPids.push(...grandChildren);
				}
			}
		} else {
			// Unix: Use pgrep to find children
			try {
				const proc = Bun.spawn(['pgrep', '-P', parentPid.toString()], {
					stdout: 'pipe',
					stderr: 'ignore'
				});
				const output = await new Response(proc.stdout).text();
				
				const lines = output.trim().split('\n');
				for (const line of lines) {
					if (line.trim()) {
						const childPid = parseInt(line.trim());
						if (!isNaN(childPid)) {
							childPids.push(childPid);
							
							// Recursively find grandchildren
							const grandChildren = await discoverChildProcesses(childPid);
							childPids.push(...grandChildren);
						}
					}
				}
			} catch (error) {
				// No children found, which is fine
			}
		}
	} catch (error) {
		debug.log('server', '⚠️ Error discovering child processes:', error);
	}
	
	return [...new Set(childPids)]; // Remove duplicates
}

// TARGETED: Complete process tree cleanup for specific session only
export async function nuclearProcessCleanup(sessionId: string) {
	debug.log('server', '🎯 TARGETED CLEANUP for session:', sessionId);
	
	// Mark this session as manually terminated
	manuallyTerminatedSessions.add(sessionId);
	
	const process = activeProcesses.get(sessionId);
	const childPids = processTreeMap.get(sessionId) || [];
	
	// Kill all child processes first (bottom-up)
	for (const childPid of childPids) {
		try {
			debug.log('server', `💥 Killing child process: ${childPid}`);
			if (isWindows) {
				const proc = Bun.spawn(['taskkill', '/F', '/PID', childPid.toString()], {
					stdout: 'ignore',
					stderr: 'ignore'
				});
				await proc.exited;
			} else {
				const proc = Bun.spawn(['kill', '-9', childPid.toString()], {
					stdout: 'ignore',
					stderr: 'ignore'
				});
				await proc.exited;
			}
			debug.log('server', `✅ Killed child process: ${childPid}`);
		} catch (error) {
			debug.log('server', `⚠️ Failed to kill child ${childPid}:`, error);
		}
	}
	
	// Kill parent process
	if (process && process.pid) {
		try {
			debug.log('server', `💥 Killing parent process: ${process.pid}`);
			process.kill();
			debug.log('server', `✅ Killed parent process: ${process.pid}`);
		} catch (error) {
			debug.log('server', '⚠️ Failed to kill parent process:', error);
		}
	}
	
	// TARGETED: Only kill processes that belong to this specific session
	// No more nuclear killing of all npm/node processes
	debug.log('server', '🎯 Targeted cleanup completed - only session-specific processes terminated')
	
	// Clean up tracking
	activeProcesses.delete(sessionId);
	processTreeMap.delete(sessionId);
	
	debug.log('server', '🎯 TARGETED CLEANUP completed for session:', sessionId);
}

export function removeActiveProcess(sessionId: string) {
	debug.log('server', '🗑️ Removing active process for session:', sessionId);
	
	// Simple cleanup - just remove from tracking
	activeProcesses.delete(sessionId);
	processTreeMap.delete(sessionId);
}

export function getActiveProcess(sessionId: string): Subprocess | undefined {
	const process = activeProcesses.get(sessionId);
	if (process && !process.pid) {
		// Process is dead, remove it from the map
		debug.log('server', '🪦 Process for session', sessionId, 'is dead, removing from active list');
		activeProcesses.delete(sessionId);
		processTreeMap.delete(sessionId);
		return undefined;
	}
	return process;
}

export function getAllActiveProcesses(): Map<string, Subprocess> {
	return activeProcesses;
}

export function getActiveProcessCount(): number {
	return activeProcesses.size;
}

// Enhanced cleanup function with targeted options
export async function cleanupAllProcesses() {
	debug.log('server', '🎯 TARGETED CLEANUP of all tracked processes...');
	
	// Targeted cleanup for each session
	for (const sessionId of activeProcesses.keys()) {
		await nuclearProcessCleanup(sessionId);
	}
	
	// REMOVED: Global process killing - only clean up tracked processes
	debug.log('server', '🎯 All tracked processes cleaned up - no global process termination')
	
	activeProcesses.clear();
	processTreeMap.clear();
}

// Get comprehensive process status for debugging
export function getProcessStatus(sessionId: string) {
	const process = activeProcesses.get(sessionId);
	const childPids = processTreeMap.get(sessionId) || [];
	
	if (!process) {
		return { exists: false, childProcesses: [] };
	}
	
	return {
		exists: true,
		pid: process.pid,
		killed: process.killed,
		exitCode: process.exitCode,
		signalCode: process.signalCode,
		childProcesses: childPids
	};
}

// Get all tracked child processes for a session
export function getChildProcesses(sessionId: string): number[] {
	return processTreeMap.get(sessionId) || [];
}

export function wasManuallyTerminated(sessionId: string): boolean {
	return manuallyTerminatedSessions.has(sessionId);
}