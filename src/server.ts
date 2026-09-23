#!/usr/bin/env node
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };

// Load environment variables from custom path if specified
// This allows the MCP to be used from other projects with a separate .env file
if (process.env.DOTENV_CONFIG_PATH) {
  dotenv.config({ path: process.env.DOTENV_CONFIG_PATH, quiet: true });
} else {
  dotenv.config({ quiet: true }); // Default .env in current directory
}

import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { N8nClient } from "./n8n-client.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { logger, createChildLogger } from "./logger.js";

const serverLogger = createChildLogger("server");

// ============ CONFIGURATION ============

/** Minimum length for MCP_AUTH_TOKEN. Shorter or unset means HTTP mode serves 503. */
export const MIN_AUTH_TOKEN_LENGTH = 32;

interface Config {
  n8nApiUrl: string;
  n8nApiKey: string;
  mcpAuthToken: string;
  port: number;
  allowedOrigins: string[];
  nodeEnv: string;
  requestTimeout: number;
  maxRetries: number;
}

function loadConfig(): Config {
  const config: Config = {
    n8nApiUrl: process.env.N8N_API_URL || "http://localhost:5678/api/v1",
    n8nApiKey: process.env.N8N_API_KEY || "",
    mcpAuthToken: process.env.MCP_AUTH_TOKEN || "",
    port: parseInt(process.env.PORT || "3000", 10),
    allowedOrigins: (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean),
    nodeEnv: process.env.NODE_ENV || "development",
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || "30000", 10),
    maxRetries: parseInt(process.env.MAX_RETRIES || "3", 10),
  };

  // Validate required config
  if (!config.n8nApiKey) {
    serverLogger.warn("N8N_API_KEY not set - API calls will fail");
  }

  return config;
}

const config = loadConfig();
const isStdioMode = process.argv.includes("--stdio");
if (!isStdioMode && config.nodeEnv !== "test" && config.mcpAuthToken.length < MIN_AUTH_TOKEN_LENGTH) {
  serverLogger.warn(
    `MCP_AUTH_TOKEN is unset or shorter than ${MIN_AUTH_TOKEN_LENGTH} characters. /mcp and /docs will return 503 until it is set.`
  );
}

// Create n8n client with production settings
const n8nClient = new N8nClient(config.n8nApiUrl, config.n8nApiKey, {
  timeout: config.requestTimeout,
  maxRetries: config.maxRetries,
});

// ============ CLAUDE DOCS ============

