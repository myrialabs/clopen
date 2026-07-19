# MCP (Model Context Protocol)

Clopen integrates MCP from **two distinct sources**, kept cleanly separated on
disk and in their namespace keys:

| | **Internal** (`internal/`) | **External** (`external/`) |
|---|---|---|
| What | Custom tools defined in code via `defineServer()` | Servers the user installs from the official MCP registry |
| Managed | By developers (this README) | By users in **Settings → MCP** |
| Stored | In code (`internal/servers/`) | In the DB (`mcp_servers` table) |
| Namespace | `clopen-mcp` bridge (non-Claude) / server name (Claude) | one bare `<slug>` per server (no prefix) |
| Execution | In-process (no subprocess) | Engine connects to Clopen's `/mcp/ext/<slug>` proxy; Clopen connects to the real upstream (stdio subprocess or remote HTTP) |

Both are merged behind the **facade** `backend/mcp/index.ts` — the only module
the rest of the backend imports from (`getEnabledMcpServers()`,
`getXxxMcpConfig()`, `resolveOpenCodeToolName()` all return the combined view).

The rest of this document covers the **internal** custom-tool system. External
servers need no code — see `external/registry-client.ts`, `external/config.ts`,
and `external/proxy.ts` (the per-server `/mcp/ext/<slug>` proxy bridge).

