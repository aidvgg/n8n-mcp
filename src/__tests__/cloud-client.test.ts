import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const node = Bun.which("node");
if (!node) throw new Error("Node.js is required for the cloud client test");

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (url: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  try {
    await run(`http://127.0.0.1:${address.port}/mcp`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function runClient(url: string, token: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(node!, ["dist/cloud-client.js", url, "list-tools"], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: "", MCP_AUTH_TOKEN: token },
    timeout: 10000,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { code, stdout, stderr };
}

describe("cloud client authentication", () => {
  it("sends the bearer header without a shell or curl", async () => {
    const token = randomBytes(32).toString("hex");
    let authorized = false;
    let method = "";
    await withServer((request, response) => {
      authorized = request.headers.authorization === `Bearer ${token}`;
      method = request.method || "";
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"safe_tool","description":"Test"}]}}\n\n');
    }, async (url) => {
      const result = await runClient(url, token);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([{ name: "safe_tool", description: "Test" }]);
      expect(result.stderr.includes(token)).toBe(false);
    });
    expect(authorized).toBe(true);
    expect(method).toBe("POST");
  });

  it("does not echo a token reflected in an HTTP error body", async () => {
    const token = randomBytes(32).toString("hex");
    await withServer((_request, response) => {
      response.writeHead(403, { "Content-Type": "text/plain" });
      response.end(`Bearer ${token}`);
    }, async (url) => {
      const result = await runClient(url, token);
      expect(result.code).toBe(1);
      expect(result.stderr.includes(token)).toBe(false);
      expect(result.stderr).toContain("HTTP 403");
    });
  });
});
