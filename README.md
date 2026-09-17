# n8n-mcp

[![CI](https://github.com/aidvgg/n8n-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/aidvgg/n8n-mcp/actions/workflows/ci.yml)

Lets an AI assistant build, run and fix [n8n](https://n8n.io) automations for you.

Connect it to Claude, Cursor or VS Code and describe the automation you want. The assistant gets 29 typed tools: it checks a workflow against a catalogue of 300+ n8n nodes before creating it, runs it, reads the failure when a step breaks, and gets back concrete fix suggestions it can apply. The checking happens before anything touches your n8n instance.

Built on the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and the n8n public API. Runs over Streamable HTTP (for remote clients like Claude, Cursor, VS Code) or stdio (for local desktop clients).


## Features

- **29 typed tools** spanning workflow management, execution, diagnostics, node intelligence, templates, and validation.
- **Pre-creation validation** - `validate_workflow` checks node types, required parameters, connection integrity, duplicate names, orphan nodes, credentials, and typeVersion mismatches before anything hits n8n.
- **Self-healing loop** - `self_heal_workflow` executes a workflow, diagnoses failures, and returns concrete fix suggestions the agent can apply via `update_workflow`.
- **Node catalogue** kept in sync with n8n `nodes-base` v2.14.0, including current `typeVersion` values for HTTP Request, Postgres, Slack, Gmail, OpenAI, and the newer AI nodes (AI Transform, Data Table, Guardrails, Evaluation, MCP Server Trigger).
- **Golden-path examples** - annotated workflow templates for common patterns (webhook-transform-respond, schedule-fetch-filter-notify, error handling, batch loops).
- **HTTP server hardening** - CORS allow-listing, rate limiting, security headers, structured logging via pino, and graceful shutdown.
- **Cloud client** - a tiny CLI that talks to a remote MCP endpoint over curl, for environments where `claude mcp add` is unavailable.

## Quick start

```bash
git clone https://github.com/aidvgg/n8n-mcp.git
cd n8n-mcp
npm install
npm run build
```

Create a `.env` file:

```env
N8N_API_URL=https://your-n8n-instance.example.com/api/v1
N8N_API_KEY=your-api-key-here
PORT=3000
NODE_ENV=development
ALLOWED_ORIGINS=https://claude.ai,https://cursor.sh
```

Run it:

```bash
npm start           # HTTP server on PORT (default 3000)
npm run start:stdio # stdio mode for local desktop clients
npm run dev         # watch mode (bun)
```

Health check:

```bash
curl http://localhost:3000/health
```

## Connecting an MCP client

### Claude Code, Cursor, VS Code (Streamable HTTP)

Point your client at `http://localhost:3000/mcp` (or your deployed URL). For Claude Code:

```bash
claude mcp add n8n https://your-deployment.example.com/mcp
```

### Claude Desktop (stdio)

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "n8n": {
      "command": "node",
      "args": ["/absolute/path/to/n8n-mcp/dist/server.js", "--stdio"],
      "env": {
        "N8N_API_URL": "https://your-n8n.example.com/api/v1",
        "N8N_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Cloud sessions (no `mcp add` available)

Use the bundled cloud client to call tools directly:

```bash
node dist/cloud-client.js https://your-deployment.example.com/mcp list-tools
node dist/cloud-client.js https://your-deployment.example.com/mcp call list_workflows '{}'
node dist/cloud-client.js https://your-deployment.example.com/mcp call execute_workflow '{"workflowId":"123"}'
```

The default URL can be overridden with the `MCP_SERVER_URL` environment variable.

## Available tools

### Workflow management
| Tool | Arguments | Description |
|------|-----------|-------------|
| `list_workflows` | `{active?, tags?, name?, limit?}` | List workflows with filters |
| `get_workflow` | `{workflowId}` | Full workflow definition |
| `create_workflow` | `{name, nodes, connections, settings}` | Create a workflow |
| `update_workflow` | `{workflowId, name?, nodes?, connections?, settings?}` | Update a workflow |
| `delete_workflow` | `{workflowId}` | Delete a workflow |
| `activate_workflow` / `deactivate_workflow` | `{workflowId}` | Toggle active state |

### Execution
| Tool | Arguments | Description |
|------|-----------|-------------|
| `list_executions` | `{workflowId?, status?, limit?}` | List executions |
| `get_execution` | `{executionId}` | Execution details and run data |
| `delete_execution` | `{executionId}` | Delete an execution record |
| `execute_webhook` | `{webhookPath, data?, username?, password?}` | Trigger via webhook |
| `execute_workflow` | `{workflowId, payload?, timeoutMs?}` | Execute and wait for results |

### Diagnostics and self-healing
| Tool | Arguments | Description |
|------|-----------|-------------|
| `diagnose_execution` | `{executionId}` | Analyze errors in an execution |
| `self_heal_workflow` | `{workflowId, payload?, timeoutMs?}` | Execute, diagnose, suggest fixes |

### Node intelligence
| Tool | Arguments | Description |
|------|-----------|-------------|
| `get_node_types` | `{category?}` | List nodes by category |
| `get_node_schema` | `{nodeType}` | Parameter schema for a node |
| `search_nodes` | `{query}` | Keyword search across the catalogue |
| `get_expression_help` | `{topic?}` | n8n expression syntax reference |

### Templates and examples
| Tool | Arguments | Description |
|------|-----------|-------------|
| `get_workflow_templates` | `{}` | List built-in templates |
| `get_workflow_template` | `{templateName}` | Fetch a template |
| `list_workflow_examples` | `{}` | List golden-path examples |
| `get_workflow_example` | `{exampleName}` | Annotated example workflow |

### Validation
| Tool | Arguments | Description |
|------|-----------|-------------|
| `validate_workflow` | `{nodes, connections}` | Check a definition before creating it |

### Metadata
| Tool | Arguments | Description |
|------|-----------|-------------|
| `list_tags` / `create_tag` | `{}` / `{name}` | Workflow tags |
| `list_credentials` | `{}` | List credentials |
| `get_credential_schema` | `{credentialType}` | Credential parameter schema |
| `list_variables` | `{}` | Environment variables |
| `run_audit` | `{categories?}` | n8n security audit |

## Recommended workflow development cycle

1. `list_workflow_examples` - find a similar pattern
2. `get_node_schema` - confirm parameters for each node
3. `validate_workflow` - verify the definition before creation
4. `create_workflow` - deploy it
5. `self_heal_workflow` - execute and collect fix suggestions
6. `update_workflow` - apply the fixes
7. Repeat 5–6 until every node passes

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `N8N_API_URL` | `http://localhost:5678/api/v1` | n8n REST API base URL |
| `N8N_API_KEY` | _(required)_ | n8n API key |
| `PORT` | `3000` | HTTP server port |
| `NODE_ENV` | `development` | In `production`, CORS requires `ALLOWED_ORIGINS` |
| `ALLOWED_ORIGINS` | _(empty)_ | Comma-separated CORS allow-list |
| `REQUEST_TIMEOUT` | `30000` | n8n client request timeout (ms) |
| `MAX_RETRIES` | `3` | n8n client retry count |
| `DOTENV_CONFIG_PATH` | _(unset)_ | Load `.env` from a custom path (useful when running the server from another project) |

## HTTP endpoints

| Path | Method | Purpose |
|------|--------|---------|
| `/mcp` | POST | MCP JSON-RPC (Streamable HTTP) |
| `/mcp` | DELETE | Session cleanup acknowledgment |
| `/health` | GET | Liveness check with uptime and n8n target |
| `/docs` | GET | Markdown reference designed for AI agents calling the server via curl |

## Development

```bash
npm run dev         # watch mode via bun
npm run build       # compile TypeScript to dist/
npm run typecheck   # type-check without emitting
bun test            # run the test suite
bun test --coverage # with coverage report
npm run inspector   # launch the MCP Inspector against this server
```

The codebase is laid out as:

```
src/
  server.ts        # HTTP + stdio entry point, transport wiring
  tools.ts         # Tool registration and validation logic
  resources.ts     # MCP resource handlers (workflows, executions)
  n8n-client.ts    # n8n REST API client with retries and timeouts
  node-catalog.ts  # Node schemas, categories, search
  examples.ts      # Golden-path workflow examples
  expressions/    # n8n expression reference
  templates/      # Built-in workflow templates
  nodes/          # Per-integration node definitions
  cloud-client.ts  # Standalone CLI for remote MCP calls
  logger.ts        # pino setup
```

## License

MIT.