> **External servers are proxied, not direct.** Engines never connect straight
> to a third-party MCP server. Clopen connects to it (as an MCP client) and
> re-exposes its **sanitized** tools through a per-server endpoint on the same
> Streamable-HTTP bridge the internal tools use. See
> [External Servers, OAuth & Connection Status](#external-servers-oauth--connection-status).

---

## Custom (Internal) MCP Tools

Custom MCP tools add specialized functionality to all AI engines (**Claude Code**, **Open Code**, **Codex**, **Copilot**, …). Servers are defined once and shared across every engine via a single-source-of-truth architecture.

## 📚 Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Creating Custom Tools](#creating-custom-tools)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Examples](#examples)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## Overview

**What is Custom MCP Tools?**
System for adding custom tools to AI engines with type-safe TypeScript definitions. Tools are defined once using `defineServer()` and automatically available to both Claude Code (in-process) and Open Code (remote HTTP MCP server).

**Features:**
- Single source of truth — define tools once, use in every engine
- In-process execution for Claude Code via `createSdkMcpServer`
- Remote HTTP MCP server (Streamable HTTP) for Open Code, Codex, and
  Copilot via `createRemoteMcpServer` mounted at `/mcp`
- All engines execute handlers in-process (no subprocess, no bridge)
- Type-safe with TypeScript
- Auto metadata extraction and registration
- Configuration-based enable/disable
- Zod validation

---

## Quick Start

### 1. Create a New Server

Create a new folder in `./internal/servers/` (e.g., `calculator/`) and create an `index.ts` file using the `defineServer` helper:

**File: `./internal/servers/calculator/index.ts`**
```typescript
import { z } from "zod";
import { defineServer } from "../helper";

export default defineServer({
  name: "calculator",
  version: "1.0.0",
  tools: {
    "calculate": {
      description: "Perform mathematical calculations",
      schema: {
        expression: z.string().describe("Mathematical expression to evaluate"),
        precision: z.number().optional().default(2).describe("Decimal precision")
      },
      handler: async (args) => {
        try {
          // IMPORTANT: Use a safe math evaluation library in production!
          // This is just an example - eval() is dangerous!
          const result = eval(args.expression);
          const formatted = Number(result).toFixed(args.precision);

          return {
            content: [{
              type: "text",
              text: `${args.expression} = ${formatted}`
            }]
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `Error: Invalid expression - ${error.message}`
            }],
            isError: true
          };
        }
      }
    }
  }
});
```

### 2. Register the Server

Add to `./internal/servers/index.ts` to auto-build registries:

```typescript
import weather from './weather';
import calculator from './calculator';
import { buildServerRegistries } from './helper';

export const allServers = [
  weather,
  calculator, // Simply add your server here!
  // Add more servers...
] as const;

const { metadata, registry } = buildServerRegistries(allServers);

export const serverMetadata = metadata;
export const serverRegistry = registry;
```

### 3. Configure the Server

Add to `./internal/config.ts` (only specify `enabled` and `tools`):

```typescript
const mcpServersConfig: Record<ServerName, ServerConfig> = {
  "weather-service": {
    enabled: true,
    tools: ["get_temperature"]
  },

  // Add your new server config
  "calculator": {
    enabled: true,
    tools: ["calculate"] // Type-safe! Only valid tool names allowed
  }
};
```

### 4. Done!

Tool available to Claude as: `mcp__calculator__calculate`

---

## Architecture

```
backend/mcp/
├── index.ts            # FACADE — the only public entry point. Merges
│                       #   internal + external before handing config to adapters.
├── shared/
│   └── constants.ts    # Namespace constants/helpers (clopen-mcp, clopen-reserved prefix, slugify)
├── internal/           # Custom tools defined in code (this README)
│   ├── types.ts        # TypeScript type definitions (auto-inferred from metadata)
│   ├── config.ts       # User configuration (enabled, tools) + auto-merge with registry
│   │                   #   + resolveOpenCodeToolName() & getXxxMcpConfig() (clopen-mcp)
│   ├── remote-server.ts# Remote HTTP MCP bridge for non-Claude engines (/mcp)
│   ├── project-context.ts  # Project context service for MCP tool handlers
│   ├── output-validator.ts # Caps oversized tool outputs
│   └── servers/        # Server implementations (single source of truth)
│       ├── index.ts    # Auto-build registries from server array + export allServers
│       ├── helper.ts   # defineServer, buildServerRegistries & createRemoteMcpServer
│       ├── weather/    # Example: Weather service
│       │   ├── index.ts
│       │   └── get-temperature.ts
│       └── browser-automation/  # Example: Browser automation service
│           ├── index.ts
│           ├── actions.ts
│           ├── browser.ts
│           └── inspection.ts
├── external/           # User-installed servers from the official registry
│   ├── types.ts        # CatalogServer / ResolvedExternalServer
│   ├── registry-client.ts  # Fetch + normalise registry.modelcontextprotocol.io
│   ├── proxy.ts        # `/mcp/ext/<slug>` proxy: Clopen ↔ upstream, schema sanitiser
│   ├── probe.ts        # Connection health probe (Settings → MCP status)
│   ├── oauth.ts        # Centralized OAuth (discovery + dynamic reg + PKCE)
│   └── config.ts       # Per-engine builders (bridge URL, bare <slug>) + resolveExternalToolName
└── README.md           # This file
```

### Server Organization

For simple servers with one or two tools, you can keep all logic in `index.ts`:
```
servers/
└── simple-server/
    └── index.ts    # All tools defined here
```

For complex servers with many tools, split handlers into separate files:
```
servers/
└── complex-server/
    ├── index.ts    # Server definition using defineServer
    ├── tool-a.ts   # Handler for tool A
    ├── tool-b.ts   # Handler for tool B
    └── utils.ts    # Shared utilities
```

Example structure from `browser-automation`:
```
servers/browser-automation/
├── index.ts         # Main server definition with all tools
├── session.ts       # Session management handlers
├── navigation.ts    # Navigation handlers
├── actions.ts       # Browser action handlers
├── inspection.ts    # Page inspection handlers
└── ...             # Other organized handler files
```

### Data Flow

**Claude Code (in-process):**
```
1. Server Definition (servers/weather/index.ts)
   └─> defineServer() extracts metadata automatically
        ↓
2. Registry Building (servers/index.ts)
   └─> buildServerRegistries() creates metadata + registry
        ↓
3. Configuration (config.ts)
   └─> User config merged with registry automatically
        ↓
4. Claude Agent SDK (stream.ts)
   └─> Uses getEnabledMcpServers()
        ↓
5. Claude uses the tool (in-process handler execution)
        ↓
6. UI displays result (CustomMcpTool.svelte)
```

**Open Code (remote HTTP MCP server):**
```
1. Server Definition (servers/weather/index.ts)
   └─> Same defineServer() — single source of truth
        ↓
2. Remote MCP server (remote-server.ts)
   └─> createRemoteMcpServer() registers tools from allServers
   └─> Mounted at /mcp on the main Elysia server
        ↓
3. Open Code engine (opencode/stream.ts)
   └─> Uses getOpenCodeMcpConfig() → { type: 'remote', url: '/mcp' }
        ↓
4. Open Code connects via Streamable HTTP transport
   └─> Sends JSON-RPC tool calls to /mcp endpoint
        ↓
5. remote-server.ts handles the request
   └─> Executes handler in-process (same context as main server)
        ↓
6. Response flows back: HTTP → Open Code
        ↓
7. UI displays result (CustomMcpTool.svelte)
```

### Key Components

**`defineServer`**
Helper function to define MCP server with automatic metadata extraction.
Stores both Claude SDK server instance AND raw tool definitions (`toolDefs`)
for reuse by both engines.

**`buildServerRegistries`**
Function to build server registries from server array.

**`createRemoteMcpServer`**
Creates a `McpServer` instance (from `@modelcontextprotocol/sdk`) with tools
registered from the same `RawToolDef` definitions used by Claude Code.
Handlers execute directly in-process — no subprocess, no bridge.

**`mcpServers`**
Final configuration combining user config with server instances.

**`remote-server.ts`**
Remote HTTP MCP server mounted at `/mcp` on the main Elysia server.
Uses `WebStandardStreamableHTTPServerTransport` for the MCP protocol.
Open Code connects to it via `type: 'remote'` config. Each session gets
its own transport and `McpServer` instance. Handles session lifecycle
(create, route, close) and graceful shutdown.

---

## Creating Custom Tools

### Folder Structure

Each MCP server should be in its own folder under `./internal/servers/`:

1. **Create a folder**: `./internal/servers/your-server-name/`
2. **Create index.ts**: Main server definition file
3. **Optional**: Create separate files for tool handlers (e.g., `tool-name.ts`)

Example:
```
servers/
└── your-server-name/
    ├── index.ts       # Server definition
    ├── handler-1.ts   # Optional: Separate handler file
    └── handler-2.ts   # Optional: Another handler file
```

### Tool Definition Format

Tools are defined as an object. Each tool has three components:

```typescript
{
  "tool_name": {
    description: string,  // Tool description for Claude
    schema: Record<string, ZodType>,  // Zod schema (plain object, not wrapped)
    handler: async (args) => Promise<ToolResult>  // Handler function
  }
}
```

### Input Schema (Zod)

Define schema as a plain object of Zod types:

```typescript
schema: {
  // Required string
  name: z.string().describe("User's name"),

  // Required number with constraints
  age: z.number().min(0).max(150).describe("User's age"),

  // Optional with default
  format: z.enum(["json", "csv"]).default("json").describe("Output format"),

  // Optional field
  email: z.string().email().optional().describe("Email address"),

  // Array
  tags: z.array(z.string()).describe("List of tags"),

  // Nested object
  address: z.object({
    street: z.string(),
    city: z.string(),
    zipCode: z.string()
  }).describe("User address")
}
```

**Note:** The schema is automatically wrapped in `z.object()` by `defineServer`.

### Handler Function

The handler receives validated arguments and returns a result:

```typescript
async (args) => {
  try {
    // Do your work here
    const result = await someAsyncOperation(args);

    // Return success
    return {
      content: [{
        type: "text",
        text: `Result: ${result}`
      }]
    };

  } catch (error) {
    // Return error
    return {
      content: [{
        type: "text",
        text: `Error: ${error.message}`
      }],
      isError: true
    };
  }
}
```

### Return Format

Tools must return an object with this structure:

```typescript
{
  content: Array<{
    type: "text" | "image" | "resource",
    text?: string,        // For type: "text"
    // Additional fields for other types
  }>,
  isError?: boolean       // Mark as error result
}
```

---

## Configuration

### Server Configuration

Configuration is split into two parts:

**1. User Configuration (`mcpServersConfig` in `config.ts`):**
```typescript
const mcpServersConfig: Record<ServerName, ServerConfig> = {
  "weather-service": {
    enabled: boolean,        // Whether server is active
    tools: readonly string[] // Array of enabled tool names (type-safe!)
  }
};
```

**2. Auto-Merged with Registry:**
Server instances from `serverRegistry` are automatically merged to create the final `mcpServers` object:

```typescript
// Final structure (after merge):
{
  instance: McpSdkServerConfigWithInstance,  // From registry
  enabled: boolean,                          // From user config
  tools: readonly string[]                   // From user config (type-validated)
}
```

### Environment Variables & Secrets

For tools that require API keys or secrets:

1. **Never hardcode secrets** in the code
2. Use environment variables:

```typescript
async (args) => {
  // Get API key from environment
  const apiKey = process.env.MY_API_KEY;

  if (!apiKey) {
    return {
      content: [{
        type: "text",
        text: "Error: MY_API_KEY environment variable not set"
      }],
      isError: true
    };
  }

  // Use the API key
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${apiKey}`
    }
  });

  // ... rest of implementation
}
```

3. Add to `.env` file:
```bash
MY_API_KEY=your-secret-key-here
```

---

## API Reference

### Main Exports

#### Type Definitions
```typescript
import type {
  ServerName,           // Union of all server names (from metadata)
  ToolsForServer,       // Tool names for a specific server (from metadata)
  ServerConfig,         // User config structure
  McpServerConfigWithInstance,  // Config + instance structure
  ParsedMcpToolName,    // Parsed tool name components
  McpServerStatus       // Server status from SDK
} from '$backend/mcp';
```

#### Main Configuration

**`mcpServers`** - Final merged configuration:
```typescript
import { mcpServers } from '$backend/mcp';

