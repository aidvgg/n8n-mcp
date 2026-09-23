import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import type { Server } from "node:http";
import type { Express } from "express";
import serverlessApp, { createApp } from "../server.js";

const TOKEN = "a".repeat(40);

/** Starts an app on an ephemeral port and returns its base URL plus a stop function. */
async function listen(app: Express): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no ephemeral port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function toolsListRequest(token?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  };
}

describe("HTTP transport authentication", () => {
  let authed: { url: string; stop: () => Promise<void> };
  let unconfigured: { url: string; stop: () => Promise<void> };

  beforeAll(async () => {
    authed = await listen(createApp(TOKEN));
    unconfigured = await listen(createApp(""));
  });

  afterAll(async () => {
    await authed.stop();
    await unconfigured.stop();
  });

  it("rejects POST /mcp with no Authorization header", async () => {
    const res = await fetch(`${authed.url}/mcp`, toolsListRequest());
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    const body = await res.json();
    expect(body.error.message).toContain("Unauthorized");
  });

  it("rejects POST /mcp with a wrong token", async () => {
    const res = await fetch(`${authed.url}/mcp`, toolsListRequest("b".repeat(40)));
    expect(res.status).toBe(401);
  });

  it("rejects a token that is a prefix of the real one", async () => {
    const res = await fetch(`${authed.url}/mcp`, toolsListRequest(TOKEN.slice(0, 20)));
    expect(res.status).toBe(401);
  });

  it("reaches the MCP handler with the right token", async () => {
    const res = await fetch(`${authed.url}/mcp`, toolsListRequest(TOKEN));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("list_workflows");
  });

  it("requires the token on GET and DELETE /mcp", async () => {
    expect((await fetch(`${authed.url}/mcp`)).status).toBe(401);
    expect((await fetch(`${authed.url}/mcp`, { method: "DELETE" })).status).toBe(401);
    const allowed = await fetch(`${authed.url}/mcp`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(allowed.status).toBe(405);
  });

  it("requires the token on /docs", async () => {
    expect((await fetch(`${authed.url}/docs`)).status).toBe(401);
    const allowed = await fetch(`${authed.url}/docs`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(allowed.status).toBe(200);
  });

  it("fails closed with 503 when MCP_AUTH_TOKEN is unset", async () => {
    const res = await fetch(`${unconfigured.url}/mcp`, toolsListRequest());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.message).toContain("not configured for authenticated access");
  });

  it("fails closed with 503 even when a token is presented", async () => {
    const res = await fetch(`${unconfigured.url}/mcp`, toolsListRequest(TOKEN));
    expect(res.status).toBe(503);
  });

  it("fails closed when the token is shorter than 32 characters", async () => {
    const short = await listen(createApp("short-token"));
    const res = await fetch(`${short.url}/mcp`, toolsListRequest("short-token"));
    expect(res.status).toBe(503);
    await short.stop();
  });

  it("leaves /health unauthenticated and free of secrets", async () => {
    const res = await fetch(`${authed.url}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.mode).toBe("http");
    expect(Object.keys(body).sort()).toEqual(["mode", "status", "uptime", "version"]);
  });

  it("still returns 404 for unknown routes without a token", async () => {
    const res = await fetch(`${authed.url}/unknown`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Not found");
  });
});

describe("serverless entrypoint", () => {
  it("exports an Express handler for Vercel", async () => {
    expect(typeof serverlessApp).toBe("function");
    const server = await listen(serverlessApp);
    try {
      const res = await fetch(`${server.url}/health`);
      expect(res.status).toBe(200);
    } finally {
      await server.stop();
    }
  });
});

describe("stdio entrypoint", () => {
  it("writes only MCP messages to stdout", () => {
    const request = {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    };
    const result = spawnSync("node", ["dist/server.js", "--stdio"], {
      input: `${JSON.stringify(request)}\n`,
      encoding: "utf8",
      timeout: 3000,
      env: { PATH: process.env.PATH || "", NODE_ENV: "production", DOTENV_CONFIG_PATH: "/dev/null", N8N_API_KEY: "test", LOG_LEVEL: "silent" },
    });
    const firstLine = result.stdout.trim().split("\n")[0];
    expect(JSON.parse(firstLine).jsonrpc).toBe("2.0");
  });
});
