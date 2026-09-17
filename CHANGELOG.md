# Changelog

All notable changes to this project will be documented in this file.

## [1.6.0] - 2026-09-17

### Security
- **Breaking:** the HTTP transport now requires a bearer token. Set `MCP_AUTH_TOKEN` (at least 32 characters, e.g. `openssl rand -hex 32`) and send `Authorization: Bearer <token>` on every `/mcp` and `/docs` request. Previously both endpoints were anonymous, so any caller who could reach the server could run all 29 tools, including `delete_workflow` and `execute_workflow`, using the n8n API key held server-side.
- Fails closed: if `MCP_AUTH_TOKEN` is unset or shorter than 32 characters, `/mcp` and `/docs` return 503 and the server logs a warning at startup. There is no unauthenticated mode.
- Tokens are compared with `crypto.timingSafeEqual` over SHA-256 digests, so the comparison is constant time and does not leak token length.
- `/health` is unchanged and stays unauthenticated.
- stdio mode is unchanged and needs no token.
- `Authorization` added to the CORS allowed-headers list.
- `cloud-client` sends `MCP_AUTH_TOKEN` as the bearer token and errors if it is not set.

### Changed
- `createApp()` and `createAuthMiddleware()` are exported and the server only auto-starts when run as the entrypoint, so the HTTP routes can be tested in process.
- Server tests now start the real app on an ephemeral port instead of silently skipping when nothing is listening on port 3000.

## [1.5.0] - 2026-03-27

### Updated
- Node catalogue updated to match n8n v2.14.0 (nodes-base)
- HTTP Request node: 4.2 → 4.4
- Google Sheets node: 4 → 4.7
- Postgres node: 2 → 2.6
- MySQL node: 2 → 2.5
- Slack node: 2 → 2.4
- Gmail node: 2 → 2.2
- HubSpot node: 2 → 2.2
- Switch node: 3.2 → 3.4
- Merge node: 3 → 3.2
- If node: 2.2 → 2.3
- Filter node: 2.2 → 2.3
- Form Trigger node: 2 → 2.5
- Respond to Webhook node: 1.1 → 1.5
- Webhook node: 2 → 2.1
- Schedule Trigger node: 1.2 → 1.3
- Crypto node: 1 → 2
- Execute Workflow node: 1 → 1.3
- HTML node: 1 → 1.2
- Notion node: 2 → 2.2
- Todoist node: 2 → 2.2
- Airtable node: 2 → 2.2
- Microsoft Excel node: 2 → 2.2
- Google Calendar node: 1 → 1.3
- MongoDB node: 1 → 1.2
- Telegram node: 1 → 1.2
- Linear node: 1 → 1.1
- GitHub node: 1 → 1.1
- Google BigQuery node: 2 → 2.1
- OpenAI node: 1 → 1.1

### Added
- AI Transform node - transform data using natural language instructions
- Data Table node - display and manipulate data in table format
- Evaluation node - evaluate AI model outputs for testing and benchmarking
- Guardrails node - apply input/output guardrails for AI safety
- Evaluation Trigger - trigger evaluation runs
- MCP Server Trigger - expose workflows as MCP tools for AI agents

### Fixed
- Removed duplicate node entries (SSH, FTP, Email Send, Item Lists) between core.ts and integration files
- Resolved typeVersion inconsistencies for nodes appearing in multiple catalogue files

## [1.4.0] - 2026-03-13

### Added
- `validate_workflow` tool - pre-creation validation that checks node types, required parameters, connection integrity, duplicate names, orphan nodes, credential types, position overlaps, and typeVersion mismatches
- 6 golden-path workflow examples with per-node annotations explaining configuration choices:
  - `webhook-transform-respond` - API endpoint pattern
  - `schedule-fetch-filter-notify` - scheduled data processing with filtering
  - `manual-branch-merge` - IF branching with Merge node
  - `error-handling-pattern` - error output handling with `continueErrorOutput`
  - `loop-batch-processing` - Split In Batches loop with rate-limit delays
  - `switch-multi-path` - multi-path routing with Switch node and fallback
- `list_workflow_examples` and `get_workflow_example` tools for discovering and retrieving examples
- MCP resources `n8n://examples` and `n8n://examples/{name}` for direct resource access
- New `src/examples.ts` module with `WorkflowExample` type definitions

### Improved
- `create_workflow` description now includes a pre-creation checklist (examples → schema → credentials → validate)
- `self_heal_workflow` description now documents the full recommended development cycle

## [1.3.0] - 2026-03-13

### Added
- Self-healing workflow tools: `execute_workflow`, `diagnose_execution`, `self_heal_workflow`
- 9-category error classification for automated workflow debugging
- Integration tests with mock n8n API server
- E2E self-healing test suite
- Unit tests for self-healing features (61 total tests)

### Fixed
- Missing template connection in workflow templates

### Improved
- `create_workflow` docs now include `typeVersion` hint

## [1.2.0] - 2026-03-13

### Fixed
- Workflow creation using wrong node `typeVersion` (always defaulted to 1)
- Template parameters updated to match current node type versions

### Added
- `bun-types` dev dependency for TypeScript compilation

## [1.1.0] - 2026-03-13

### Added
- Comprehensive node catalog schemas for 303+ n8n nodes (core, integration, utility)
- New nodes: LDAP, TOTP, Execution Data, Debug Helper, Item Lists, n8n API, Activation Trigger, Chat Trigger, Kafka, MQTT, RabbitMQ, Splunk, AWS services (Textract, Transcribe, Rekognition, Comprehend), Google services (BigQuery, Cloud Natural Language), Cloudflare, Odoo, Mautic, Metabase, Bitwarden
- Modular structure for node catalog organization
- Helper functions for node management
- `dotenv` dependency for environment variable management
- Custom dotenv file path support in server configuration
- Enhanced Slack node descriptions and new operations

### Improved
- Existing node descriptions updated for clarity
- `.gitignore` updated to include `dist` and `.vercel` directories
- Rate limit import refactored to named import syntax

## [1.0.0] - 2026-03-13

### Added
- Initial project structure with MCP server setup
- n8n client integration for workflow management
- Node catalog with base node definitions
- Workflow CRUD tools: `create_workflow`, `update_workflow`, `delete_workflow`, `get_workflow`, `list_workflows`
- Workflow input schemas with settings, nodes, connections
- Express server with rate limiting and CORS
- Stdio transport support
- Zod-based input validation
- Pino structured logging