// Access server configuration
const weatherConfig = mcpServers["weather-service"];
// {
//   instance: McpSdkServerConfigWithInstance,
//   enabled: true,
//   tools: ["get_temperature"]
// }
```

#### Server Registries

**`serverMetadata`** - Metadata for type inference:
```typescript
import { serverMetadata } from '$backend/mcp/servers';

// Access metadata
const weatherMeta = serverMetadata["weather-service"];
// { name: "weather-service", tools: ["get_temperature"] }
```

**`serverRegistry`** - Server instances:
```typescript
import { serverRegistry } from '$backend/mcp/servers';

// Access server instance
const weatherServer = serverRegistry["weather-service"];
```

### Main Functions

#### `getEnabledMcpServers()`
Returns all enabled MCP servers for use with Claude SDK.

```typescript
import { getEnabledMcpServers } from '$backend/mcp';

const servers = getEnabledMcpServers();
// Returns: Record<string, McpServerConfig>
```

#### `getAllowedMcpTools()`
Returns array of allowed tool names (formatted for Claude SDK).

```typescript
import { getAllowedMcpTools } from '$backend/mcp';

const tools = getAllowedMcpTools();
// Returns: ["mcp__weather-service__get_temperature", ...]
```

#### `parseMcpToolName(fullName)`
Parse MCP tool name into components.

```typescript
import { parseMcpToolName } from '$backend/mcp';

