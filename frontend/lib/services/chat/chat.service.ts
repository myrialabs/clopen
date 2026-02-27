/**
 * WebSocket-based Chat Service
 *
 * Modern WebSocket implementation for real-time chat communication
 * Replaces the old SSE-based chat service
 *
 * Key features:
 * - Sequence-based deduplication to prevent duplicate messages
 * - Stream reconnection after browser refresh / project switch
 * - Robust cancel that works even after refresh
 * - Proper presence synchronization
 */

import { appState } from '$frontend/lib/stores/core/app.svelte';
import { chatModelState } from '$frontend/lib/stores/ui/chat-model.svelte';
import { projectState } from '$frontend/lib/stores/core/projects.svelte';
import { sessionState, setCurrentSession, createSession, updateSession } from '$frontend/lib/stores/core/sessions.svelte';
import { addNotification } from '$frontend/lib/stores/ui/notification.svelte';
import { userStore } from '$frontend/lib/stores/features/user.svelte';
import { SDK_CONFIG, parseModelId } from '$shared/constants/engines';
import type { ChatServiceOptions } from '$shared/types/messaging';
import { buildMetadataFromTransport } from '$shared/utils/message-formatter';
import { debug } from '$shared/utils/logger';
import ws from '$frontend/lib/utils/ws';

class ChatService {
  private activeProcessId: string | null = null;
  private streamCompleted: boolean = false;
  private currentSessionId: string | null = null;
  private lastEventSeq = new Map<string, number>(); // Sequence-based deduplication
  private cancelledProcessIds = new Set<string>(); // Track ALL cancelled streams to ignore late events
  private reconnected: boolean = false; // Whether we've reconnected to an active stream

  static loadingTexts: string[] = [
    'thinking', 'processing', 'analyzing', 'calculating', 'computing',
    'strategizing', 'learningpatterns', 'updatingweights', 'finetuning',
    'adaptingmodels', 'trainingnetworks', 'evaluatingoptions', 'planningactions',
    'executingplans', 'simulatingscenarios', 'predictingoutcomes', 'scanningenvironment',
    'monitoringsignals', 'processinginputs', 'adjustingparameters', 'optimizing',
    'generatingresponses', 'refininglogic', 'recognizingpatterns', 'synthesizinginformation',
    'runninginference', 'validatingoutputs', 'modulatingresponse', 'updatingmemory',
    'switchingcontext', 'resolvingconflicts', 'allocatingresources', 'prioritizingtasks',
    'developingawareness', 'buildingstrategies', 'assessingscenarios', 'integratingdata',
    'bootingreasoning', 'activatingmodules', 'triggeringaction', 'deployinglogic',
    'maintainingstate', 'clearingcache', 'updating', 'reflecting', 'syncinglogic',
    'connectingdots', 'compilingideas', 'brainstorming', 'schedulingtasks'
  ].map(text => text + '...');

  static placeholderTexts: string[] = [
    // Creating new projects
    'Create a full-stack e-commerce platform with Next.js, Stripe, and PostgreSQL',
    'Build a real-time chat application using Socket.io with room support and typing indicators',
    'Create a SaaS dashboard with user management, billing, and analytics',
    // ... (keep the same placeholder texts as before)
  ];

  constructor() {
    this.setupWebSocketHandlers();
  }

