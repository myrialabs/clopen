/**
 * Terminal Stream Manager
 * Manages background terminal streams and their state
 */

import type { IPty } from 'bun-pty';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';

interface TerminalStream {
  streamId: string;
  sessionId: string;
  command: string;
  pty: IPty;
  status: 'active' | 'completed' | 'error' | 'cancelled';
  startedAt: Date;
  workingDirectory?: string;
  projectPath?: string;
  projectId?: string;
  output: string[];
  processId?: number;
  outputStartIndex?: number; // Track where new output starts (for background output)
}

class TerminalStreamManager {
  private streams: Map<string, TerminalStream> = new Map();
  private sessionToStream: Map<string, string> = new Map();
  private tempDir: string = '.terminal-output-cache';

  constructor() {
    // Create temp directory for output caching
    if (!existsSync(this.tempDir)) {
      mkdirSync(this.tempDir, { recursive: true });
    }
  }
  
  /**
   * Create a new terminal stream
   */
  createStream(
    sessionId: string,
    command: string,
    pty: IPty,
    workingDirectory?: string,
    projectPath?: string,
    projectId?: string,
    predefinedStreamId?: string,
    outputStartIndex?: number
  ): string {
    // Check if there's already a stream for this session
    const existingStreamId = this.sessionToStream.get(sessionId);
    if (existingStreamId) {
      const existingStream = this.streams.get(existingStreamId);
      if (existingStream) {
        // Clean up existing stream first
        if (existingStream.pty && existingStream.pty !== pty) {
          // If it's a different PTY, kill the old one
          try {
            existingStream.pty.kill();
          } catch (error) {
            // Ignore error if PTY already killed
          }
        }
        // Remove the old stream
        this.streams.delete(existingStreamId);
      }
    }

    // Use provided streamId or generate a new one
    const streamId = predefinedStreamId || `terminal-stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const stream: TerminalStream = {
      streamId,
      sessionId,
      command,
      pty,
      status: 'active',
      startedAt: new Date(),
      workingDirectory,
      projectPath,
      projectId,
      output: [],
      processId: pty.pid,
      outputStartIndex: outputStartIndex || 0
    };

    this.streams.set(streamId, stream);
    this.sessionToStream.set(sessionId, streamId);

    return streamId;
  }
  
  /**
   * Get stream by ID
   */
  getStream(streamId: string): TerminalStream | undefined {
    return this.streams.get(streamId);
  }
  
  /**
   * Get stream by session ID
   */
  getStreamBySession(sessionId: string): TerminalStream | undefined {
    const streamId = this.sessionToStream.get(sessionId);
    if (streamId) {
      return this.streams.get(streamId);
    }
    return undefined;
  }
  
  /**
   * Add output to stream
   */
  addOutput(streamId: string, output: string): void {
    const stream = this.streams.get(streamId);
    if (stream) {
      stream.output.push(output);

      // Keep only last 2000 entries to prevent memory overflow
      if (stream.output.length > 2000) {
        stream.output = stream.output.slice(-2000);
      }

      // Also persist output to disk for background persistence
      this.persistOutputToDisk(stream);
    }
  }

  /**
   * Persist output to disk for cross-project persistence
   */
  private persistOutputToDisk(stream: TerminalStream): void {
    try {
      const cacheFile = join(this.tempDir, `${stream.sessionId}.json`);

      // Only save new output (from outputStartIndex onwards)
      // This prevents duplicating old output that was already displayed
      const newOutput = stream.outputStartIndex !== undefined
        ? stream.output.slice(stream.outputStartIndex)
        : stream.output;

      const cacheData = {
        streamId: stream.streamId,
        sessionId: stream.sessionId,
        command: stream.command,
        projectId: stream.projectId,
        projectPath: stream.projectPath,
        workingDirectory: stream.workingDirectory,
        startedAt: stream.startedAt,
        status: stream.status,
        output: newOutput, // Only save new output
        outputStartIndex: stream.outputStartIndex || 0,
        lastUpdated: new Date().toISOString()
      };
      writeFileSync(cacheFile, JSON.stringify(cacheData));
    } catch (error) {
      // Silently handle write errors
    }
  }

  /**
   * Load cached output from disk (public method for API access)
   */
  loadCachedOutput(sessionId: string): string[] | null {
    try {
      const cacheFile = join(this.tempDir, `${sessionId}.json`);
      if (existsSync(cacheFile)) {
        const data = JSON.parse(readFileSync(cacheFile, 'utf-8'));
        return data.output || [];
      }
    } catch (error) {
      // Silently handle read errors
    }
    return null;
  }
  
  /**
   * Get output from index
   */
  getOutput(streamId: string, fromIndex: number = 0): string[] {
    const stream = this.streams.get(streamId);
    if (stream) {
      return stream.output.slice(fromIndex);
    }

    // If stream not in memory, try to load from cache
    // This handles cases where server restarts or stream is cleaned from memory
    const sessionId = this.getSessionIdByStreamId(streamId);
    if (sessionId) {
      const cachedOutput = this.loadCachedOutput(sessionId);
      if (cachedOutput) {
        return cachedOutput.slice(fromIndex);
      }
    }

    return [];
  }

  /**
   * Get session ID from stream ID (helper method)
   */
  private getSessionIdByStreamId(streamId: string): string | null {
    for (const [sessionId, sid] of this.sessionToStream.entries()) {
      if (sid === streamId) {
        return sessionId;
      }
    }
    return null;
  }
  
  /**
   * Update stream status
   */
  updateStatus(streamId: string, status: TerminalStream['status']): void {
    const stream = this.streams.get(streamId);
    if (stream) {
      stream.status = status;
      
      // Clean up completed/cancelled streams after a delay
      if (status === 'completed' || status === 'cancelled' || status === 'error') {
        // Keep stream for 5 minutes for reconnection attempts
        setTimeout(() => {
          this.removeStream(streamId);
        }, 5 * 60 * 1000);
      }
    }
  }
  
  /**
   * Remove stream
   */
  removeStream(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (stream) {
      // Kill PTY if still active
      if (stream.status === 'active' && stream.pty) {
        try {
          stream.pty.kill();
        } catch (error) {
          // Silently handle error
        }
      }

      // Clean up cache file
      try {
        const cacheFile = join(this.tempDir, `${stream.sessionId}.json`);
        if (existsSync(cacheFile)) {
          unlinkSync(cacheFile);
        }
      } catch (error) {
        // Silently handle error
      }

      // Remove from maps
      this.streams.delete(streamId);
      this.sessionToStream.delete(stream.sessionId);
    }
  }
  
  /**
   * Get stream status info
   */
  getStreamStatus(streamId: string): {
    status: string;
    messagesCount: number;
    startedAt: Date;
    processId?: number;
  } | null {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return null;
    }
    
    return {
      status: stream.status,
      messagesCount: stream.output.length,
      startedAt: stream.startedAt,
      processId: stream.processId
    };
  }
  
  /**
   * Clean up all streams
   */
  cleanup(): void {
    for (const streamId of this.streams.keys()) {
      this.removeStream(streamId);
    }
  }
}

// Export singleton instance
export const terminalStreamManager = new TerminalStreamManager();