const parsed = parseMcpToolName("mcp__weather-service__get_temperature");
// Returns: { server: "weather-service", tool: "get_temperature", fullName: "..." }
```

#### `isMcpTool(toolName)`
Check if a tool name is a custom MCP tool.

```typescript
import { isMcpTool } from '$backend/mcp';

isMcpTool("mcp__weather-service__get_temperature");  // true
isMcpTool("Bash");  // false
```

#### `getOpenCodeMcpConfig()`
Returns MCP configuration for Open Code engine (remote HTTP MCP server).

```typescript
import { getOpenCodeMcpConfig } from '$backend/mcp';

const mcpConfig = getOpenCodeMcpConfig();
// Returns: { 'clopen-mcp': { type: 'remote', url: 'http://localhost:9151/mcp', ... } }
```

#### `resolveOpenCodeToolName(toolName)`
Resolve a remote-MCP tool name to `mcp__server__tool` format (single source
of truth — used by every non-Claude engine adapter).

The remote-MCP namespace key is always `clopen-mcp`, but engines disagree on
the separator they use to join the namespace and the bare tool name:

| Engine    | Tool name shape                  | Separator |
| --------- | -------------------------------- | --------- |
| Open Code | `clopen-mcp_open_new_tab`        | `_`       |
| Copilot   | `clopen-mcp-open_new_tab`        | `-`       |
| Codex     | `open_new_tab` (bare)            | n/a       |

The resolver strips **both** `clopen-mcp_` and `clopen-mcp-` prefixes and
falls back to the bare-name path. **Adapters must call this helper instead
of building a per-engine resolver** — if a future SDK introduces yet another
separator, extend the prefix list here, not at the call site.

```typescript
import { resolveOpenCodeToolName } from '$backend/mcp';

resolveOpenCodeToolName("clopen-mcp_get_temperature");
// Returns: "mcp__weather-service__get_temperature"

resolveOpenCodeToolName("clopen-mcp-get_temperature");
// Returns: "mcp__weather-service__get_temperature"

resolveOpenCodeToolName("get_temperature");
// Returns: "mcp__weather-service__get_temperature"

resolveOpenCodeToolName("unknown_tool");
// Returns: null
```

**Symptom of skipping this helper:** the UI renders the tool with a
doubled-up name like `mcp__clopen-mcp__clopen-mcp-open_new_tab` instead
of `mcp__browser-automation__open_new_tab`. The prefix didn't strip and
the registry lookup fell through.

#### `getCodexMcpConfig()` / `getCopilotMcpConfig()`
Sibling helpers to `getOpenCodeMcpConfig()` for the Codex and Copilot
engines. Each returns the **same** `/mcp` URL in the SDK-specific shape:

```typescript
// Codex (config object flattened to --config flags)
getCodexMcpConfig();
// { 'clopen-mcp': { url: 'http://localhost:9151/mcp', tools: { ... } } }

// Copilot (MCPHTTPServerConfig from @github/copilot-sdk)
getCopilotMcpConfig();
// { 'clopen-mcp': { type: 'http', url: 'http://localhost:9151/mcp', tools: [...] } }
```

When adding a new engine that consumes streamable-HTTP MCP, add a sibling
`getXxxMcpConfig()` here — do **not** introduce a new HTTP listener or a
new namespace key. See `backend/engine/README.md` §10.12 for the full
checklist (variable naming, type imports, auto-approval surface, etc.).

### Helper Functions

```typescript
import {
  getServerConfig,
  getToolConfig,
  isServerEnabled,
  isToolEnabled,
  getEnabledServerNames,
  getEnabledToolsForServer,
  getMcpStats
} from '$backend/mcp';

// Get server configuration (includes instance)
const config = getServerConfig("weather-service");

// Get tool configuration
const hasTemperature = getToolConfig("weather-service", "get_temperature");

// Check if server/tool enabled
const serverEnabled = isServerEnabled("weather-service");
const toolEnabled = isToolEnabled("weather-service", "get_temperature");

// Get enabled server names
const enabledServers = getEnabledServerNames();
// Returns: ["weather-service", ...]

// Get enabled tools for a server
const tools = getEnabledToolsForServer("weather-service");
// Returns: ["mcp__weather-service__get_temperature", ...]

// Get statistics
const stats = getMcpStats();
// Returns: {
//   totalServers: number,
//   enabledServers: number,
//   totalTools: number,
//   serverNames: string[],
//   toolNames: string[]
// }
```

---

## Examples

### Example 1: Weather Service (Included)

**Simple approach** - All logic in `index.ts`:

**File: `servers/weather/index.ts`**
```typescript
import { z } from "zod";
import { defineServer } from "../helper";

