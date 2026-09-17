# n8n-MCP Cloud Access

This project includes a cloud client for calling n8n MCP tools from Claude Cloud sessions (where `claude mcp add` is unavailable).

## Setup (once per session)

```bash
npm run build
export MCP_AUTH_TOKEN=your-token-here
```

The remote endpoint requires a bearer token. `MCP_AUTH_TOKEN` must be set or the cloud client exits
with an error, and the server answers 401. Generate a token with `openssl rand -hex 32`.

## Usage

### List available tools

```bash
node dist/cloud-client.js https://mcp.kratoslabs.agency/mcp list-tools
```

### Call a tool

```bash
node dist/cloud-client.js https://mcp.kratoslabs.agency/mcp call <tool_name> '<json_args>'
```

### Examples

```bash
# List all workflows
node dist/cloud-client.js https://mcp.kratoslabs.agency/mcp call list_workflows '{}'

# Get a specific workflow
node dist/cloud-client.js https://mcp.kratoslabs.agency/mcp call get_workflow '{"workflowId":"123"}'

# Execute a workflow
node dist/cloud-client.js https://mcp.kratoslabs.agency/mcp call execute_workflow '{"workflowId":"123"}'

# Search for nodes
node dist/cloud-client.js https://mcp.kratoslabs.agency/mcp call search_nodes '{"query":"slack"}'
```

## Development

- `npm run dev` - Watch mode (server)
- `npm run build` - Compile TypeScript
- `bun test` - Run tests
- `npm run typecheck` - Type check without emitting
