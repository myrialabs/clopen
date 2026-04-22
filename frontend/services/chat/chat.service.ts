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

import { appState, updateSessionProcessState } from '$frontend/stores/core/app.svelte';
import type { SessionProcessState } from '$frontend/stores/core/app.svelte';
import { chatModelState } from '$frontend/stores/ui/chat-model.svelte';
import { projectState } from '$frontend/stores/core/projects.svelte';
import { sessionState, setCurrentSession, createSession, updateSession } from '$frontend/stores/core/sessions.svelte';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import { userStore } from '$frontend/stores/features/user.svelte';
import type { UnifiedMessage, AssistantMessage, ReasoningMessage } from '$shared/types/unified';
import type { StreamingMessage, OptimisticUserMessage, FrontendMessage } from '$frontend/stores/core/sessions.svelte';
import { debug } from '$shared/utils/logger';

/** Chat service configuration */
interface ChatServiceOptions {
  onLoadingTextChange?: (text: string) => void;
  onStreamStart?: (processId: string) => void;
  onStreamEnd?: () => void;
  onError?: (error: Error) => void;
  attachedFiles?: { type: string; data: string; mediaType: string; fileName: string }[];
}
import ws from '$frontend/utils/ws';

/**
 * Tools that block the SDK waiting for user interaction.
 * When these tools appear in an assistant message without a result,
 * and the stream is active, the chat status switches to "waiting for input".
 * Extend this list for future interactive tools.
 */
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion']);

class ChatService {
  private activeProcessId: string | null = null;
  private streamCompleted: boolean = false;
  private currentSessionId: string | null = null;
  private lastEventSeq = new Map<string, number>(); // Sequence-based deduplication
  private cancelledProcessIds = new Set<string>(); // Track ALL cancelled streams to ignore late events
  private reconnected: boolean = false; // Whether we've reconnected to an active stream
  private cancelSafetyTimer: ReturnType<typeof setTimeout> | null = null;

  static loadingTexts: string[] = [
    'thinking', 'processing', 'analyzing', 'calculating', 'computing',
    'strategizing', 'learningpatterns', 'adaptingmodels', 'evaluatingoptions',
    'executingplans', 'simulatingscenarios', 'predictingoutcomes', 'planningactions',
    'processinginputs', 'optimizing', 'generatingresponses', 'refininglogic', 
    'validatingoutputs', 'modulatingresponse', 'updatingmemory', 'recognizingpatterns',
    'switchingcontext', 'allocatingresources', 'prioritizingtasks',
    'developingawareness', 'buildingstrategies', 'assessingscenarios',
    'bootingreasoning', 'triggeringaction', 'deployinglogic', 'synthesizinginformation',
    'maintainingstate', 'updating', 'reflecting', 'syncinglogic',
    'connectingdots', 'compilingideas', 'brainstorming', 'schedulingtasks'
  ].map(text => text + '...');