const CLAUDE_DOCS = `# n8n-MCP - AI Tool Reference

You have access to an n8n workflow automation server through MCP (Model Context Protocol).
Use the curl patterns below to list, create, execute, and manage n8n workflows.

## Base URL

\`\`\`
POST https://mcp.kratoslabs.agency/mcp
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer $MCP_AUTH_TOKEN
\`\`\`

Every \`/mcp\` and \`/docs\` request needs the bearer token. Without it the server answers 401.
If the operator has not set \`MCP_AUTH_TOKEN\` the server answers 503.

## How to call a tool

Send a JSON-RPC request to the MCP endpoint. The response is in SSE format - parse the \`data:\` line.

\`\`\`bash
curl -s -X POST "https://mcp.kratoslabs.agency/mcp" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"TOOL_NAME","arguments":{ARGS}}}'
\`\`\`

### Example: List all workflows

\`\`\`bash
curl -s -X POST "https://mcp.kratoslabs.agency/mcp" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_workflows","arguments":{}}}'
\`\`\`

### Example: Get a specific workflow

\`\`\`bash
curl -s -X POST "https://mcp.kratoslabs.agency/mcp" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_workflow","arguments":{"workflowId":"YOUR_ID"}}}'
\`\`\`

### Example: Execute a workflow

\`\`\`bash
curl -s -X POST "https://mcp.kratoslabs.agency/mcp" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"execute_workflow","arguments":{"workflowId":"YOUR_ID"}}}'
\`\`\`

### Example: List available tools

\`\`\`bash
curl -s -X POST "https://mcp.kratoslabs.agency/mcp" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
\`\`\`

## Parsing responses

Responses use SSE format. The JSON result is on the \`data:\` line:

\`\`\`
event: message
data: {"result":{...},"jsonrpc":"2.0","id":1}
\`\`\`

The tool result is in \`result.content[0].text\` (usually a JSON string).

## Available tools (29)

### Workflow Management
| Tool | Arguments | Description |
|------|-----------|-------------|
| \`list_workflows\` | \`{active?, tags?, name?, limit?}\` | List all workflows |
| \`get_workflow\` | \`{workflowId}\` | Get workflow details |
| \`create_workflow\` | \`{name, nodes, connections, settings}\` | Create a workflow |
| \`update_workflow\` | \`{workflowId, name?, nodes?, connections?, settings?}\` | Update a workflow |
| \`delete_workflow\` | \`{workflowId}\` | Delete a workflow |
| \`activate_workflow\` | \`{workflowId}\` | Activate a workflow |
| \`deactivate_workflow\` | \`{workflowId}\` | Deactivate a workflow |

### Execution
| Tool | Arguments | Description |
|------|-----------|-------------|
| \`list_executions\` | \`{workflowId?, status?, limit?}\` | List executions |
| \`get_execution\` | \`{executionId}\` | Get execution details |
| \`delete_execution\` | \`{executionId}\` | Delete an execution |
| \`execute_webhook\` | \`{webhookPath, data?, username?, password?}\` | Trigger via webhook |
| \`execute_workflow\` | \`{workflowId, payload?, timeoutMs?}\` | Execute and wait for results |

### Diagnostics & Self-Healing
| Tool | Arguments | Description |
|------|-----------|-------------|
| \`diagnose_execution\` | \`{executionId}\` | Analyze execution errors |
| \`self_heal_workflow\` | \`{workflowId, payload?, timeoutMs?}\` | Execute, diagnose, and suggest fixes |

### Node Intelligence
| Tool | Arguments | Description |
|------|-----------|-------------|
| \`get_node_types\` | \`{category?}\` | List node types by category |
| \`get_node_schema\` | \`{nodeType}\` | Get node parameter schema |
| \`search_nodes\` | \`{query}\` | Search nodes by keyword |
| \`get_expression_help\` | \`{topic?}\` | n8n expression reference |

### Templates & Examples
| Tool | Arguments | Description |
|------|-----------|-------------|
| \`get_workflow_templates\` | \`{}\` | List workflow templates |
| \`get_workflow_template\` | \`{templateName}\` | Get a template |
| \`list_workflow_examples\` | \`{}\` | List golden-path examples |
| \`get_workflow_example\` | \`{exampleName}\` | Get annotated example |

### Validation
| Tool | Arguments | Description |
|------|-----------|-------------|
| \`validate_workflow\` | \`{nodes, connections}\` | Validate before creating |

### Metadata
| Tool | Arguments | Description |
|------|-----------|-------------|
| \`list_tags\` | \`{}\` | List workflow tags |
| \`create_tag\` | \`{name}\` | Create a tag |
| \`list_credentials\` | \`{}\` | List credentials |
| \`get_credential_schema\` | \`{credentialType}\` | Get credential schema |
| \`list_variables\` | \`{}\` | List environment variables |
| \`run_audit\` | \`{categories?}\` | Run security audit |

## Recommended workflow development cycle

1. \`list_workflow_examples\` - find a similar pattern
2. \`get_node_schema\` - check parameters for each node
3. \`validate_workflow\` - verify definition before creating
4. \`create_workflow\` - deploy it
5. \`self_heal_workflow\` - test and get fix suggestions
6. \`update_workflow\` - apply fixes
7. Repeat 5-6 until all nodes pass
`;

// ============ SERVER FACTORY ============

function createServer(): McpServer {
  const server = new McpServer({
    name: "n8n-mcp-server",
    version: packageJson.version,
  });

  registerTools(server, n8nClient);
  registerResources(server, n8nClient);

  return server;
}

// ============ STDIO MODE ============

async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  serverLogger.info({ n8nUrl: config.n8nApiUrl }, "MCP server running in stdio mode");
}

// ============ HTTP MODE ============

function createCorsOptions() {
  // In production, require explicit allowed origins
  if (config.nodeEnv === "production") {
    if (config.allowedOrigins.length === 0) {
      serverLogger.warn(
        "No ALLOWED_ORIGINS set in production - CORS will reject all cross-origin requests"
      );
    }
    return {
      origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : false,
      exposedHeaders: ["mcp-session-id"],
      allowedHeaders: ["Content-Type", "mcp-session-id", "Authorization"],
      credentials: true,
    };
  }

  // In development, allow all origins
  return {
    origin: true,
    exposedHeaders: ["mcp-session-id"],
    allowedHeaders: ["Content-Type", "mcp-session-id", "Authorization"],
  };
}

function setupMiddleware(app: Express): void {
  // Security headers
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    if (config.nodeEnv === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  app.use(express.json({ limit: "1mb" }));
  app.use(cors(createCorsOptions()));

  // Request logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      serverLogger.info({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration: Date.now() - start,
      });
    });
    next();
  });

  // Rate limiting
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { error: "Rate limit exceeded - try again later" },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use("/mcp", limiter);
}

/**
 * Bearer-token gate for every route that can reach the n8n API key held server-side.
 * Fails closed: without a long enough MCP_AUTH_TOKEN the protected routes serve 503.
 */
export function createAuthMiddleware(token: string) {
  const configured = token.length >= MIN_AUTH_TOKEN_LENGTH;
  // Hashing gives two equal-length buffers, so timingSafeEqual never throws and
  // never short-circuits on a length difference.
  const expected = createHash("sha256").update(token).digest();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!configured) {
      res.status(503).json({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32001,
          message: "Server is not configured for authenticated access. Set MCP_AUTH_TOKEN.",
        },
      });
      return;
    }

    const presented = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1] || "";
    if (!timingSafeEqual(createHash("sha256").update(presented).digest(), expected)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      res.status(401).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Unauthorized. Send Authorization: Bearer <token>." },
      });
      return;
    }

    next();
  };
}

