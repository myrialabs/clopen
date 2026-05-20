/**
 * Terminal Stream Manager
 * Manages background terminal streams and their state
 * Uses @xterm/headless to maintain accurate terminal state in-memory
 */

import type { IPty } from 'bun-pty';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

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
  processId?: number;
  headlessTerminal: Terminal;
  serializeAddon: SerializeAddon;
}

class TerminalStreamManager {
  private streams: Map<string, TerminalStream> = new Map();
  private sessionToStream: Map<string, string> = new Map();

  /**
   * Create a headless terminal instance with serialize addon
   */
  private createHeadlessTerminal(cols: number, rows: number): { terminal: Terminal; serializeAddon: SerializeAddon } {
    const terminal = new Terminal({
      scrollback: 5000,
      cols,
      rows,
      allowProposedApi: true
    });
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(serializeAddon);
    return { terminal, serializeAddon };
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
    terminalSize?: { cols: number; rows: number }
  ): string {
    const cols = terminalSize?.cols || 80;
    const rows = terminalSize?.rows || 24;

    // Check if there's already a stream for this session
    const existingStreamId = this.sessionToStream.get(sessionId);
    if (existingStreamId) {
      const existingStream = this.streams.get(existingStreamId);
      if (existingStream) {
        if (existingStream.pty === pty) {
          // Same PTY (reconnection) - reuse existing headless terminal as-is
          // The headless terminal already has all accumulated output
          const newStreamId = predefinedStreamId || existingStreamId;

          // Resize headless terminal if dimensions changed
          existingStream.headlessTerminal.resize(cols, rows);

          // Update stream ID if changed
          if (newStreamId !== existingStreamId) {
            this.streams.delete(existingStreamId);
            existingStream.streamId = newStreamId;
            this.streams.set(newStreamId, existingStream);
            this.sessionToStream.set(sessionId, newStreamId);
          }

          return newStreamId;
        }

        // Different PTY, kill the old one and dispose headless terminal
        if (existingStream.pty) {
          try {
            existingStream.pty.kill();
          } catch {
            // Ignore error if PTY already killed
          }
        }
        existingStream.serializeAddon.dispose();
        existingStream.headlessTerminal.dispose();
        this.streams.delete(existingStreamId);
      }
    }

    // Use provided streamId or generate a new one
    const streamId = predefinedStreamId || `terminal-stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Create headless terminal
    const { terminal: headlessTerminal, serializeAddon } = this.createHeadlessTerminal(cols, rows);

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
      processId: pty.pid,
      headlessTerminal,
      serializeAddon
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
   * Add output to stream (writes to headless terminal)
   */
  addOutput(streamId: string, output: string): void {
    const stream = this.streams.get(streamId);
    if (stream) {
      stream.headlessTerminal.write(output);
    }
  }

  /**
   * Get serialized terminal output for a stream
   */
  getSerializedOutput(streamId: string): string {
    const stream = this.streams.get(streamId);
    if (stream) {
      return stream.serializeAddon.serialize();
    }
    return '';
  }

  /**
   * Get serialized terminal output by session ID
   */
  getSerializedOutputBySession(sessionId: string): string {
    const streamId = this.sessionToStream.get(sessionId);
    if (streamId) {
      return this.getSerializedOutput(streamId);
    }
    return '';
  }

  /**
   * Clear headless terminal buffer (sync with frontend clear)
   */
  clearHeadlessTerminal(sessionId: string): void {
    const streamId = this.sessionToStream.get(sessionId);
    if (streamId) {
      const stream = this.streams.get(streamId);
      if (stream) {
        stream.headlessTerminal.clear();
      }
    }
  }

  /**
   * Resize headless terminal to match PTY dimensions
   */
  resizeHeadlessTerminal(sessionId: string, cols: number, rows: number): void {
    const streamId = this.sessionToStream.get(sessionId);
    if (streamId) {
      const stream = this.streams.get(streamId);
      if (stream) {
        stream.headlessTerminal.resize(cols, rows);
      }
    }
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
   * Remove stream and dispose headless terminal
   */
  removeStream(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (stream) {
      // Kill PTY if still active
      if (stream.status === 'active' && stream.pty) {
        try {
          stream.pty.kill();
        } catch {
          // Silently handle error
        }
      }

      // Dispose headless terminal
      stream.serializeAddon.dispose();
      stream.headlessTerminal.dispose();

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
    bufferLength: number;
    startedAt: Date;
    processId?: number;
  } | null {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return null;
    }

    return {
      status: stream.status,
      bufferLength: stream.headlessTerminal.buffer.active.length,
      startedAt: stream.startedAt,
      processId: stream.processId
    };
  }

  /**
   * Clean up terminal streams for a specific project
   */
  cleanupProjectStreams(projectId: string): number {
    let cleaned = 0;

    for (const [streamId, stream] of this.streams) {
      if (stream.projectId === projectId) {
        if (stream.status === 'active' && stream.pty) {
          try { stream.pty.kill(); } catch {}
        }
        stream.serializeAddon.dispose();
        stream.headlessTerminal.dispose();
        this.streams.delete(streamId);
        this.sessionToStream.delete(stream.sessionId);
        cleaned++;
      }
    }

    return cleaned;
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