export default defineServer({
  name: "weather-service",
  version: "1.0.0",
  tools: {
    "get_temperature": {
      description: "Get current temperature for a location using coordinates. Returns temperature in Fahrenheit.",
      schema: {
        latitude: z.number().min(-90).max(90).describe("Latitude coordinate (-90 to 90)"),
        longitude: z.number().min(-180).max(180).describe("Longitude coordinate (-180 to 180)")
      },
      handler: async (args) => {
        try {
          const url = `https://api.open-meteo.com/v1/forecast?latitude=${args.latitude}&longitude=${args.longitude}&current=temperature_2m&temperature_unit=fahrenheit`;
          const response = await fetch(url);

          if (!response.ok) {
            return {
              content: [{
                type: "text",
                text: `Failed to fetch weather data: ${response.status} ${response.statusText}`
              }],
              isError: true
            };
          }

          const data = await response.json();
          const temperature = data.current.temperature_2m;
          const unit = data.current_units?.temperature_2m || "°F";

          return {
            content: [{
              type: "text",
              text: `Temperature: ${temperature}${unit}`
            }]
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `Error fetching temperature: ${error.message}`
            }],
            isError: true
          };
        }
      }
    }
  }
});
```

**Organized approach** - Separate handler file:

**File: `servers/weather/get-temperature.ts`**
```typescript
export async function getTemperatureHandler(args: { latitude: number; longitude: number }) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${args.latitude}&longitude=${args.longitude}&current=temperature_2m&temperature_unit=fahrenheit`;
    const response = await fetch(url);

    if (!response.ok) {
      return {
        content: [{
          type: "text",
          text: `Failed to fetch weather data: ${response.status} ${response.statusText}`
        }],
        isError: true
      };
    }

    const data = await response.json();
    const temperature = data.current.temperature_2m;
    const unit = data.current_units?.temperature_2m || "°F";

    return {
      content: [{
        type: "text",
        text: `Temperature: ${temperature}${unit}`
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Error fetching temperature: ${error.message}`
      }],
      isError: true
    };
  }
}
```

**File: `servers/weather/index.ts`**
```typescript
import { z } from "zod";
import { defineServer } from "../helper";
import { getTemperatureHandler } from "./get-temperature";

export default defineServer({
  name: "weather-service",
  version: "1.0.0",
  tools: {
    "get_temperature": {
      description: "Get current temperature for a location using coordinates. Returns temperature in Fahrenheit.",
      schema: {
        latitude: z.number().min(-90).max(90).describe("Latitude coordinate (-90 to 90)"),
        longitude: z.number().min(-180).max(180).describe("Longitude coordinate (-180 to 180)")
      },
      handler: getTemperatureHandler
    }
  }
});
```

### Example 2: Database Query

Execute database queries with connection pooling:

```typescript
import { z } from "zod";
import { defineServer } from "../helper";
import { Pool } from 'pg'; // PostgreSQL client

// Create connection pool (outside defineServer)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

export default defineServer({
  name: "database",
  version: "1.0.0",
  tools: {
    "query_database": {
      description: "Execute a read-only database query",
      schema: {
        query: z.string().describe("SQL query to execute (SELECT only)"),
        params: z.array(z.any()).optional().describe("Query parameters")
      },
      handler: async (args) => {
        try {
          // Validate query is SELECT only
          if (!args.query.trim().toLowerCase().startsWith('select')) {
            return {
              content: [{
                type: "text",
                text: "Error: Only SELECT queries are allowed"
              }],
              isError: true
            };
          }

          const result = await pool.query(args.query, args.params || []);

          return {
            content: [{
              type: "text",
              text: `Found ${result.rowCount} rows:\n${JSON.stringify(result.rows, null, 2)}`
            }]
          };

        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `Database error: ${error.message}`
            }],
            isError: true
          };
        }
      }
    }
  }
});
```

### Example 3: API Gateway

Make authenticated requests to external APIs:

```typescript
import { z } from "zod";
import { defineServer } from "../helper";

// Service configurations (outside defineServer)
const configs = {
  github: {
    baseUrl: "https://api.github.com",
    token: process.env.GITHUB_TOKEN
  },
  slack: {
    baseUrl: "https://slack.com/api",
    token: process.env.SLACK_TOKEN
  },
  stripe: {
    baseUrl: "https://api.stripe.com/v1",
    token: process.env.STRIPE_KEY
  }
};

export default defineServer({
  name: "api-gateway",
  version: "1.0.0",
  tools: {
    "api_request": {
      description: "Make authenticated API requests to external services",
      schema: {
        service: z.enum(["github", "slack", "stripe"]).describe("Service to call"),
        endpoint: z.string().describe("API endpoint path"),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).describe("HTTP method"),
        body: z.record(z.any()).optional().describe("Request body")
      },
      handler: async (args) => {
        const config = configs[args.service];
        const url = `${config.baseUrl}${args.endpoint}`;

        const response = await fetch(url, {
          method: args.method,
          headers: {
            'Authorization': `Bearer ${config.token}`,
            'Content-Type': 'application/json'
          },
          body: args.body ? JSON.stringify(args.body) : undefined
        });

        const data = await response.json();

        return {
          content: [{
            type: "text",
            text: JSON.stringify(data, null, 2)
          }]
        };
      }
    }
  }
});
```

### Example 4: File Operations

Read and process files from the filesystem:

```typescript
import { z } from "zod";
import { defineServer } from "../helper";