function setupRoutes(app: Express, requireAuth: ReturnType<typeof createAuthMiddleware>): void {
  // Every /mcp method and /docs is authenticated; /health stays open for liveness probes.
  app.use("/mcp", requireAuth);

  // MCP endpoint - stateless mode
  app.post("/mcp", async (req: Request, res: Response) => {
    const requestId = Math.random().toString(36).slice(2, 11);
    const reqLogger = serverLogger.child({ requestId });

    try {
      reqLogger.debug("Processing MCP request");

      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless
      });

      res.on("close", () => {
        transport.close();
        reqLogger.debug("Transport closed");
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      reqLogger.error({ error: (error as Error).message }, "MCP request failed");

      if (!res.headersSent) {
        res.status(500).json({
          error: config.nodeEnv === "production"
            ? "Internal server error"
            : (error as Error).message,
        });
      }
    }
  });

  // Method not allowed for GET on /mcp
  app.get("/mcp", (req: Request, res: Response) => {
    res.status(405).json({
      error: "Method not allowed",
      message: "Use POST for MCP requests",
    });
  });

  // Session cleanup acknowledgment (stateless mode)
  app.delete("/mcp", (req: Request, res: Response) => {
    res.status(200).json({ message: "Session cleanup acknowledged" });
  });

  // Health check
  app.get("/health", (req: Request, res: Response) => {
    res.json({
      status: "ok",
      mode: "http",
      version: packageJson.version,
      uptime: process.uptime(),
    });
  });

  // Claude instructions endpoint - serves markdown that teaches Claude how to call MCP tools
  app.get("/docs", requireAuth, (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.send(CLAUDE_DOCS);
  });

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });
}

/** Builds the fully wired Express app. The token argument keeps it testable in process. */
export function createApp(authToken: string = config.mcpAuthToken): Express {
  const app = express();

  setupMiddleware(app);
  setupRoutes(app, createAuthMiddleware(authToken));

  return app;
}

const httpApp = createApp();
export default httpApp;

async function startHttpServer(): Promise<() => Promise<void>> {
  return new Promise((resolve) => {
    const server = httpApp.listen(config.port, () => {
      serverLogger.info({
        port: config.port,
        n8nUrl: config.n8nApiUrl,
        env: config.nodeEnv,
      }, "MCP server running");

      serverLogger.info(`Health check: http://localhost:${config.port}/health`);
      serverLogger.info(`MCP endpoint: http://localhost:${config.port}/mcp`);

      // Return shutdown function
      resolve(async () => {
        return new Promise<void>((resolveShutdown, rejectShutdown) => {
          serverLogger.info("Shutting down gracefully...");

          server.close((err) => {
            if (err) {
              serverLogger.error({ error: err.message }, "Error during shutdown");
              rejectShutdown(err);
            } else {
              serverLogger.info("Server closed");
              resolveShutdown();
            }
          });

          // Force close after timeout
          setTimeout(() => {
            serverLogger.warn("Forcing shutdown after timeout");
            resolveShutdown();
          }, 10000);
        });
      });
    });

    // Handle server errors
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        serverLogger.fatal({ port: config.port }, "Port already in use");
        process.exit(1);
      }
      serverLogger.error({ error: error.message }, "Server error");
    });
  });
}

// ============ GRACEFUL SHUTDOWN ============

function setupGracefulShutdown(shutdown: () => Promise<void>): void {
  let isShuttingDown = false;

  const handleShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    serverLogger.info({ signal }, "Received shutdown signal");

    try {
      await shutdown();
      process.exit(0);
    } catch (error) {
      serverLogger.error({ error: (error as Error).message }, "Shutdown error");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  process.on("SIGINT", () => handleShutdown("SIGINT"));

  // Handle uncaught errors
  process.on("uncaughtException", (error) => {
    serverLogger.fatal({ error: error.message, stack: error.stack }, "Uncaught exception");
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    serverLogger.fatal({ reason }, "Unhandled rejection");
    process.exit(1);
  });
}

// ============ MAIN ============

async function main(): Promise<void> {
  serverLogger.info({
    mode: isStdioMode ? "stdio" : "http",
    nodeEnv: config.nodeEnv,
  }, "Starting n8n MCP server");

  if (isStdioMode) {
    await startStdioServer();
    // stdio mode doesn't need graceful shutdown handling
  } else {
    const shutdown = await startHttpServer();
    setupGracefulShutdown(shutdown);
  }
}

// Vercel imports the default Express app. Direct CLI launches still start a listener.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  main().catch((error) => {
    serverLogger.fatal({ error: error.message }, "Fatal error during startup");
    process.exit(1);
  });
}