  /**
   * Check if event should be skipped (sequence-based deduplication)
   */
  private shouldSkipEvent(processId: string, seq: number | undefined): boolean {
    if (seq === undefined || seq === null) return false;

    const lastSeq = this.lastEventSeq.get(processId) || 0;
    if (seq <= lastSeq) {
      // Skip duplicate
      return true;
    }

    this.lastEventSeq.set(processId, seq);
    return false;
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupWebSocketHandlers(): void {
    // Session available event - reset stream state if we were streaming from the old session.
    // With session-scoped routing, this is mostly a safety measure.
    ws.on('sessions:session-available', () => {
      // No-op: with chat session rooms, events are already scoped.
      // Users stay in their current session until they explicitly switch.
    });

    // Connection event - received by ALL users in the project
    ws.on('chat:connection', (data) => {
      if (this.shouldSkipEvent(data.processId, data.seq)) return;
      // Ignore events from a locally cancelled stream
      if (data.processId && this.cancelledProcessIds.has(data.processId)) return;

      this.activeProcessId = data.processId;
      this.streamCompleted = false;
    });

    // Message event
    ws.on('chat:message', (data) => {
      if (this.shouldSkipEvent(data.processId, data.seq)) return;
      // Ignore events from a locally cancelled stream
      if (data.processId && this.cancelledProcessIds.has(data.processId)) return;

      this.handleMessageEvent(data);
    });

    // Partial message event (streaming)
    ws.on('chat:partial', (data) => {
      if (this.shouldSkipEvent(data.processId, data.seq)) return;
      // Ignore events from a locally cancelled stream
      if (data.processId && this.cancelledProcessIds.has(data.processId)) return;

      this.handlePartialEvent(data);
    });

    // Notification event
    ws.on('chat:notification', (data) => {
      // Notifications don't have processId, use a global key
      if (this.shouldSkipEvent('notification', data.seq)) return;

      if (data.notification) {
        const notif = data.notification;
        addNotification({
          type: notif.type as any,
          title: notif.title,
          message: notif.message,
          duration: notif.type === 'warning' ? 7000 : 5000
        });
      }
    });

    // Complete event
    ws.on('chat:complete', async (data) => {
      if (this.shouldSkipEvent(data.processId, data.seq)) return;
      // Ignore late events from a locally cancelled stream
      if (data.processId && this.cancelledProcessIds.has(data.processId)) return;

      this.streamCompleted = true;
      this.reconnected = false;
      appState.isLoading = false;
      appState.isCancelling = false;

      // Stream completed successfully — all old cancelled streams' events
      // have definitely been delivered by now, so clear the blacklist.
      this.cancelledProcessIds.clear();

      // Don't reload messages - they're already added via chat:message events
      // Reloading would cause duplicates

      // Notifications handled by GlobalStreamMonitor via chat:stream-finished
    });

    // Cancelled event - broadcast to ALL collaborators when any user cancels
    ws.on('chat:cancelled', async (data) => {
      // Track the cancelled processId so late-arriving events are blocked.
      // This handles the case where a collaborator initiated the cancel
      // (so our local cancelRequest was not called).
      if (data.processId) {
        this.cancelledProcessIds.add(data.processId);
      }
      this.streamCompleted = true;
      this.reconnected = false;
      this.activeProcessId = null;
      appState.isLoading = false;
      appState.isCancelling = false;

      // Notifications handled by GlobalStreamMonitor via chat:stream-finished
    });

    // Error event
    ws.on('chat:error', async (data) => {
      if (this.shouldSkipEvent(data.processId, data.seq)) return;
      if (this.streamCompleted) return;
      // Ignore late error events from a locally cancelled stream
      if (data.processId && this.cancelledProcessIds.has(data.processId)) return;

      // Mark completed immediately to block any duplicate error events that may arrive
      // (e.g. from multiple subscriptions or late-arriving events with different processId/seq)
      this.streamCompleted = true;
      this.reconnected = false;
      appState.isLoading = false;
      appState.isCancelling = false;

      // Don't show notification for cancel-triggered errors
      if (data.error === 'Stream cancelled') return;

      // Remove any remaining stream_event messages (streaming placeholders that won't be finalized).
      // The actual error bubble is now emitted as a chat:message from the backend and saved to DB,
      // so it persists across browser refresh. No need to inject a synthetic bubble here.
      for (let i = sessionState.messages.length - 1; i >= 0; i--) {
        const msg = sessionState.messages[i] as any;
        if (msg.type === 'stream_event') {
          sessionState.messages.splice(i, 1);
        }
      }

      addNotification({
        type: 'error',
        title: 'AI Engine Error',
        message: data.error,
        duration: 5000
      });
    });
  }

  /**
   * Reconnect to an active stream after browser refresh or project switch.
   * This re-subscribes the connection to receive live stream events.
   * Called from catchupActiveStream in ChatInput.
   */
  reconnectToStream(chatSessionId: string, processId: string): void {
    debug.log('chat', 'Reconnecting to active stream:', { chatSessionId, processId });

    // Set up local state so events are processed and cancel works
    this.activeProcessId = processId;
    this.currentSessionId = chatSessionId;
    this.streamCompleted = false;
    this.cancelledProcessIds.clear();
    this.reconnected = true;

    // Tell backend to re-subscribe this connection to the stream
    ws.emit('chat:reconnect', {
      chatSessionId
    });
  }

  /**
   * Send a message using WebSocket
   */
  async sendMessage(
    message: string,
    options: ChatServiceOptions = {}
  ): Promise<void> {
    if ((!message.trim() && !options.attachedFiles?.length) || appState.isLoading) return;

    // Check if project is selected
    if (!projectState.currentProject) {
      addNotification({
        type: 'warning',
        title: 'No Project Selected',
        message: 'Please select a project from the sidebar before sending messages',
        duration: 3000
      });
      return;
    }

    const userMessage = message.trim();

    // Create a new session if none exists
    if (!sessionState.currentSession) {
      const newSession = await createSession(
        projectState.currentProject.id,
        'New Chat Session'
      );
      if (newSession) {
        await setCurrentSession(newSession);
      } else {
        addNotification({
          type: 'error',
          title: 'Session Creation Failed',
          message: 'Failed to create chat session. Please try again.',
          duration: 5000
        });
        return;
      }
    }

    // Ensure we have a valid session before proceeding
    if (!sessionState.currentSession?.id) {
      addNotification({
        type: 'error',
        title: 'No Valid Session',
        message: 'No valid chat session available. Please refresh and try again.',
        duration: 5000
      });
      return;
    }

    // Set loading state
    appState.isLoading = true;
    appState.isCancelling = false;
    this.streamCompleted = false;
    this.reconnected = false;
    this.currentSessionId = sessionState.currentSession.id;
    // DON'T clear cancelledProcessIds — late events from previously cancelled
    // streams must still be blocked. The set is cleared on stream complete.
    // Clear sequence tracking for new stream
    this.lastEventSeq.clear();

    // Clean up stale stream_events from any previous cancelled streams.
    // These linger because cancel doesn't remove them, and they cause
    // wrong insertion positions for new reasoning/text streams.
    this.cleanupStreamEvents();

    try {
      // Build message content (text + optional file attachments)
      let messageContent: any = userMessage;
      if (options.attachedFiles && options.attachedFiles.length > 0) {
        const contentBlocks: any[] = [];
        // Add file attachments first
        for (const file of options.attachedFiles) {
          if (file.type === 'image') {
            contentBlocks.push({
              type: 'image',
              source: { type: 'base64', media_type: file.mediaType, data: file.data }
            });
          } else {
            contentBlocks.push({
              type: 'document',
              source: { type: 'base64', media_type: file.mediaType, data: file.data },
              title: file.fileName
            });
          }
        }
        // Add text block
        if (userMessage) {
          contentBlocks.push({ type: 'text', text: userMessage });
        }
        messageContent = contentBlocks;
      }

      // Create SDKUserMessage format for prompt
      const sdkUserMessage = {
        type: 'user' as const,
        uuid: crypto.randomUUID(),
        session_id: sessionState.currentSession.id,
        parent_tool_use_id: null,
        message: {
          role: 'user' as const,
          content: messageContent
        }
      };

      // Optimistic UI: show user message immediately (before server confirms)
      const optimisticMessage = {
        ...sdkUserMessage,
        _optimistic: true,
        metadata: buildMetadataFromTransport({
          timestamp: new Date().toISOString(),
          sender_id: userStore.currentUser?.id || null,
          sender_name: userStore.currentUser?.name || null,
        })
      };
      (sessionState.messages as any[]).push(optimisticMessage);

      // Parse engine and model from the local chat model state (isolated from Settings)
      const { engine, modelId } = parseModelId(chatModelState.model);

      // Capture selected engine/model/account before sending
      const selectedEngine = chatModelState.engine || engine;
      const selectedModel = chatModelState.model;
      const selectedAccountId = chatModelState.claudeAccountId;

      // Send WebSocket message to start streaming
      ws.emit('chat:stream', {
        sessionId: crypto.randomUUID(), // ephemeral session ID for this stream
        chatSessionId: sessionState.currentSession.id,
        projectPath: projectState.currentProject?.path || '',
        prompt: sdkUserMessage,
        messages: sessionState.messages.filter((msg: any) => !msg._optimistic).map(msg => {
          // Convert SDKMessage to API format
          if (msg.type === 'user' && 'message' in msg) {
            return {
              role: msg.message.role,
              content: typeof msg.message.content === 'string' ? msg.message.content : JSON.stringify(msg.message.content)
            };
          } else if (msg.type === 'assistant' && 'message' in msg) {
            return {
              role: msg.message.role,
              content: Array.isArray(msg.message.content)
                ? msg.message.content.map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join(' ')
                : JSON.stringify(msg.message.content)
            };
          }
          return {
            role: 'assistant',
            content: ''
          };
        }).filter(msg => msg.content),
        engine: selectedEngine,
        model: modelId,
        temperature: SDK_CONFIG.DEFAULT_TEMPERATURE,
        senderId: userStore.currentUser?.id,
        senderName: userStore.currentUser?.name,
        ...(selectedEngine === 'claude-code' && selectedAccountId !== null && { claudeAccountId: selectedAccountId }),
      });

      // Persist engine/model to frontend session state immediately.
      // Backend also saves to DB (for refresh/project-switch restore),
      // but we update the frontend state here so the $effect in
      // EngineModelPicker can see it without a server round-trip.
      // IMPORTANT: Use updateSession() to update BOTH sessionState.currentSession
      // AND sessionState.sessions[] array. A direct spread on currentSession
      // creates a new object, leaving sessions[] stale — causing the model
      // picker to lose the selection when switching projects and back.
      if (sessionState.currentSession) {
        updateSession({
          ...sessionState.currentSession,
          engine: selectedEngine,
          model: selectedModel,
          ...(selectedEngine === 'claude-code' && selectedAccountId !== null && { claude_account_id: selectedAccountId }),
        });
      }

    } catch (error) {
      this.handleError(error as Error, options);
    }
  }

  /**
   * Cancel the current request - works for ANY collaborator, not just the sender
   * Also works after browser refresh since it uses sessionState as fallback
   */
  cancelRequest(): void {
    // Use currentSessionId (set by sender) OR sessionState (available to all collaborators)
    const chatSessionId = this.currentSessionId || sessionState.currentSession?.id;

    if (chatSessionId) {
      ws.emit('chat:cancel', {
        sessionId: crypto.randomUUID(),
        chatSessionId
      });
    }

    // Track cancelled processId so late-arriving events are ignored.
    // Use a Set to track ALL cancelled streams (not just the last one),
    // preventing late events from any previously cancelled stream from leaking through.
    if (this.activeProcessId) {
      this.cancelledProcessIds.add(this.activeProcessId);
    }
    this.activeProcessId = null;
    this.currentSessionId = null;
    this.streamCompleted = true;
    this.reconnected = false;
    appState.isLoading = false;
    // Prevent presence effect from re-enabling loading before server confirms cancel
    appState.isCancelling = true;

    // Clean up stale stream_events from the cancelled stream.
    // Without this, stale stream_events remain in the messages array and cause
    // wrong insertion positions when a new stream starts (e.g., reasoning inserted
    // before a stale non-reasoning stream_event instead of at the end).
    this.cleanupStreamEvents();

    // Safety timeout: clear isCancelling after 10s if WS confirmation never arrives
    // (e.g., network issues, dropped connection)
    setTimeout(() => {
      if (appState.isCancelling) {
        appState.isCancelling = false;
      }
    }, 10000);
  }

  /**
   * Reset stream state when switching sessions (e.g. collaborator receiving new-chat).
   * Blocks all stale events from the old stream.
   */
  resetForSessionSwitch(): void {
    if (this.activeProcessId) {
      this.cancelledProcessIds.add(this.activeProcessId);
    }
    this.activeProcessId = null;
    this.currentSessionId = null;
    this.streamCompleted = true;
    this.reconnected = false;
    this.lastEventSeq.clear();
    appState.isLoading = false;
    appState.isCancelling = false;
  }

  /**
   * Handle message events from stream
   */
  private handleMessageEvent(data: any): void {
    const sdkMessage = data.message;

    // Early return if no message
    if (!sdkMessage) return;

    // Ignore messages from a completed/cancelled stream
    if (this.streamCompleted) return;

    // Early return if no valid session
    if (!sessionState.currentSession?.id) {
      return;
    }

    // If this is a user message from server, replace the optimistic message
    if (sdkMessage.type === 'user' && sdkMessage.message?.role === 'user') {
      const optimisticIndex = sessionState.messages.findIndex(
        (m: any) => m._optimistic && m.type === 'user' && m.uuid === sdkMessage.uuid
      );
      if (optimisticIndex !== -1) {
        // Replace optimistic with server-confirmed message
        const confirmedMessage = {
          ...sdkMessage,
          metadata: buildMetadataFromTransport(data)
        };
        sessionState.messages[optimisticIndex] = confirmedMessage;
        return;
      }
    }

    // If this is an assistant message, replace the matching streaming message
    if (sdkMessage.message?.role === 'assistant') {
      const isReasoning = sdkMessage.metadata?.reasoning === true;
      if (isReasoning) {
        // Replace reasoning stream_event IN PLACE to preserve message order
        for (let i = sessionState.messages.length - 1; i >= 0; i--) {
          const msg = sessionState.messages[i] as any;
          if (msg.type === 'stream_event' && msg.metadata?.reasoning) {
            const messageFormatter = {
              ...sdkMessage,
              metadata: buildMetadataFromTransport({ ...data, reasoning: true })
            };
            sessionState.messages[i] = messageFormatter;
            return; // Already replaced in-place, skip push below
          }
        }
        // If no reasoning stream_event found, fall through to push at end
      } else {
        // Remove ALL regular (non-reasoning) stream_events, not just the last one
        // This prevents stale stream_events from remaining when message order varies
        for (let i = sessionState.messages.length - 1; i >= 0; i--) {
          const msg = sessionState.messages[i] as any;
          if (msg.type === 'stream_event' && !msg.metadata?.reasoning) {
            sessionState.messages.splice(i, 1);
            break; // Only remove the most recent one
          }
        }
      }
    }

    // Deduplicate: skip if a message with the same uuid already exists
    if (sdkMessage.uuid) {
      const alreadyExists = sessionState.messages.some(
        (m: any) => m.uuid === sdkMessage.uuid && m.type === sdkMessage.type && !m._optimistic
      );
      if (alreadyExists) return;
    }

    // Update UI state (message already saved to DB by server)
    const isReasoning = sdkMessage.metadata?.reasoning === true;
    const messageFormatter = {
      ...sdkMessage,
      metadata: buildMetadataFromTransport({
        ...data,
        ...(isReasoning && { reasoning: true }),
      })
    };

    // For reasoning messages that couldn't find a matching stream_event,
    // insert BEFORE trailing non-reasoning assistant messages (tools/text)
    // to preserve reasoning-before-tool ordering within the same turn.
    if (isReasoning) {
      let insertIdx = sessionState.messages.length;
      for (let i = sessionState.messages.length - 1; i >= 0; i--) {
        const msg = sessionState.messages[i] as any;
        // Stop at user messages or other reasoning messages — they mark turn boundaries
        if (msg.type === 'user' || (msg.type === 'assistant' && msg.metadata?.reasoning)) break;
        // Insert before non-reasoning assistant messages and non-reasoning stream_events
        if (msg.type === 'assistant' || (msg.type === 'stream_event' && !msg.metadata?.reasoning)) {
          insertIdx = i;
        }
      }
      (sessionState.messages as any[]).splice(insertIdx, 0, messageFormatter);
    } else {
      (sessionState.messages as any[]).push(messageFormatter);
    }
  }

  /**
   * Handle partial message events (streaming)
   */
  private handlePartialEvent(data: any): void {
    // Ignore partials from a completed/cancelled stream
    if (this.streamCompleted) return;

    // Early return if no valid session
    if (!sessionState.currentSession?.id) {
      return;
    }

    const { eventType, partialText } = data;
    const isReasoning = data.reasoning === true;

    if (eventType === 'start') {
      if (isReasoning) {
        // Check if there's already a reasoning stream_event (from catchup)
        const existingReasoning = sessionState.messages.find(
          (m: any) => m.type === 'stream_event' && m.metadata?.reasoning && m.processId === data.processId
        );
        if (existingReasoning) {
          // Already have one, just update it
          (existingReasoning as any).partialText = partialText || '';
          return;
        }
      } else {
        // Check if there's already a regular stream_event for this process (from catchup)
        const existingStream = sessionState.messages.find(
          (m: any) => m.type === 'stream_event' && !m.metadata?.reasoning && m.processId === data.processId
        );
        if (existingStream) {
          // Already have one, just update it
          (existingStream as any).partialText = partialText || '';
          return;
        }
      }

      // Create new streaming message (reasoning or text)
      const streamingMessage = {
        type: 'stream_event' as const,
        processId: data.processId,
        partialText: partialText || '',
        metadata: buildMetadataFromTransport({
          timestamp: data.timestamp,
          ...(isReasoning && { reasoning: true }),
        })
      };

      if (isReasoning) {
        // Insert reasoning stream BEFORE any existing non-reasoning stream_event
        // to preserve logical order (reasoning comes before text in the model's output)
        const textStreamIdx = (sessionState.messages as any[]).findIndex(
          (m: any) => m.type === 'stream_event' && !m.metadata?.reasoning
        );
        if (textStreamIdx >= 0) {
          (sessionState.messages as any[]).splice(textStreamIdx, 0, streamingMessage);
        } else {
          (sessionState.messages as any[]).push(streamingMessage);
        }
      } else {
        // Text stream always goes to the end (after any reasoning)
        (sessionState.messages as any[]).push(streamingMessage);
      }
    } else if (eventType === 'update') {
      if (isReasoning) {
        // Update reasoning streaming message — find last reasoning stream_event
        for (let i = sessionState.messages.length - 1; i >= 0; i--) {
          const msg = sessionState.messages[i] as any;
          if (msg.type === 'stream_event' && msg.metadata?.reasoning) {
            msg.partialText = partialText || '';
            break;
          }
        }
      } else {
        // Update regular text streaming message — find matching stream_event
        // Search backwards to find the most recent non-reasoning stream_event
        for (let i = sessionState.messages.length - 1; i >= 0; i--) {
          const msg = sessionState.messages[i] as any;
          if (msg.type === 'stream_event' && !msg.metadata?.reasoning) {
            msg.partialText = partialText || '';
            break;
          }
        }
      }
    }
    // Note: 'end' event is not needed - streaming message will be replaced by final message in handleMessageEvent
  }

  /**
   * Remove all stream_event messages from the messages array.
   * Called on cancel and new message send to prevent stale streaming
   * placeholders from causing wrong insertion positions.
   */
  private cleanupStreamEvents(): void {
    for (let i = sessionState.messages.length - 1; i >= 0; i--) {
      if ((sessionState.messages[i] as any).type === 'stream_event') {
        sessionState.messages.splice(i, 1);
      }
    }
  }

  /**
   * Handle general errors
   */
  private handleError(
    error: Error,
    options: ChatServiceOptions
  ): void {
    let errorMessage = 'Failed to connect to AI engine';
    if (error.message.includes('Project path')) {
      errorMessage = error.message;
    } else {
      errorMessage = error.message;
    }

    addNotification({
      type: 'error',
      title: 'Chat Error',
      message: errorMessage,
      duration: 5000
    });

    options.onError?.(error);
    appState.isLoading = false;
  }
}

// Export singleton instance
export const chatService = new ChatService();

// Export class for static methods
export { ChatService };
