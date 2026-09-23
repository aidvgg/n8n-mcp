#!/usr/bin/env node
/**
 * Lightweight CLI client for calling MCP tools on a remote Streamable HTTP server.
 * Designed for use in Claude Cloud sessions where `claude mcp add` is unavailable.
 *
 * Uses Node's built-in fetch so the bearer token stays out of shell arguments.
 *
 * Usage:
 *   node dist/cloud-client.js [url] list-tools
 *   node dist/cloud-client.js [url] call <tool_name> ['<json_args>']
 *
 * The URL can also be set via MCP_SERVER_URL env var.
 */
const DEFAULT_URL = "https://mcp.kratoslabs.agency/mcp";

function usage(): never {
  console.error(`Usage:
  cloud-client [url] list-tools
  cloud-client [url] call <tool_name> ['<json_args>']

URL defaults to MCP_SERVER_URL env var or ${DEFAULT_URL}
MCP_AUTH_TOKEN must be set; it is sent as an Authorization: Bearer header.`);
  process.exit(1);
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

async function mcpRequest(url: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });

  const token = process.env.MCP_AUTH_TOKEN || "";
  if (!token) {
    throw new Error("MCP_AUTH_TOKEN is not set, and the remote MCP endpoint requires a bearer token");
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body,
      signal: AbortSignal.timeout(60000),
      redirect: "error",
    });
  } catch {
    throw new Error("MCP request failed before receiving a response");
  }
  if (!response.ok) {
    throw new Error(`MCP endpoint returned HTTP ${response.status}`);
  }

  const output = await response.text();

  // Parse SSE response: "event: message\ndata: {...}"
  const dataLine = output.split(/\r?\n/).find((line) => line.startsWith("data:"));
  let result: JsonRpcResponse;
  try {
    result = JSON.parse(dataLine ? dataLine.slice(5).trim() : output.trim());
  } catch {
    throw new Error("Unexpected response from MCP endpoint");
  }
  if (result.error) {
    throw new Error(`MCP error ${result.error.code}: ${result.error.message}`);
  }
  return result.result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse URL - first arg if it looks like a URL, otherwise use env/default
  let url: string;
  let commandArgs: string[];

  if (args[0] && (args[0].startsWith("http://") || args[0].startsWith("https://"))) {
    url = args[0];
    commandArgs = args.slice(1);
  } else {
    url = process.env.MCP_SERVER_URL || DEFAULT_URL;
    commandArgs = args;
  }

  const command = commandArgs[0];
  if (!command) usage();

  if (command === "list-tools") {
    const result = await mcpRequest(url, "tools/list") as { tools: Array<{ name: string; description: string }> };
    const summary = result.tools.map((t) => ({
      name: t.name,
      description: t.description,
    }));
    console.log(JSON.stringify(summary, null, 2));
  } else if (command === "call") {
    const toolName = commandArgs[1];
    const toolArgs = commandArgs[2];
    if (!toolName) {
      console.error("Error: tool name required");
      usage();
    }

    let parsedArgs: Record<string, unknown> = {};
    if (toolArgs) {
      try {
        parsedArgs = JSON.parse(toolArgs);
      } catch {
        console.error(`Error: invalid JSON arguments: ${toolArgs}`);
        process.exit(1);
      }
    }

    const result = await mcpRequest(url, "tools/call", { name: toolName, arguments: parsedArgs });
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(`Unknown command: ${command}`);
    usage();
  }
}

main().catch((error) => {
  const token = process.env.MCP_AUTH_TOKEN || "";
  const message = (error as Error).message;
  console.error(`Error: ${token ? message.replaceAll(token, "[redacted]") : message}`);
  process.exit(1);
});