  static placeholderTexts: string[] = [
    // Creating new projects
    'Create a full-stack e-commerce platform with Next.js, Stripe, and PostgreSQL',
    'Build a real-time chat application using Socket.io with room support and typing indicators',
    'Create a SaaS dashboard with user management, billing, and analytics',
    'Build a REST API with authentication, rate limiting, and Swagger documentation',
    'Create a CLI tool in TypeScript that scaffolds new projects with custom templates',
    // Debugging & fixing
    'Debug a memory leak in a Node.js service causing it to crash every 24 hours',
    'Fix race conditions in a concurrent queue processor causing duplicate jobs',
    'Fix a CORS issue blocking requests between a frontend and backend on different origins',
    'Fix broken JWT refresh logic that logs users out unexpectedly',
    'Fix flaky tests that pass locally but fail randomly in CI',
    // Code review & refactoring
    'Refactor a 1000-line monolithic function into clean, testable modules',
    'Convert a class-based React codebase to functional components with hooks',
    'Migrate a JavaScript project to TypeScript with strict mode enabled',
    'Refactor database queries to use an ORM with proper migrations',
    'Clean up and standardize error handling across an entire Express application',
    // Writing tests
    'Write unit tests for a payment processing module with 100% coverage',
    'Add end-to-end tests using Playwright for a multi-step checkout flow',
    'Set up integration tests for a REST API using a real test database',
    'Write property-based tests to find edge cases in a data validation library',
    'Set up test coverage reporting and enforce a minimum threshold in CI',
    // Performance & optimization
    'Optimize a slow PostgreSQL query that runs 10 seconds on a 5M-row table',
    'Implement Redis caching to reduce database load by 80%',
    'Reduce bundle size of a React app from 4MB to under 500KB',
    'Profile and optimize a Python data pipeline processing 1M records per hour',
    'Add lazy loading and virtualization to a list rendering 10,000 items',
    // Architecture & design
    'Design a scalable event-driven architecture using Kafka for a high-traffic app',
    'Plan a migration from a monolith to microservices without downtime',
    'Design a multi-tenant SaaS architecture with data isolation per customer',
    'Create an authentication system supporting SSO, OAuth, and MFA',
    'Architect a real-time notification system using WebSockets and a message queue',
    // DevOps & infrastructure
    'Write a Dockerfile and docker-compose setup for a full-stack app with hot reload',
    'Set up a GitHub Actions CI/CD pipeline with testing, linting, and auto-deploy',
    'Configure Nginx as a reverse proxy with SSL termination and load balancing',
    'Create Terraform scripts to provision a production-ready AWS infrastructure',
    'Set up monitoring and alerting using Prometheus and Grafana',
    // AI & data
    'Build a RAG pipeline using LangChain, embeddings, and a vector database',
    'Create a sentiment analysis API using a fine-tuned transformer model',
    'Build a data scraper that extracts and structures product data at scale',
    'Implement a recommendation engine using collaborative filtering',
    'Create a real-time data dashboard ingesting from multiple streaming sources',
  ];

  constructor() {
    this.setupWebSocketHandlers();
  }

