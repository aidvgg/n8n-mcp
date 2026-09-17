#!/usr/bin/env node
/**
 * Lightweight CLI client for calling MCP tools on a remote Streamable HTTP server.
 * Designed for use in Claude Cloud sessions where `claude mcp add` is unavailable.
 *
 * Uses curl under the hood for maximum compatibility across environments.
 *
 * Usage:
 *   node dist/cloud-client.js [url] list-tools
 *   node dist/cloud-client.js [url] call <tool_name> ['<json_args>']
 *
 * The URL can also be set via MCP_SERVER_URL env var.
 */
import { execSync } from "node:child_process";

const DEFAULT_URL = "https://mcp.kratoslabs.agency/mcp";

function usage(): never {
  console.error(`Usage:
  cloud-client [url] list-tools
  cloud-client [url] call <tool_name> ['<json_args>']

URL defaults to MCP_SERVER_URL env var or ${DEFAULT_URL}`);
  process.exit(1);
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function mcpRequest(url: string, method: string, params: Record<string, unknown> = {}): unknown {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });

  const output = execSync(
    `curl -s -X POST '${url}' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '${body.replace(/'/g, "'\\''")}'`,
    { encoding: "utf-8", timeout: 60000 }
  );

  // Parse SSE response: "event: message\ndata: {...}"
  const lines = output.trim().split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const response: JsonRpcResponse = JSON.parse(line.slice(6));
      if (response.error) {
        throw new Error(`MCP error ${response.error.code}: ${response.error.message}`);
      }
      return response.result;
    }
  }

  // Try parsing as direct JSON (non-SSE response)
  try {
    const response: JsonRpcResponse = JSON.parse(output.trim());
    if (response.error) {
      throw new Error(`MCP error ${response.error.code}: ${response.error.message}`);
    }
    return response.result;
  } catch {
    throw new Error(`Unexpected response: ${output.slice(0, 200)}`);
  }
}

function main(): void {
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
    const result = mcpRequest(url, "tools/list") as { tools: Array<{ name: string; description: string }> };
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

    const result = mcpRequest(url, "tools/call", { name: toolName, arguments: parsedArgs });
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(`Unknown command: ${command}`);
    usage();
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${(error as Error).message}`);
  process.exit(1);
}
