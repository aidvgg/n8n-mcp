/**
 * Test harness that exercises the registered MCP tools the way a real client does.
 *
 * It wires a real McpServer (with registerTools applied) to a real MCP Client over
 * the SDK's in-memory transport pair, backed by an N8nClient pointed at the
 * in-process fake n8n HTTP server. Nothing here reaches a real n8n instance and
 * no private server field is touched: every call goes through client.callTool.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { N8nClient } from "../n8n-client.js";
import { registerTools } from "../tools.js";
import { createMockN8nServer } from "./mock-n8n-server.js";

export type MockN8nServer = ReturnType<typeof createMockN8nServer>;

export interface ToolCallResult {
  text: string;
  isError: boolean;
}

export interface McpHarness {
  mock: MockN8nServer;
  n8nClient: N8nClient;
  /** Invoke a registered tool through the MCP protocol and flatten its text content. */
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
  /** Tool names the server advertises over tools/list. */
  listToolNames(): Promise<string[]>;
  stop(): Promise<void>;
}

export async function createMcpHarness(): Promise<McpHarness> {
  const mock = createMockN8nServer();
  const { baseUrl } = await mock.start();

  const n8nClient = new N8nClient(baseUrl, "test-api-key", {
    timeout: 5000,
    maxRetries: 1,
    retryDelay: 10,
  });

  const server = new McpServer({ name: "n8n-mcp-under-test", version: "1.0.0" });
  registerTools(server, n8nClient);

  const client = new Client({ name: "tool-handler-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    mock,
    n8nClient,

    async callTool(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
      return {
        text: content.map((c) => c.text ?? "").join("\n"),
        isError: result.isError === true,
      };
    },

    async listToolNames() {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name);
    },

    async stop() {
      await client.close();
      await server.close();
      await mock.stop();
    },
  };
}

/** Minimal valid workflow definition used by many tool tests. */
export const SAMPLE_NODES = [
  {
    name: "Manual Trigger",
    type: "n8n-nodes-base.manualTrigger",
    position: [250, 300],
    parameters: {},
  },
  {
    name: "Set Data",
    type: "n8n-nodes-base.set",
    position: [450, 300],
    parameters: { mode: "manual" },
  },
];

export const SAMPLE_CONNECTIONS = {
  "Manual Trigger": { main: [[{ node: "Set Data", type: "main", index: 0 }]] },
};

export const SAMPLE_SETTINGS = { executionOrder: "v1" };

/** Create a workflow through the create_workflow tool and return its n8n id. */
export async function createWorkflowViaTool(harness: McpHarness, name: string): Promise<string> {
  const result = await harness.callTool("create_workflow", {
    name,
    nodes: SAMPLE_NODES,
    connections: SAMPLE_CONNECTIONS,
    settings: SAMPLE_SETTINGS,
  });
  if (result.isError) {
    throw new Error(`create_workflow failed: ${result.text}`);
  }
  const match = result.text.match(/^ID: (\S+)$/m);
  if (!match) {
    throw new Error(`create_workflow returned no workflow ID:\n${result.text}`);
  }
  return match[1];
}