  /**
   * Update process state for a session.
   * Writes to both the per-session map (for multi-session support)
   * and global convenience flags (for backward-compatible single-session components).
   *
   * @param update - Partial state to merge
   * @param sessionId - Override session ID (defaults to this.currentSessionId or current session)
   */
  private setProcessState(
    update: Partial<SessionProcessState>,
    sessionId?: string | null
  ): void {
    const resolvedId = sessionId ?? this.currentSessionId ?? sessionState.currentSession?.id;
    if (resolvedId) {
      updateSessionProcessState(resolvedId, update);
    }
    // Always sync to global convenience flags
    if ('isLoading' in update) appState.isLoading = update.isLoading!;
    if ('isWaitingInput' in update) appState.isWaitingInput = update.isWaitingInput!;
    if ('isCancelling' in update) appState.isCancelling = update.isCancelling!;
    if ('isRestoring' in update) appState.isRestoring = update.isRestoring!;
    if ('error' in update && update.error !== undefined) appState.error = update.error;
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
      this.clearCancelSafetyTimer();
      this.setProcessState({ isLoading: false, isWaitingInput: false, isCancelling: false });

      // Mark any tool_use blocks that never got a tool_result
      this.markInterruptedTools();

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
      this.clearCancelSafetyTimer();
      // Don't clear isCancelling here — it causes a race with presence.
      // The chat:cancelled WS event arrives before broadcastPresence() updates,
      // so clearing isCancelling lets the presence $effect re-enable isLoading
      // (because hasActiveForSession is still true). The presence $effect will
      // clear isCancelling once the stream is actually gone from presence.
      this.setProcessState({ isLoading: false, isWaitingInput: false });

      // Mark any tool_use blocks that never got a tool_result
      this.markInterruptedTools();

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
      this.setProcessState({ isLoading: false, isWaitingInput: false, isCancelling: false });

      // Mark any tool_use blocks that never got a tool_result
      this.markInterruptedTools();

      // Don't show notification for cancel-triggered errors
      if (data.error === 'Stream cancelled') return;

      // Remove any remaining stream_event messages (streaming placeholders that won't be finalized).
      // The actual error bubble is now emitted as a chat:message from the backend and saved to DB,
      // so it persists across browser refresh. No need to inject a synthetic bubble here.
      for (let i = sessionState.messages.length - 1; i >= 0; i--) {
        if (sessionState.messages[i].type === 'stream_event') {
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
    this.streamCompleted = false;
    this.reconnected = false;
    this.currentSessionId = sessionState.currentSession.id;
    this.setProcessState({ isLoading: true, isWaitingInput: false, isCancelling: false });
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
      const contentBlocks: any[] = [];
      if (options.attachedFiles && options.attachedFiles.length > 0) {
        // Add file attachments first
        for (const file of options.attachedFiles) {
          if (file.type === 'image') {
            contentBlocks.push({
              type: 'image',
              mediaType: file.mediaType,
              data: file.data,
            });
          } else {
            contentBlocks.push({
              type: 'document',
              mediaType: file.mediaType,
              data: file.data,
              title: file.fileName,
            });
          }
        }
      }
      // Add text block
      if (userMessage) {
        contentBlocks.push({ type: 'text', text: userMessage });
      }
      const messageContent = contentBlocks.length > 0 ? contentBlocks : [{ type: 'text', text: userMessage }];

      // Determine the SDK session ID for the current branch HEAD.
      // After non-linear operations (edit/undo/restore), sessionState.messages
      // reflects the correct branch — find the last assistant/reasoning message
      // whose sessionId differs from the clopen session ID.
      const currentSessionId = sessionState.currentSession.id;
      let parentSessionId: string | null = null;
      for (let i = sessionState.messages.length - 1; i >= 0; i--) {
        const m = sessionState.messages[i];
        if ((m.type === 'assistant' || m.type === 'reasoning') && 'sessionId' in m) {
          const sid = (m as any).sessionId as string;
          if (sid && sid !== currentSessionId) {
            parentSessionId = sid;
            break;
          }
        }
      }

      // Capture selected engine/model/account before sending
      const selectedEngine = chatModelState.engine;
      const selectedProvider = chatModelState.provider;
      const selectedModelId = chatModelState.modelId;
      const selectedModelName = chatModelState.modelName;

      // Create UserMessage format for prompt
      const userMsgId = crypto.randomUUID();
      const userMsg = {
        type: 'user' as const,
        createdAt: new Date().toISOString(),
        messageId: userMsgId,
        sessionId: currentSessionId,
        parent: { messageId: null, sessionId: parentSessionId, toolUseId: null },
        engine: {
          type: selectedEngine,
          provider: selectedProvider,
          model: { id: selectedModelId, name: selectedModelName },
          account: { id: chatModelState.accountId ?? 0, name: chatModelState.accountName ?? '' },
        },
        sender: {
          id: userStore.currentUser?.id || '',
          name: userStore.currentUser?.name || '',
        },
        content: messageContent,
        synthetic: false,
      };

      // Optimistic UI: show user message immediately (before server confirms)
      const optimisticMessage: OptimisticUserMessage = {
        ...userMsg,
        optimistic: true,
        optimisticId: userMsgId,
      };
      (sessionState.messages as FrontendMessage[]).push(optimisticMessage);
      const selectedAccountId = chatModelState.accountId;
      const selectedAccountName = chatModelState.accountName;

      // Send WebSocket message to start streaming
      ws.emit('chat:stream', {
        sessionId: crypto.randomUUID(), // ephemeral session ID for this stream
        chatSessionId: sessionState.currentSession.id,
        projectPath: projectState.currentProject?.path || '',
        prompt: userMsg,
        engine: {
          type: selectedEngine,
          provider: selectedProvider,
          model: { id: selectedModelId, name: selectedModelName },
          account: { id: selectedAccountId ?? 0, name: selectedAccountName ?? '' },
        },
        sender: {
          id: userStore.currentUser?.id || '',
          name: userStore.currentUser?.name || '',
        },
      });

      // Persist engine/model/account to frontend session state immediately.
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
          provider: selectedProvider,
          model_id: selectedModelId,
          model_name: selectedModelName,
          ...(selectedAccountId !== null && { account_id: selectedAccountId }),
          ...(selectedAccountName !== null && { account_name: selectedAccountName }),
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
    // Update per-session map with captured ID (before it was nulled above)
    // and global flags — cancel sets isCancelling=true to prevent presence re-enabling
    this.setProcessState({ isLoading: false, isWaitingInput: false, isCancelling: true }, chatSessionId);

    // Convert stream_events to finalized assistant messages on cancel.
    // This preserves partial reasoning/text that was visible to the user.
    // Empty stream_events are removed. The backend saves partial text to DB
    // independently, so on refresh the DB version takes over.
    this.finalizeStreamEvents();

    // Safety timeout: if backend events (chat:cancelled + presence update) don't
    // arrive within 10 seconds, force-clear isCancelling to prevent infinite loader.
    // This catches edge cases: WS disconnect during cancel, engine.cancel() timeout,
    // or race conditions between presence update and chat:cancelled event ordering.
    this.clearCancelSafetyTimer();
    this.cancelSafetyTimer = setTimeout(() => {
      this.cancelSafetyTimer = null;
      if (appState.isCancelling) {
        debug.warn('chat', 'Cancel safety timeout: force-clearing isCancelling after 10s');
        this.setProcessState({ isCancelling: false, isLoading: false }, chatSessionId);
      }
    }, 10000);
  }

  /**
   * Clear the cancel safety timer (called when cancel completes normally)
   */
  private clearCancelSafetyTimer(): void {
    if (this.cancelSafetyTimer) {
      clearTimeout(this.cancelSafetyTimer);
      this.cancelSafetyTimer = null;
    }
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
    appState.isWaitingInput = false;
    appState.isCancelling = false;
  }

  /**
   * Merge transport metadata into a UnifiedMessage.
   * Backend sends DB-assigned fields (id, parentMessageId, etc.) alongside the message.
   */
  private enrichMessage(message: UnifiedMessage, data: any): UnifiedMessage {
    const enriched = { ...message };
    if (data.message_id) enriched.messageId = data.message_id;
    if (data.parent_message_id !== undefined) enriched.parent = { ...enriched.parent, messageId: data.parent_message_id ?? null };
    if (enriched.type === 'user' && (data.sender_id || data.sender_name)) {
      enriched.sender = { id: data.sender_id ?? '', name: data.sender_name ?? '' };
    }
    if (data.timestamp) enriched.createdAt = data.timestamp;
    return enriched;
  }

  /**
   * Handle message events from stream
   */
  private handleMessageEvent(data: any): void {
    const rawMessage = data.message as UnifiedMessage | undefined;

    // Early return if no message
    if (!rawMessage) return;

    // Ignore messages from a completed/cancelled stream
    if (this.streamCompleted) return;

    // Early return if no valid session
    if (!sessionState.currentSession?.id) {
      return;
    }

    // Enrich with transport metadata (DB id, parent, sender)
    const message = this.enrichMessage(rawMessage, data);

    // If this is a user message from server, replace the optimistic message.
    // Match by rawMessage.messageId (the frontend-provided UUID preserved in the stream event)
    // rather than message.messageId (which gets overwritten by the DB-assigned ID in enrichMessage).
    if (message.type === 'user') {
      const optimisticIndex = sessionState.messages.findIndex(
        (m) => 'optimistic' in m && m.optimistic && m.type === 'user' && (m as OptimisticUserMessage).optimisticId === rawMessage!.messageId
      );
      if (optimisticIndex !== -1) {
        sessionState.messages[optimisticIndex] = message;
        return;
      }
    }

    // If this is an assistant message, replace the matching non-reasoning
    // stream_event placeholder (leave any reasoning placeholder alone —
    // it will be replaced by its own ReasoningMessage).
    if (message.type === 'assistant') {
      for (let i = sessionState.messages.length - 1; i >= 0; i--) {
        const msg = sessionState.messages[i];
        if (msg.type === 'stream_event' && !(msg as StreamingMessage).reasoning) {
          sessionState.messages[i] = message;
          this.checkInteractiveTools(message);
          return;
        }
      }
      // No matching stream_event found, fall through to push
    }

    // If this is a reasoning message, replace the matching reasoning
    // stream_event placeholder. Fall back to inserting before the first
    // non-reasoning stream_event so the display order stays reasoning → text.
    if (message.type === 'reasoning') {
      for (let i = sessionState.messages.length - 1; i >= 0; i--) {
        const msg = sessionState.messages[i];
        if (msg.type === 'stream_event' && (msg as StreamingMessage).reasoning) {
          sessionState.messages[i] = message;
          return;
        }
      }
      const textStreamIdx = (sessionState.messages as FrontendMessage[]).findIndex(
        m => m.type === 'stream_event' && !(m as StreamingMessage).reasoning
      );
      if (textStreamIdx !== -1) {
        (sessionState.messages as FrontendMessage[]).splice(textStreamIdx, 0, message);
        return;
      }
      // No stream_event yet — fall through to dedup + push
    }

    // Deduplicate: if a message with the same messageId already exists, update it in place
    // (e.g., stopReason backfill arrives after initial assistant message was emitted)
    if (message.messageId) {
      const existingIdx = (sessionState.messages as FrontendMessage[]).findIndex(
        (m) => m.type !== 'stream_event' && 'messageId' in m && m.messageId === message.messageId && !('optimistic' in m && m.optimistic)
      );
      if (existingIdx !== -1) {
        (sessionState.messages as FrontendMessage[])[existingIdx] = message;
        return;
      }
    }

    // Detect interactive tool_use blocks (e.g., AskUserQuestion) and set waiting status
    if (message.type === 'assistant') {
      this.checkInteractiveTools(message);
    }

    // When a user message with tool_result arrives, the SDK is unblocked — clear waiting status
    if (message.type === 'user') {
      const hasToolResult = message.content.some((item) => item.type === 'tool_result');
      if (hasToolResult && appState.isWaitingInput) {
        this.setProcessState({ isWaitingInput: false });
      }
    }

    // Messages arrive from the backend in correct temporal order — just push.
    (sessionState.messages as FrontendMessage[]).push(message);
  }

  /**
   * Check for interactive tool_use blocks and set waiting status
   */
  private checkInteractiveTools(message: AssistantMessage): void {
    const hasInteractiveTool = message.content.some(
      (item) => item.type === 'tool_use' && INTERACTIVE_TOOLS.has(item.name)
    );
    if (hasInteractiveTool) {
      this.setProcessState({ isWaitingInput: true });
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

    const isReasoning = data.reasoning === true;
    const { eventType, partialText } = data;

    // Match placeholders on (processId, reasoning) so a reasoning stream and
    // a text stream within the same turn don't clobber each other's text.
    const findPlaceholder = (): StreamingMessage | undefined => {
      for (let i = sessionState.messages.length - 1; i >= 0; i--) {
        const msg = sessionState.messages[i];
        if (
          msg.type === 'stream_event' &&
          (msg as StreamingMessage).processId === data.processId &&
          !!(msg as StreamingMessage).reasoning === isReasoning
        ) {
          return msg as StreamingMessage;
        }
      }
      return undefined;
    };

    // Insert a reasoning placeholder BEFORE any existing non-reasoning
    // stream_event so the on-screen order stays reasoning → text within a
    // turn. Non-reasoning placeholders go to the end. Without this, engines
    // that emit a preliminary non-reasoning stream_start at turn boundaries
    // (e.g. OpenCode) leave a stale empty text placeholder ahead of the
    // reasoning block, which then gets claimed by the next tool message
    // and visually swaps reasoning behind the tool.
    const insertNewPlaceholder = (): void => {
      const newMessage: StreamingMessage = {
        type: 'stream_event',
        processId: data.processId,
        text: partialText || '',
        createdAt: data.timestamp || new Date().toISOString(),
        reasoning: isReasoning,
      };

      if (isReasoning) {
        const textIdx = (sessionState.messages as FrontendMessage[]).findIndex(
          (m) => m.type === 'stream_event' && !(m as StreamingMessage).reasoning
        );
        if (textIdx !== -1) {
          (sessionState.messages as FrontendMessage[]).splice(textIdx, 0, newMessage);
          return;
        }
      }
      (sessionState.messages as FrontendMessage[]).push(newMessage);
    };

    if (eventType === 'start') {
      const existing = findPlaceholder();
      if (existing) {
        existing.text = partialText || '';
        return;
      }
      insertNewPlaceholder();
    } else if (eventType === 'update') {
      const existing = findPlaceholder();
      if (existing) {
        existing.text = partialText || '';
        return;
      }
      // Fallback: missed start event
      insertNewPlaceholder();
    }
    // Note: 'end' event is not needed - stream_event is replaced by the final message in handleMessageEvent
  }

  /**
   * Remove all stream_event messages from the messages array.
   * Called on new message send to prevent stale streaming
   * placeholders from causing wrong insertion positions.
   */
  private cleanupStreamEvents(): void {
    for (let i = sessionState.messages.length - 1; i >= 0; i--) {
      if (sessionState.messages[i].type === 'stream_event') {
        sessionState.messages.splice(i, 1);
      }
    }
  }

  /**
   * Convert stream_event messages with text to finalized AssistantMessages.
   * Called on cancel to preserve partial text that was visible.
   * Empty stream_events are removed.
   * The backend saves these to DB independently, so on refresh the DB version takes over.
   */
  private finalizeStreamEvents(): void {
    for (let i = sessionState.messages.length - 1; i >= 0; i--) {
      const msg = sessionState.messages[i];
      if (msg.type !== 'stream_event') continue;

      if (!msg.text) {
        sessionState.messages.splice(i, 1);
        continue;
      }

      if (msg.reasoning) {
        sessionState.messages[i] = {
          type: 'reasoning',
          createdAt: msg.createdAt,
          messageId: crypto.randomUUID(),
          sessionId: sessionState.currentSession?.id || '',
          parent: { messageId: null, sessionId: null, toolUseId: null },
          engine: { type: 'claude-code', provider: '', model: { id: '', name: '' }, account: { id: 0, name: '' } },
          text: msg.text,
        } satisfies ReasoningMessage;
      } else {
        sessionState.messages[i] = {
          type: 'assistant',
          createdAt: msg.createdAt,
          messageId: crypto.randomUUID(),
          sessionId: sessionState.currentSession?.id || '',
          parent: { messageId: null, sessionId: null, toolUseId: null },
          engine: { type: 'claude-code', provider: '', model: { id: '', name: '' }, account: { id: 0, name: '' } },
          content: [{ type: 'text', text: msg.text }],
          stopReason: 'interrupted',
          usage: null,
        } satisfies UnifiedMessage;
      }
    }
  }

  /**
   * Detect whether any interactive tool (e.g. AskUserQuestion) is pending in the current messages.
   * Used after browser refresh / catchup to restore the isWaitingInput state.
   */
  detectPendingInteractiveTools(): void {
    if (!appState.isLoading) return;

    // Collect all tool_use IDs that have a matching tool_result
    const answeredToolIds = new Set<string>();
    for (const msg of sessionState.messages) {
      if (msg.type !== 'user' || !('content' in msg)) continue;
      for (const item of msg.content) {
        if (item.type === 'tool_result') {
          answeredToolIds.add(item.toolUseId);
        }
      }
    }

    // Check if any interactive tool is unanswered (skip interrupted blocks)
    for (const msg of sessionState.messages) {
      if (msg.type !== 'assistant' || !('content' in msg)) continue;
      const hasPendingInteractive = msg.content.some(
        (item) => item.type === 'tool_use' && !item.interrupted && INTERACTIVE_TOOLS.has(item.name) && !answeredToolIds.has(item.id)
      );
      if (hasPendingInteractive) {
        this.setProcessState({ isWaitingInput: true });
        return;
      }
    }
  }

  /**
   * Mark unanswered tool_use blocks as interrupted.
   * Sets interrupted on individual ToolUseBlock instances.
   * Called when stream ends (complete/error/cancel) for immediate in-memory update.
   * The backend persists this to DB via stream:lifecycle for durability.
   */
  private markInterruptedTools(): void {
    // Collect all tool_use IDs that have a matching tool_result
    const answeredToolIds = new Set<string>();

    for (const msg of sessionState.messages) {
      if (msg.type !== 'user' || !('content' in msg)) continue;
      for (const item of msg.content) {
        if (item.type === 'tool_result') {
          answeredToolIds.add(item.toolUseId);
        }
      }
    }

    // Mark individual tool_use blocks as interrupted
    for (const msg of sessionState.messages) {
      if (msg.type !== 'assistant' || !('content' in msg)) continue;
      for (const block of msg.content) {
        if (block.type === 'tool_use' && !answeredToolIds.has(block.id) && !block.interrupted) {
          (block as any).interrupted = true;
        }
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
