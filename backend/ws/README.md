# WebSocket API

Type-safe WebSocket API for real-time communication between frontend and backend. Handles both request-response (HTTP-style) and real-time event streaming patterns.

## 📚 Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Creating WebSocket Handlers](#creating-websocket-handlers)
- [Patterns](#patterns)
- [API Reference](#api-reference)
- [Examples](#examples)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## Overview

**What is WebSocket API?**
Type-safe WebSocket communication system with two distinct patterns: HTTP-style request-response and real-time event streaming.

**Features:**
- Type-safe with TypeScript
- Auto-validation with TypeBox
- Dual pattern support (HTTP + Events)
- Scope-based event filtering (user, project, global)
- Auto-wrap response format
- Router-based modular architecture
- **Consistent API**: `.emit()` for sending, `.on()` for listening (both frontend & backend)

**API Naming Consistency:**
```typescript
// Frontend
ws.emit('action', data)      // Send action to server
ws.on('event', handler)      // Listen to events from server

// Backend
.on('action', handler)       // Listen to actions from client
.emit('event', schema)       // Declare events to send to client
ws.emit.user()               // Emit event to specific user
ws.emit.project()            // Emit event to project room (current viewers)
ws.emit.projectMembers()     // Emit event to all users who have the project
ws.emit.global()             // Emit event to all users
```

**Why `.emit()` everywhere?**
- Consistent: "emit" always means "send something"
- Clear: "on" always means "listen to something"
- Symmetric: Frontend and backend use same terminology

---

## Quick Start

### 1. Create a New Module

Create a new folder in `./` (e.g., `todo/`) and create handlers:

**File: `./todo/crud.ts`**
```typescript
import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';

export const crudHandler = createRouter()
  // HTTP-style request-response
  .http('todo:create', {
    data: t.Object({
      title: t.String(),
      description: t.Optional(t.String())
    }),
    response: t.Object({
      id: t.String(),
      title: t.String(),
      description: t.String(),
      createdAt: t.String()
    })
  }, async ({ data }) => {
    // Business logic
    const todo = await createTodo(data);
    return todo; // Direct return, no manual wrapping
  })

  // Real-time event listener
  .on('todo:mark-complete', {
    data: t.Object({
      id: t.String()
    })
  }, async ({ data, conn }) => {
    const todo = await markComplete(data.id);

    // Emit event to all users in project
    const projectId = ws.getProjectId(conn);
    ws.emit.project(projectId, 'todo:completed', {
      id: todo.id,
      completedAt: new Date().toISOString()
    });
  })

  // Event declarations (Server → Client)
  .emit('todo:completed', t.Object({
    id: t.String(),
    completedAt: t.String()
  }));
```

**File: `./todo/index.ts`**
```typescript
import { createRouter } from '$shared/utils/ws-server';
import { crudHandler } from './crud';

export const todoRouter = createRouter()
  .merge(crudHandler);
```

### 2. Register the Module

Add to `./index.ts`:

```typescript
import { todoRouter } from './todo';

export const wsRouter = createRouter()
  // ... existing routers
  .merge(todoRouter);
```

### 3. Use in Frontend

```typescript
import ws from '$lib/utils/ws';

// HTTP-style request-response
try {
  const todo = await ws.http('todo:create', {
    title: 'Buy milk',
    description: 'Get 2 liters'
  });
  console.log('Created:', todo.id); // Type-safe access
} catch (error) {
  console.error('Failed:', error.message);
}

// Real-time event listener
const cleanup = ws.on('todo:completed', (data) => {
  console.log('Todo completed:', data.id);
  updateUI(data);
});

// Emit action (no response expected)
ws.emit('todo:mark-complete', { id: 'todo-123' });

// Cleanup when component unmounts
cleanup();
```

### 4. Done!

HTTP endpoint available as: `todo:create`
Event listener available as: `todo:mark-complete` (frontend emits this)
Event emission available as: `todo:completed` (backend emits this)

---

## Architecture

```
backend/ws/
├── index.ts              # Main router - merges all module routers
├── types.ts              # Shared types
├── chat/                 # Chat module
│   ├── index.ts          # Module router
│   ├── stream.ts         # Streaming events
│   └── background.ts     # Background processing
├── terminal/             # Terminal module
│   ├── index.ts          # Module router
│   ├── session.ts        # Session management (HTTP)
│   ├── stream.ts         # Real-time I/O (Events)
│   └── persistence.ts    # Stream persistence
├── files/                # File operations module
│   ├── index.ts          # Module router
│   ├── read.ts           # Read operations (HTTP)
│   ├── write.ts          # Write operations (HTTP)
│   └── search.ts         # Search operations (HTTP)
├── preview/              # Browser preview module
│   └── browser/
│       ├── tab.ts        # Tab management (HTTP)
│       ├── interact.ts   # User interactions (Events)
│       ├── webcodecs.ts  # Video streaming (Events)
│       └── ...
└── ... (other modules)
```

### Module Organization

**Simple modules** (1-2 files):
```
module/
├── index.ts    # All handlers here
└── ...
```

**Complex modules** (multiple concerns):
```
module/
├── index.ts       # Module router
├── crud.ts        # CRUD operations (HTTP)
├── stream.ts      # Real-time events
└── helpers.ts     # Shared utilities
```

### Data Flow

```
1. Handler Definition (module/handler.ts)
   └─> createRouter() with .http() or .on()
        ↓
2. Module Router (module/index.ts)
   └─> Merge handlers into module router
        ↓
3. Main Router (index.ts)
   └─> Merge all module routers
        ↓
4. Frontend (ws.http() or ws.on())
   └─> Type-safe API calls
        ↓
5. Auto-validation & processing
        ↓
6. Response (HTTP) or Event emission
```

### Key Components

**`createRouter()`**
Factory function to create type-safe WebSocket routers.

**`.http(action, config, handler)`**
Define HTTP-style request-response endpoints.

**`.on(action, config, handler)`**
Define event listeners (Client → Server actions).

**`.emit(event, schema)`**
Declare events (Server → Client notifications).

**`ws.emit.user()` / `ws.emit.project()` / `ws.emit.projectMembers()` / `ws.emit.global()`**
Emit events with scope-based filtering.

---

## Creating WebSocket Handlers

### File Structure

Each module should be in its own folder under `./`:

1. **Create a folder**: `./your-module/`
2. **Create handler files**: Split by concern (crud.ts, stream.ts, etc.)
3. **Create index.ts**: Module router that merges handlers

Example:
```
your-module/
├── index.ts       # Module router
├── crud.ts        # CRUD operations
└── stream.ts      # Real-time events
```

### Handler Types

There are three types of handlers:

#### 1. HTTP-style Request-Response (`.http()`)

Use when you need to get data back from the server.

```typescript
.http('namespace:action', {
  data: t.Object({
    param: t.String()
  }),
  response: t.Object({
    field1: t.String(),
    field2: t.Number()
  })
}, async ({ data }) => {
  // Business logic
  const result = await doSomething(data.param);
  return result; // Direct return
})
```

**Rules:**
- Response schema ONLY contains data fields
- NO `success`, `error` fields in schema
- Handler returns data directly
- Handler throws error if failed
- Server auto-wraps with `{ success, data?, error? }`

#### 2. Event Listener (`.on()`)

Use when client sends an action without expecting a response.

```typescript
.on('namespace:action', {
  data: t.Object({
    param: t.String()
  })
}, async ({ data, conn }) => {
  // Process action
  await doSomething(data.param);

  // Optionally emit events
  const projectId = ws.getProjectId(conn);
  ws.emit.project(projectId, 'namespace:updated', {
    message: 'Update complete'
  });
})
```

**Rules:**
- Use for actions that don't need response
- Can emit events to notify clients
- Access WebSocket connection via `conn`
- Get identity from connection context: `ws.getProjectId(conn)`, `ws.getUserId(conn)`

#### 3. Event Declaration (`.emit()`)

Declare events that server can emit to clients.

```typescript
.emit('namespace:event', t.Object({
  field1: t.String(),
  field2: t.Number()
}))
```

**Rules:**
- Direct schema (NOT wrapped)
- Declare in ALL files that emit this event
- Match actual emission in handlers

### Input Schema (TypeBox)

Define schema as TypeBox objects:

```typescript
data: t.Object({
  // Required string
  name: t.String(),

  // Required number with constraints
  age: t.Number({ minimum: 0, maximum: 150 }),

  // Optional with default
  format: t.Optional(t.String()),

  // Literal union (enum-like)
  type: t.Union([
    t.Literal('file'),
    t.Literal('directory')
  ]),

  // Array
  tags: t.Array(t.String()),

  // Nested object
  metadata: t.Object({
    author: t.String(),
    date: t.String()
  })
})
```

### Handler Function

The handler receives validated arguments:

```typescript
// HTTP handler
async ({ data }) => {
  try {
    const result = await someOperation(data);
    return result; // Direct return
  } catch (error) {
    throw new Error('Operation failed'); // Throw on error
  }
}

// Event handler
async ({ data, conn }) => {
  const projectId = ws.getProjectId(conn);

  // Process action
  await doSomething(data);

  // Emit events
  ws.emit.project(projectId, 'namespace:event', {
    message: 'Done'
  });
}
```

### Return Format

**HTTP handlers:**
```typescript
// Success: return data directly
return { field1: 'value', field2: 123 };

// Error: throw Error
throw new Error('Something went wrong');
```

**Event handlers:**
```typescript
// No return value needed
// Use ws.emit() to notify clients
```

---

## Patterns

### Pattern 1: HTTP Request-Response

**Backend:**
```typescript
.http('files:read-file', {
  data: t.Object({
    file_path: t.String()
  }),
  response: t.Object({
    content: t.String(),
    size: t.Number(),
    modified: t.String()
  })
}, async ({ data }) => {
  const result = await readFile(data.file_path);
  return result;
})
```

**Frontend:**
```typescript
try {
  const file = await ws.http('files:read-file', {
    file_path: '/path/to/file.txt'
  });
  console.log('Content:', file.content); // Type-safe
  console.log('Size:', file.size);
} catch (error) {
  console.error('Failed:', error.message);
}
```

**Use when:**
- Client needs immediate response
- One-time data query
- Request-response pattern

---

### Pattern 2: Real-Time Events

**Backend:**
```typescript
import { ws } from '$backend/lib/utils/ws';

.on('terminal:input', {
  data: t.Object({
    sessionId: t.String(),
    content: t.String()
  })
}, async ({ data, conn }) => {
  // Process input
  pty.write(data.content);

  // Emit output to project
  const projectId = ws.getProjectId(conn);
  ws.emit.project(projectId, 'terminal:output', {
    sessionId: data.sessionId,
    content: data.content,
    timestamp: new Date().toISOString()
  });
})

.emit('terminal:output', t.Object({
  sessionId: t.String(),
  content: t.String(),
  timestamp: t.String()
}))
```

**Frontend:**
```typescript
// Listen to events
const cleanup = ws.on('terminal:output', (data) => {
  console.log('Output:', data.content);
  terminal.write(data.content);
});

// Emit action
ws.emit('terminal:input', {
  sessionId: 'term-123',
  content: 'ls -la\n'
});

// Cleanup
cleanup();
```

**Use when:**
- Server pushes updates to client
- Real-time streaming data
- Multiple clients need same update

---

### Pattern 3: Scope-Based Event Filtering

Events can be scoped to specific users, projects, or broadcast globally.

**User-scoped (only sender receives):**
```typescript
ws.emit.user(userId, 'browser:interacted', {
  action: 'click',
  message: 'Success'
});
```

**Project-scoped (all users in same project):**
```typescript
const projectId = ws.getProjectId(conn);
ws.emit.project(projectId, 'terminal:output', {
  sessionId: 'term-123',
  content: 'Hello World\n',
  timestamp: new Date().toISOString()
});
```

**Global broadcast (all connected users):**
```typescript
ws.emit.global('system:update', {
  version: '2.0.0',
  message: 'New version available'
});
```

**Critical: Room-Based Architecture**

Each connection can only be in **one project room at a time**. When a user switches from Project A to Project B, `ws.setProject()` removes their connection from Project A's room and adds it to Project B's room. This means:

- `ws.emit.project(projectA, ...)` will **NOT** reach users who switched away from Project A
- `ws.emit.projectMembers(projectA, ...)` reaches ALL users who have ever joined Project A, even if they switched to another project
- `ws.emit.user(userId, ...)` reaches the user regardless of which project room they're in
- `ws.emit.global(...)` reaches all connected clients regardless of project room

**4 Emit Scopes:**

```typescript
ws.emit.user(userId, event, payload)            // → specific user (all their connections)
ws.emit.project(projectId, event, payload)      // → connections currently in the project room
ws.emit.projectMembers(projectId, event, payload) // → all users who have the project (cross-project)
ws.emit.global(event, payload)                  // → all connected clients
```

**How `projectMembers` tracking works:**
- When `setProject()` or `setUser()` is called, the userId is recorded in a `projectMembers` Map for that project
- This membership **persists** even after the user switches to a different project
- `emit.projectMembers()` iterates over all member userIds, then sends to all their connections via `userConnections`

**Scope Decision Guide:**

| Event Type | Scope | Who Receives |
|------------|-------|--------------|
| User interaction feedback | `user` | Only the user who triggered action |
| Terminal output | `project` | Users **currently viewing** same project |
| File changes | `project` | Users **currently viewing** same project |
| Chat messages | `project` | Users **currently viewing** same project |
| Stream finished notification | `projectMembers` | All users who have the project (any active project) |
| System notifications | `global` | All connected users |

---

### Pattern 4: External Event Emission

Emit events from external sources (PTY, file watchers, etc.):

```typescript
import { ws } from '$backend/lib/utils/ws';

// PTY output
pty.onData((output) => {
  ws.emit.project(projectId, 'terminal:output', {
    sessionId,
    content: output,
    timestamp: new Date().toISOString()
  });
});

// File watcher
watcher.on('change', (path) => {
  ws.emit.project(projectId, 'files:changed', {
    path,
    event: 'change',
    timestamp: new Date().toISOString()
  });
});

// Browser screencast
browser.on('screencast-frame', (frame) => {
  ws.emit.project(projectId, 'browser:frame', {
    sessionId: frame.sessionId,
    frameId: String(frame.frameId),
    timestamp: frame.timestamp,
    data: frame.data // Uint8Array
  });
});
```

**Rules:**
- Import `ws` singleton
- Use appropriate scope
- Capture userId/projectId in closure
- Declare events in router

---

### Pattern 5: User & Project Tracking

**Backend - Connection Setup:**
```typescript
import { ws } from '$backend/lib/utils/ws';

app.ws('/ws', {
  open(wsRaw) {
    const conn = wsRaw as WSConnection;
    ws.register(conn);

    // Set user from auth
    const userId = getUserFromAuth(conn);
    ws.setUser(conn, userId);
  },
  close(wsRaw) {
    const conn = wsRaw as WSConnection;
    ws.unregister(conn);
  }
});
```

**Backend - Connection Context (`ws:set-context`):**

The frontend automatically sets `userId` and `projectId` on the connection via `ws:set-context` before sending any events. This is handled by the WSClient's `syncContext()` method.

```typescript
// Frontend sets context (handled automatically by WSClient)
ws.setUser('user-123');      // Calls ws:set-context { userId }
ws.setProject('proj-456');   // Calls ws:set-context { projectId }
```

**Backend - Reading Context in Handlers:**
```typescript
// In any handler, get identity from connection (single source of truth)
async ({ data, conn }) => {
  const projectId = ws.getProjectId(conn); // Throws if not set
  const userId = ws.getUserId(conn);       // Throws if not set

  // Use for business logic and event emission
  ws.emit.project(projectId, 'namespace:event', { ... });
  ws.emit.user(userId, 'namespace:feedback', { ... });
}
```

---

## API Reference

### Main Router

**File: `./index.ts`**

```typescript
export const wsRouter = createRouter()
  .merge(chatRouter)
  .merge(terminalRouter)
  .merge(filesRouter)
  // ... other modules

export type WSAPI = typeof wsRouter['$api'];
```

### Router Methods

#### `.http(action, config, handler)`

Define HTTP-style endpoint.

```typescript
.http('namespace:action', {
  data: t.Object({ ... }),
  response: t.Object({ ... })
}, async ({ data }) => {
  return result;
})
```

**Parameters:**
- `action` - Action name (format: `namespace:action`)
- `config.data` - Input schema (TypeBox)
- `config.response` - Response schema (TypeBox, data only)
- `handler` - Async function that returns data or throws error

#### `.on(action, config, handler)`

Define event listener.

```typescript
.on('namespace:action', {
  data: t.Object({ ... })
}, async ({ data, conn }) => {
  // Process action
})
```

**Parameters:**
- `action` - Action name (format: `namespace:action`)
- `config.data` - Input schema (TypeBox)
- `handler` - Async function with `data` and `conn` params

#### `.emit(event, schema)`

Declare event.

```typescript
.emit('namespace:event', t.Object({ ... }))
```

**Parameters:**
- `event` - Event name (format: `namespace:event`)
- `schema` - Event data schema (TypeBox, direct)

#### `.merge(router)`

Merge another router.

```typescript
.merge(otherRouter)
```

### WebSocket Singleton API

**File: `backend/lib/utils/ws.ts`**

```typescript
import { ws } from '$backend/lib/utils/ws';

// Emit events
ws.emit.user(userId, 'event', payload)
ws.emit.project(projectId, 'event', payload)
ws.emit.projectMembers(projectId, 'event', payload)
ws.emit.global('event', payload)

// Connection context (single source of truth - throws if not set)
ws.getProjectId(conn)   // Returns string, throws if not set
ws.getUserId(conn)      // Returns string, throws if not set

// Context setters (used internally by ws:set-context)
ws.setUser(conn, userId)
ws.setProject(conn, projectId)

// Connection management
ws.register(conn)
ws.unregister(conn)
ws.addCleanup(conn, fn)
ws.removeCleanup(conn, fn)
ws.getConnections(projectId?)
ws.getConnectionCount(projectId?)
```

### Frontend Client API

**File: `frontend/lib/utils/ws.ts`**

```typescript
import ws from '$lib/utils/ws';

// HTTP request
const data = await ws.http('namespace:action', { ... });

// Emit action (no response)
ws.emit('namespace:action', { ... });

// Listen to events
const cleanup = ws.on('namespace:event', (data) => {
  console.log(data);
});

// Cleanup
cleanup();
```

---

## Examples

### Example 1: Simple CRUD (Files Module)

**Backend: `./files/read.ts`**
```typescript
import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';

export const readHandler = createRouter()
  .http('files:read-file', {
    data: t.Object({
      file_path: t.String()
    }),
    response: t.Object({
      content: t.String(),
      size: t.Number(),
      modified: t.String()
    })
  }, async ({ data }) => {
    const result = await readFile(data.file_path);
    return result;
  })

  .http('files:list-tree', {
    data: t.Object({
      project_path: t.String(),
      expanded: t.Optional(t.String())
    }),
    response: t.Recursive((Self) => t.Union([
      t.Object({ type: t.Literal('file'), ... }),
      t.Object({ type: t.Literal('directory'), ... })
    ]))
  }, async ({ data }) => {
    const tree = await buildFileTree(data.project_path);
    return tree;
  });
```

**Frontend:**
```typescript
// Read file
const file = await ws.http('files:read-file', {
  file_path: '/path/to/file.txt'
});
console.log(file.content);

// List tree
const tree = await ws.http('files:list-tree', {
  project_path: '/path/to/project'
});
renderTree(tree);
```

---

### Example 2: Real-Time Streaming (Terminal Module)

**Backend: `./terminal/stream.ts`**
```typescript
import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/lib/utils/ws';

export const streamHandler = createRouter()
  .on('terminal:input', {
    data: t.Object({
      sessionId: t.String(),
      data: t.Any()
    })
  }, async ({ data, conn }) => {
    const projectId = ws.getProjectId(conn);

    // Write to PTY
    ptySessionManager.write(data.sessionId, data.data);

    // PTY will emit output via external event
  })

  .emit('terminal:output', t.Object({
    sessionId: t.String(),
    content: t.String(),
    timestamp: t.String()
  }))

  .emit('terminal:exit', t.Object({
    sessionId: t.String(),
    exitCode: t.Number()
  }));

// External event emission (in PTY manager)
pty.onData((output) => {
  ws.emit.project(projectId, 'terminal:output', {
    sessionId,
    content: output,
    timestamp: new Date().toISOString()
  });
});

pty.onExit((exitCode) => {
  ws.emit.project(projectId, 'terminal:exit', {
    sessionId,
    exitCode
  });
});
```

**Frontend:**
```typescript
// Listen to output
const cleanupOutput = ws.on('terminal:output', (data) => {
  terminal.write(data.content);
});

const cleanupExit = ws.on('terminal:exit', (data) => {
  console.log('Exited with code:', data.exitCode);
});

// Emit input
ws.emit('terminal:input', {
  sessionId: 'term-123',
  data: 'ls -la\n'
});

// Cleanup
onDestroy(() => {
  cleanupOutput();
  cleanupExit();
});
```

---

### Example 3: User Interaction Feedback (Browser Module)

**Backend: `./preview/browser/interact.ts`**
```typescript
import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/lib/utils/ws';

export const interactHandler = createRouter()
  .on('browser:interact', {
    data: t.Object({
      sessionId: t.String(),
      action: t.Object({
        type: t.Union([
          t.Literal('click'),
          t.Literal('type'),
          t.Literal('scroll')
        ]),
        x: t.Optional(t.Number()),
        y: t.Optional(t.Number()),
        text: t.Optional(t.String())
      })
    })
  }, async ({ data, conn }) => {
    const userId = ws.getUserId(conn);

    try {
      // Perform interaction
      const session = browserService.getSession(data.sessionId);

      if (data.action.type === 'click') {
        await session.page.mouse.click(data.action.x, data.action.y);
      }

      // User-scoped feedback
      ws.emit.user(userId, 'browser:interacted', {
        action: data.action.type,
        message: 'Success'
      });
    } catch (error) {
      ws.emit.user(userId, 'browser:error', {
        message: error.message
      });
    }
  })

  .emit('browser:interacted', t.Object({
    action: t.String(),
    message: t.String()
  }))

  .emit('browser:error', t.Object({
    message: t.String()
  }));
```

**Frontend:**
```typescript
// Listen to feedback
const cleanup = ws.on('browser:interacted', (data) => {
  showNotification(`${data.action}: ${data.message}`);
});

// Emit interaction
ws.emit('browser:interact', {
  sessionId: 'browser-123',
  action: {
    type: 'click',
    x: 100,
    y: 200
  }
});
```

---

## Best Practices

### 1. One Endpoint = One Purpose

**DO:**
```typescript
.http('files:write-file', { ... })
.http('files:create-file', { ... })
.http('files:delete', { ... })
```

**DON'T:**
```typescript
.http('files:operation', {
  data: t.Object({
    action: t.Union([
      t.Literal('write'),
      t.Literal('create'),
      t.Literal('delete')
    ]),
    // ...
  })
}, async ({ data }) => {
  switch (data.action) { // ❌ Branching logic
    case 'write': ...
    case 'create': ...
  }
})
```

**Why:**
- Better type safety
- Clearer API contract
- Easier to maintain
- No switch/if logic

---

### 2. TypeBox Schemas Inline

**DO:**
```typescript
.http('files:read-file', {
  data: t.Object({
    file_path: t.String()
  }),
  response: t.Object({
    content: t.String(),
    size: t.Number()
  })
}, async ({ data }) => { ... })
```

**DON'T:**
```typescript
const ReadFileResponse = t.Object({ ... });

.http('files:read-file', {
  response: ReadFileResponse
}, ...)
```

**Why:**
- Schema visible when reading code
- No need to scroll to find definition
- Easier to develop

---

### 3. Direct Return, No Manual Wrapping

**DO:**
```typescript
.http('files:read-file', {
  response: t.Object({
    content: t.String()
  })
}, async ({ data }) => {
  const result = await readFile(data.file_path);
  return result; // ✅ Direct return
})
```

**DON'T:**
```typescript
.http('files:read-file', {
  response: t.Object({
    success: t.Boolean(), // ❌ Manual wrapper
    data: t.Optional(t.Object({ ... })),
    error: t.Optional(t.String())
  })
}, async ({ data }) => {
  try {
    return { success: true, data: result }; // ❌
  } catch (error) {
    return { success: false, error: error.message }; // ❌
  }
})
```

**Why:**
- Server auto-wraps response
- Cleaner handler code
- Consistent error handling

---

### 4. Event vs HTTP Decision

Choose the right pattern based on your use case:

| Use Case | Direction | Pattern | Example |
|----------|-----------|---------|---------|
| **Request-Response** | Client → Server | `.http()` | `files:read-file`, `browser:get-info` |
| **Real-time Streaming** | Server → Client | Backend: `.emit()` declaration + emission<br>Frontend: `.on()` listener | `terminal:output`, `browser:frame` |
| **Fire-and-Forget Action** | Client → Server | Frontend: `.emit()`<br>Backend: `.on()` | `terminal:input`, `browser:interact` |
| **Action with Confirmation** | Client → Server → Client | Frontend: `.emit()` + `.on()`<br>Backend: `.on()` + `.emit()` | `browser:start-stream` → `browser:stream-started` |

**Key Differences:**

- **`.http()`**: Request needs immediate response (like REST API)
- **`.emit()` + `.on()`**: One-way communication (fire-and-forget or push notifications)
- **Combined**: Bidirectional flow (action triggers server event)

**Don't duplicate:**
```typescript
// ❌ WRONG - Same data available via two patterns
.http('browser:get-frame', ...)  // HTTP endpoint to fetch frame
.emit('browser:frame', ...)       // Real-time frame streaming
// Choose ONE! If streaming exists, remove HTTP endpoint.
```

**When to use what:**
- Use `.http()` when you need **immediate data back**
- Use `.emit()` + `.on()` when you need **real-time updates**
- Don't mix both for the same data

---

### 5. Declare Only Emitted Events

**DO:**
```typescript
// Declare events that are actually emitted
.emit('terminal:output', ...)  // ✅ Emitted in line 53
.emit('terminal:exit', ...)    // ✅ Emitted in line 68
```

**DON'T:**
```typescript
// Declare events that are never emitted
.emit('terminal:resize', ...)  // ❌ Never emitted
.emit('terminal:test', ...)    // ❌ Never emitted
```

**Why:**
- Type safety matches reality
- No dead code
- Frontend doesn't listen to non-existent events

---

### 6. Security - Connection Context as Single Source of Truth

**DO:**
```typescript
.on('browser:interact', {
  data: t.Object({
    sessionId: t.String()
    // ✅ NO userId/projectId in payload - use connection context
  })
}, async ({ data, conn }) => {
  const userId = ws.getUserId(conn);     // ✅ From connection state
  const projectId = ws.getProjectId(conn); // ✅ From connection state
  ws.emit.user(userId, 'browser:interacted', { ... });
})
```

**DON'T:**
```typescript
.on('browser:interact', {
  data: t.Object({
    sessionId: t.String(),
    userId: t.String(),    // ❌ Client can fake
    projectId: t.String()  // ❌ Client can fake
  })
}, async ({ data }) => {
  ws.emit.user(data.userId, 'event', { ... }); // ❌ Using client-sent identity
})
```

**Why:**
- `ws.getProjectId()`/`ws.getUserId()` are the **single source of truth**
- Identity comes from server-side connection state, not client payload
- Cannot be faked by client
- Throws if context not set (fail-fast, no silent empty strings)
- Frontend sets context via `ws:set-context` before sending any events

---

### 7. Error Handling

**HTTP handlers - throw errors:**
```typescript
async ({ data }) => {
  if (!isValid(data)) {
    throw new Error('Validation failed');
  }

  const result = await operation(data);
  return result;
}
```

**Event handlers - emit error events:**
```typescript
async ({ data, conn }) => {
  try {
    await operation(data);
  } catch (error) {
    const userId = ws.getUserId(conn);
    ws.emit.user(userId, 'namespace:error', {
      message: error.message
    });
  }
}
```

---

### 8. Resource Cleanup

Use `ws.addCleanup()` to register cleanup functions that run automatically when the connection closes:

```typescript
.on('terminal:create', {
  data: t.Object({ ... })
}, async ({ data, conn }) => {
  const sessionId = await createSession(data);

  // Register cleanup - runs automatically on disconnect
  ws.addCleanup(conn, () => {
    cleanupSession(sessionId);
  });
})
```

---

### 9. TypeBox Type Constraints

**Use literal unions for enums:**
```typescript
type: t.Union([
  t.Literal('file'),
  t.Literal('directory'),
  t.Literal('drive')
])
```

**Use string for free-form text:**
```typescript
description: t.String()
content: t.String()
```

**Use constraints for validation:**
```typescript
age: t.Number({ minimum: 0, maximum: 150 })
email: t.String({ format: 'email' })
```

---

## Troubleshooting

### Handler Not Working

**Problem:** WebSocket handler doesn't respond.

**Solutions:**
1. Verify module router is imported in `./index.ts`
2. Check handler is merged in module's `index.ts`
3. Verify action name format: `namespace:action`
4. Check console for TypeBox validation errors
5. Run `bun run check` for TypeScript errors

---

### Type Errors

**Problem:** TypeScript errors in handlers.

**Solutions:**
1. Ensure TypeBox schemas are inline in `.http()` / `.on()`
2. Verify response schema has NO `success` or `error` fields
3. Check handler returns data directly (not wrapped)
4. Ensure `.emit()` uses direct schema (not wrapped)
5. Run `bun run check` to see all errors

**Common mistakes:**
```typescript
// ❌ Wrong - wrapped schema
.emit('event', { schema: t.Object({ ... }) })

// ✅ Correct - direct schema
.emit('event', t.Object({ ... }))

// ❌ Wrong - manual wrapper in response
response: t.Object({
  success: t.Boolean(),
  data: t.Object({ ... })
})

// ✅ Correct - data only
response: t.Object({
  field1: t.String(),
  field2: t.Number()
})
```

---

### Events Not Received

**Problem:** Frontend doesn't receive events.

**Check:**
1. Event is declared with `.emit()` in router
2. Event name matches between backend and frontend
3. Event is actually emitted (search for `ws.emit`)
4. Correct scope is used (`user`, `project`, `global`)
5. User/project tracking is set up correctly
6. Frontend listener is set up before event is emitted

**Debug:**
```typescript
// Backend - log emission
ws.emit.project(projectId, 'event', payload);
console.log('Emitted event to project:', projectId);

// Frontend - log reception
ws.on('event', (data) => {
  console.log('Received event:', data);
});
```

---

### Validation Errors

**Problem:** TypeBox validation fails.

**Solutions:**
1. Check payload matches schema exactly
2. Verify all required fields are present
3. Check field types match (string vs number)
4. Ensure literal unions use exact values
5. Look at error message for specific field

**Example error:**
```
Expected type: { sessionId: string, content: string }
Received: { sessionId: "term-123" }
Error: Missing required property 'content'
```

---

### Scope Filtering Issues

**Problem:** Events received by wrong users/projects.

**Check:**
1. Correct scope is used in `ws.emit()`
2. User tracking is set up (`ws.setUser()`)
3. Project tracking is set up (`ws.setProject()`)
4. Connection context is passed to `ws.emit()`

**Debug:**
```typescript
// Check current user/project
const userId = ws.getUserId(conn);
const projectId = ws.getProjectId(conn);
console.log('User:', userId, 'Project:', projectId);

// Emit with logging
console.log('Emitting to project:', projectId);
ws.emit.project(projectId, 'event', payload);
```

---

## Module Audit Checklist

Use this checklist when creating or auditing modules:

### 1. Pattern Duplication
- [ ] Check if data is available via HTTP AND Event
- [ ] If streaming exists, remove HTTP endpoint for same data
- [ ] If HTTP is sufficient, don't create Event for same data

### 2. Event Declaration Discipline
- [ ] List all `.emit()` declarations
- [ ] Search for actual `ws.emit()` calls
- [ ] Remove declarations that are never emitted

### 3. Frontend Listener Audit
- [ ] List all `ws.on()` listeners in frontend
- [ ] Verify backend actually emits these events
- [ ] Remove listeners for non-existent events

### 4. File Structure
- [ ] Are there files with only 1 endpoint?
- [ ] Can they be merged into other files?
- [ ] Are there redundant files with streaming?

### 5. Scope Consistency
- [ ] Same event uses same scope across files
- [ ] User-specific events use `user` scope
- [ ] Project-shared events use `project` scope

---

## Additional Resources

- [TypeBox Documentation](https://github.com/sinclairzx81/typebox)
- [Elysia Documentation](https://elysiajs.com/)
- [WebSocket API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)

---

## Quick Reference

### Backend Handler Types

```typescript
// HTTP request-response
.http('namespace:action', {
  data: t.Object({ ... }),
  response: t.Object({ ... })
}, async ({ data }) => {
  return result;
})

// Event listener
.on('namespace:action', {
  data: t.Object({ ... })
}, async ({ data, conn }) => {
  // Process action
})

// Event declaration
.emit('namespace:event', t.Object({ ... }))
```

### Frontend API

```typescript
// HTTP request
const data = await ws.http('namespace:action', { ... });

// Emit action
ws.emit('namespace:action', { ... });

// Listen to events
const cleanup = ws.on('namespace:event', (data) => { ... });
cleanup();
```

### Event Emission

```typescript
import { ws } from '$backend/lib/utils/ws';

// User-specific (all connections of a user)
ws.emit.user(userId, 'event', payload);

// Project room (connections currently viewing the project)
ws.emit.project(projectId, 'event', payload);

// Project members (all users who have the project, even if viewing another project)
ws.emit.projectMembers(projectId, 'event', payload);

// Global broadcast (all connections)
ws.emit.global('event', payload);
```

---

**Happy coding! 🚀**