export default defineServer({
  name: "file-utils",
  version: "1.0.0",
  tools: {
    "count_lines": {
      description: "Count lines in a file",
      schema: {
        filePath: z.string().describe("Path to the file")
      },
      handler: async (args) => {
        try {
          const content = await Bun.file(args.filePath).text();
          const lines = content.split('\n').length;

          return {
            content: [{
              type: "text",
              text: `File has ${lines} lines`
            }]
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `Error reading file: ${error.message}`
            }],
            isError: true
          };
        }
      }
    }
  }
});
```

---

## Best Practices

### 1. Error Handling

Always wrap tool logic in try-catch and return meaningful errors:

```typescript
async (args) => {
  try {
    // Your logic here
    return { content: [{ type: "text", text: result }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true
    };
  }
}
```

### 2. Input Validation

Use Zod constraints for robust validation:

```typescript
{
  email: z.string().email().describe("Valid email address"),
  age: z.number().min(0).max(150).describe("Age in years"),
  url: z.string().url().describe("Valid URL")
}
```

### 3. Descriptive Messages

Provide clear descriptions for Claude to understand tool usage:

```typescript
{
  "send_email": {
    description: "Send an email to a recipient. Use this when the user explicitly asks to send an email.",
    schema: { /* ... */ },
    handler: async (args) => { /* ... */ }
  }
}
```

### 4. Resource Management

Clean up resources properly:

```typescript
handler: async (args) => {
  const connection = await createConnection();

  try {
    const result = await connection.query(args.query);
    return { content: [{ type: "text", text: result }] };
  } finally {
    await connection.close(); // Always clean up
  }
}
```

### 5. Security

```typescript
// Use environment variables for secrets
const apiKey = process.env.API_KEY;
if (!apiKey) {
  return { content: [{ type: "text", text: "API key not configured" }], isError: true };
}

// Validate user input with Zod
// Use read-only database connections
// Sanitize file paths
```

### 6. Performance

```typescript
// Use connection pool (create once, outside defineServer)
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export default defineServer({
  name: "database",
  version: "1.0.0",
  tools: {
    "query": {
      description: "Execute a query",
      schema: { query: z.string() },
      handler: async (args) => {
        const result = await pool.query(args.query);
        // ...
      }
    }
  }
});
```

---

## Troubleshooting

### Tool Not Appearing

**Problem:** My custom tool doesn't appear in Claude's available tools.

**Solutions:**
1. Verify server folder exists in `./internal/servers/` with an `index.ts` file
2. Verify server is defined using `defineServer` and exported as default (`export default defineServer(...)`)
3. Check server is imported and added to `allServers` array in `servers/index.ts`
4. Check that server is enabled in `mcpServersConfig` in `config.ts`
5. Check that tool is listed in `tools` array in `config.ts`
6. Verify tool name format: `mcp__{server}__{tool}`
7. Check console for MCP initialization errors or TypeScript errors

### Connection Errors

**Problem:** MCP server fails to connect.

**Check:**
- Server uses `defineServer` and exports as default (`export default defineServer(...)`)
- Server is imported in `servers/index.ts` and added to `allServers` array
- No syntax errors in server file
- All dependencies are installed (`bun install`)
- Console logs show initialization
- Run `bun run check` to catch TypeScript errors

### Tool Execution Fails

**Problem:** Tool executes but returns errors.

**Debug:**
1. Check error message in Claude's response
2. Look at server logs/console output
3. Verify input schema matches what Claude is sending
4. Test tool handler independently
5. Check for missing environment variables

### Environment Variables Not Working

**Problem:** `process.env.MY_KEY` returns undefined.

**Solutions:**
1. Add to `.env` file in project root
2. Restart the application (env vars are loaded at startup)
3. Check that variable name matches exactly
4. Verify `.env` file is not gitignored

### Type Errors

**Problem:** TypeScript errors in custom tool.

**Solutions:**
1. Install dependencies: `bun install zod @anthropic-ai/claude-agent-sdk`
2. Verify you're importing `defineServer` from `../helper`
3. Check that server name matches between `defineServer` and `config.ts`
4. Verify tool names in `config.ts` match tool keys in `defineServer`
5. Ensure schema is a plain object, not wrapped in `z.object()`
6. Run `bun run check` to see all errors

**Common Type Errors:**

```typescript
// ❌ Wrong - wrapped in z.object()
schema: z.object({
  name: z.string()
})

// ✅ Correct - plain object
schema: {
  name: z.string()
}

// ❌ Wrong - invalid tool name in config
"calculator": {
  enabled: true,
  tools: ["add", "multiply"] // "multiply" doesn't exist in defineServer
}

// ✅ Correct - matches defineServer
"calculator": {
  enabled: true,
  tools: ["add"] // Tool exists in defineServer
}
```

---

## Engine Integration (Open Code, Codex, Copilot, …)

### How It Works

Every non-Claude engine connects to the **same remote HTTP MCP server**
running in the main Clopen process. Tool handlers execute directly
in-process — no subprocess, no per-engine bridge. This is
architecturally identical to how Claude Code uses in-process MCP
servers.

1. **`remote-server.ts`** — HTTP MCP server mounted at `/mcp` on the main Elysia server. Uses `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` for the Streamable HTTP transport protocol.

2. **`createRemoteMcpServer()`** — Factory in `servers/helper.ts` that creates a `McpServer` instance with tools registered from the same `RawToolDef` definitions used by Claude Code. Each MCP session gets its own server instance.

3. **`getXxxMcpConfig()` per engine** — `config.ts` exports one helper per
   engine that returns the **same** `/mcp` URL in the engine's expected
   shape. They all share the `'clopen-mcp'` namespace key:
   - `getOpenCodeMcpConfig()` → `{ type: 'remote', url, ... }`
   - `getCodexMcpConfig()` → `{ url, tools: { <tool>: { approval_mode: 'approve' } } }`
   - `getCopilotMcpConfig()` → `{ type: 'http', url, tools: [...] }`

### Adding a New Tool

No extra work needed! When you add a new tool via `defineServer()`, it's
automatically available to **every** engine:

- **Claude Code**: Uses the in-process `createSdkMcpServer` instance
- **Everyone else**: `remote-server.ts` uses `createRemoteMcpServer()`
  with the same `allServers` and `mcpServersConfig`

### Adding a New Engine

If your engine's CLI/SDK accepts a streamable-HTTP MCP URL, follow the
checklist in `backend/engine/README.md` §10.12. The summary:

1. Add a sibling `getXxxMcpConfig()` next to the existing helpers in
   `config.ts`. Reuse the `'clopen-mcp'` namespace key. Use the SDK's
   exported config type if it has one.
2. In the adapter, name the local variable holding the helper's return
   value `mcpConfig` (not `mcpServers` — that shadows the registry).
3. Use `resolveOpenCodeToolName()` to canonicalise incoming tool names.
   If the SDK introduces a new prefix separator, extend the prefix list
   in that helper rather than building a per-engine resolver.
4. Wire the engine's auto-approval path (runtime callback or static
   per-tool config) so MCP tool calls don't get cancelled.
5. Add a sibling `getXxxExternalMcpConfig()` in
   `backend/mcp/external/config.ts` for user-installed registry servers.
   Every external server is proxied, so this is now a one-liner per server:
   emit the bridge URL `http://localhost:<port>/mcp/ext/<slug>` plus the
   service-token header in the SDK's shape. No stdio branch, no upstream
   credential handling (the proxy injects it). Codex still uses
   `http_headers`, **not** `bearer_token`. See
   [External Servers, OAuth & Connection Status](#external-servers-oauth--connection-status)
   and `backend/engine/docs/lessons-learned.md` §10.18.

### File Locations

| File | Location | Purpose |
|------|----------|---------|
| Public facade | `backend/mcp/index.ts` | Only public entry; merges internal + external |
| Tool definitions | `backend/mcp/internal/servers/` | Single source of truth (internal) |
| Remote MCP server | `backend/mcp/internal/remote-server.ts` | HTTP bridge: internal `/mcp` + external `/mcp/ext/<slug>` |
| External proxy | `backend/mcp/external/proxy.ts` | Clopen↔upstream MCP client + schema sanitiser |
| Server factory | `backend/mcp/internal/servers/helper.ts` | `createRemoteMcpServer()` |
| Per-engine config (internal) | `backend/mcp/internal/config.ts` | `getOpenCodeMcpConfig()`, `getCodexMcpConfig()`, … (clopen-mcp) |
| Tool name resolver | `backend/mcp/internal/config.ts` | `resolveOpenCodeToolName()` (handles every engine's prefix variant) |
| External catalog | `backend/mcp/external/registry-client.ts` | Browse the official MCP registry |
| Per-engine config (external) | `backend/mcp/external/config.ts` | `getXxxExternalMcpConfig()` (<slug>) |
| Namespace constants | `backend/mcp/shared/constants.ts` | `clopen-mcp`, clopen-reserved prefix, slugify |

---

## External Servers, OAuth & Connection Status

Everything above describes **internal** custom tools (the `clopen-mcp`
bridge). **External** servers are the ones a user installs from the official
registry (Settings → MCP → Browse), stored in the `mcp_servers` table.

### Proxied through the bridge (not direct)

Engines do **not** connect to a third-party MCP server directly. Each enabled
external server gets its own endpoint `GET/POST/DELETE /mcp/ext/<slug>` on the
same Streamable-HTTP bridge as the internal tools. Clopen connects to the real
upstream (stdio subprocess or remote URL) as an MCP **client**, and re-exposes
its tools there. The per-engine builders in `external/config.ts` therefore emit
the **identical** shape for every server — a loopback bridge URL plus the
service-token header — regardless of the upstream's real transport.

Why proxy (`external/proxy.ts`):

1. **Schema sanitising.** The MCP SDK's `Client.listTools()` eagerly compiles an
   Ajv validator for every tool's `outputSchema`. A single unresolvable `$ref`
   (e.g. Stitch's `#/$defs/ScreenInstance`) makes it throw, and the engine CLIs'
   `discoverTools` swallow that error and surface **zero** tools — a "connected"
   server that advertises nothing. Clopen reads `tools/list` with a **raw**
   JSON-RPC request (no Ajv), **drops `outputSchema`**, and strips dangling
   `$ref`s from `inputSchema` before re-serving. One bad schema can no longer
   hide a whole server.
2. **One credential path.** OAuth bearer / static API key is injected once, on
   Clopen's upstream hop (`resolveServerRow`). The engine→bridge hop only
   carries the service token — so a new engine adapter needs no per-transport
   or per-credential branching.
3. **Uniform behaviour.** stdio and remote external servers behave identically
   on every engine (this fixed Qwen advertising no remote tools and Copilot
   advertising no external tools at all).

Lifecycle: the upstream client (and any stdio subprocess) is created lazily when
an engine opens a bridge session and torn down when that session closes
(`internal/remote-server.ts`).

### Authentication is Clopen's responsibility

Because Clopen owns the upstream connection, it also owns auth.

### Centralized OAuth (one sign-in, every engine)

Remote servers that need OAuth (e.g. Notion) are authenticated by **Clopen
itself**, not by each engine. The earlier per-engine approach failed: only
OpenCode had a callable sign-in trigger, and its token lived in OpenCode's own
store, so Codex/Claude/etc. never got it.

Flow (`backend/mcp/external/oauth.ts`):

1. **Discover** — RFC 9728 protected-resource metadata → RFC 8414
   authorization-server metadata (endpoints + dynamic registration URL).
2. **Register** — RFC 7591 dynamic client registration (public client, PKCE).
3. **Authorize** — authorization-code + PKCE (S256). The browser is redirected
   to Clopen's **stable** callback `GET /api/mcp/oauth/callback` (in
   `backend/index.ts`) — not an ephemeral per-flow loopback server.
4. **Store** — access + refresh tokens are saved in the `mcp_servers.oauth`
   JSON column (migration 042), separate from the user-editable `headers`.
5. **Inject** — `resolveServerRow()` adds `Authorization: Bearer <token>` to
   every engine's config. `refreshExpiringExternalOAuth()` runs at chat-stream
   start (in `stream-manager`) so the synchronous per-engine builders read a
   fresh token. **A new engine adapter needs no OAuth code** — it just receives
   a bearer header like any authenticated remote.

WS routes (admin-only): `mcp:oauth-start` (returns the authorization URL; the
UI opens it and polls status), `mcp:oauth-complete` (manual paste fallback).

### Per-engine config: just the bridge URL + service token

Because every external server is proxied, each engine's external builder in
`backend/mcp/external/config.ts` emits the **same** shape: a loopback bridge URL
(`http://localhost:<port>/mcp/ext/<slug>`) plus the service-token bearer. The
upstream's real credential (OAuth/API key) is injected by the proxy, not the
builder — so there is no per-engine header-field bookkeeping anymore. The only
remaining per-engine difference is the SDK's config key for the URL/header:

| Engine | URL field | Auth header field | Notes |
|--------|-----------|-------------------|-------|
| Claude | `url` (`type:'http'`) | `headers` | — |
| OpenCode | `url` (`type:'remote'`) | `headers` | — |
| Copilot | `url` (`type:'http'`) | `headers` | `tools:['*']` so the CLI exposes all proxied tools |
| Qwen | `httpUrl` | `headers` | — |
| **Codex** | `url` | **`http_headers`** | **NOT `bearer_token`** — rejected for `streamable_http`. |

A new engine that speaks Streamable-HTTP MCP needs only this one-line builder —
no stdio branch, no upstream-credential handling.

### Required-credential validation

`mcp:install` / `mcp:update-config` reject a save when a registry-declared
required field (`configSchema[].isRequired`) is left blank — so an API-key
server can't install into a silently-broken state.

### Connection status probe

`mcp:status` (`backend/mcp/external/probe.ts`) runs an engine-agnostic
handshake (`initialize` + `tools/list`; stdio servers are spawned) and
classifies the result:

| State | Meaning | Settings action |
|-------|---------|-----------------|
| `ok` | Connected (handshake + tool list OK) | — |
| `needs_auth` | 401 with a `Bearer` challenge → OAuth | **Authenticate** |
| `needs_config` | Reachable but a static API key is missing | **Configure** |
| `unreachable` | No response / network error | Re-check |
| `error` | Other failure | Re-check |
| `local` | (internal rows only) | — |

The Settings panel probes on open, after install, and after enabling a server,
so status never goes stale silently.

---

## Additional Resources

- [Agent SDK Reference](https://platform.claude.com/docs/en/agent-sdk/typescript.md)
- [Custom Tools](https://platform.claude.com/docs/en/agent-sdk/custom-tools.md)
- [MCP in the SDK](https://platform.claude.com/docs/en/agent-sdk/mcp.md)
- [MCP SDK (@modelcontextprotocol/sdk)](https://github.com/modelcontextprotocol/typescript-sdk)
- [WebSocket API Documentation](../ws/README.md)
- [Zod Documentation](https://zod.dev/)

---

## Support

For questions or issues:
1. Check this README
2. Review example implementations in `./servers/`
3. Check console logs for error messages
4. Review Claude Agent SDK documentation

---

**Happy coding!**
