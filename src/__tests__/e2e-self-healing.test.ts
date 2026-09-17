/**
 * E2E tests: the self-healing lifecycle driven entirely through the MCP tools.
 *
 * Every step below is an MCP tools/call on a real McpServer that registerTools
 * populated, sent over the SDK's in-memory transport by a real MCP Client. The
 * N8nClient behind the tools talks to an in-process fake n8n HTTP server, so the
 * assertions are on the text each tool handler actually returns to a client:
 *
 *   create_workflow -> execute_workflow -> diagnose_execution -> self_heal_workflow
 *     -> update_workflow -> self_heal_workflow (verify)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  createMcpHarness,
  type McpHarness,
  type MockN8nServer,
} from "./mcp-harness.js";
import type { MockExecution, MockWorkflow } from "./mock-n8n-server.js";

let harness: McpHarness;
let mock: MockN8nServer;

/** Read the workflow id out of the create_workflow tool's text response. */
function workflowIdFrom(text: string): string {
  const match = text.match(/^ID: (\S+)$/m);
  if (!match) throw new Error(`No workflow ID in create_workflow output:\n${text}`);
  return match[1];
}

/** Read the execution id out of a self-heal report. */
function executionIdFrom(text: string): string {
  const match = text.match(/^- Execution ID: (\S+)$/m);
  if (!match) throw new Error(`No execution ID in report:\n${text}`);
  return match[1];
}

function failingExecution(
  execId: string,
  failedNode: string,
  error: { message: string; description?: string; stack?: string }
) {
  return (workflow: MockWorkflow): MockExecution => ({
    id: execId,
    finished: true,
    mode: "manual",
    startedAt: new Date().toISOString(),
    stoppedAt: new Date().toISOString(),
    workflowId: workflow.id,
    status: "error",
    retryOf: null,
    retrySuccessId: null,
    data: {
      resultData: {
        runData: Object.fromEntries(
          workflow.nodes.map((node) => [
            node.name,
            [
              node.name === failedNode
                ? { startTime: Date.now(), executionTime: 120, error }
                : {
                    startTime: Date.now(),
                    executionTime: 3,
                    data: { main: [[{ json: { ok: true } }]] },
                  },
            ],
          ])
        ),
        lastNodeExecuted: failedNode,
        error: { message: error.message },
      },
    },
  });
}

beforeAll(async () => {
  harness = await createMcpHarness();
  mock = harness.mock;
});

afterAll(async () => {
  await harness.stop();
});

beforeEach(() => {
  mock.resetExecutionBehavior();
});

describe("E2E: self-healing lifecycle through the MCP tools", () => {
  describe("Happy path: the workflow succeeds", () => {
    let workflowId: string;
    let executionId: string;

    it("Step 1: create_workflow returns an inactive workflow with an id", async () => {
      const result = await harness.callTool("create_workflow", {
        name: "E2E Happy Path",
        nodes: [
          { name: "Manual Trigger", type: "n8n-nodes-base.manualTrigger", position: [250, 300], parameters: {} },
          { name: "Set Data", type: "n8n-nodes-base.set", position: [450, 300], parameters: { mode: "manual" } },
        ],
        connections: { "Manual Trigger": { main: [[{ node: "Set Data", type: "main", index: 0 }]] } },
        settings: { executionOrder: "v1" },
      });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("Workflow created successfully!");
      expect(result.text).toContain("Name: E2E Happy Path");
      expect(result.text).toContain("Active: false");

      workflowId = workflowIdFrom(result.text);
      expect(mock.state.workflows.get(workflowId)!.nodes).toHaveLength(2);
    });

    it("Step 2: execute_workflow reports both nodes running successfully", async () => {
      const result = await harness.callTool("execute_workflow", { workflowId });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("Status: success");
      expect(result.text).toContain("Nodes executed: 2");
      expect(result.text).toMatch(/\[success\] Manual Trigger \(\d+ms\)/);
      expect(result.text).toMatch(/\[success\] Set Data \(\d+ms\)/);
      expect(result.text).toContain("output[0]: 1 items");

      const executionIdMatch = result.text.match(/^Execution ID: (\S+)$/m);
      expect(executionIdMatch).not.toBeNull();
      executionId = executionIdMatch![1];
    });

    it("Step 3: diagnose_execution shows every node passed and none failed", async () => {
      const result = await harness.callTool("diagnose_execution", { executionId });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("### Summary");
      expect(result.text).toContain("- Passed: 2 nodes (Manual Trigger, Set Data)");
      expect(result.text).toContain("- Failed: 0 nodes (none)");
      expect(result.text).not.toContain("### FAILED");
    });

    it("Step 4: self_heal_workflow reports no fixes needed", async () => {
      const result = await harness.callTool("self_heal_workflow", { workflowId });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("# Self-Heal Report: E2E Happy Path (ALL NODES PASSED)");
      expect(result.text).toContain("- Status: success");
      expect(result.text).toContain("## Fix Plan\nNo fixes needed - all nodes executed successfully.");
    });
  });

  describe("Failure path: node error, diagnose, fix, succeed", () => {
    let workflowId: string;
    let failedExecutionId: string;

    it("Step 1: create_workflow deploys a Slack node with no credentials", async () => {
      const result = await harness.callTool("create_workflow", {
        name: "E2E Failure Recovery",
        nodes: [
          { name: "Trigger", type: "n8n-nodes-base.manualTrigger", position: [250, 300], parameters: {} },
          {
            name: "Slack Post",
            type: "n8n-nodes-base.slack",
            position: [450, 300],
            parameters: { channel: "#general", text: "Hello" },
          },
        ],
        connections: { Trigger: { main: [[{ node: "Slack Post", type: "main", index: 0 }]] } },
        settings: { executionOrder: "v1" },
      });

      expect(result.isError).toBe(false);
      workflowId = workflowIdFrom(result.text);
    });

    it("Step 2: self_heal_workflow reports the credential failure with a fix plan", async () => {
      mock.setExecutionBehavior(
        failingExecution("exec-e2e-cred", "Slack Post", {
          message: "No credentials found for 'slackOAuth2Api'",
          description: "Node requires authentication credentials that have not been configured.",
        })
      );

      const result = await harness.callTool("self_heal_workflow", { workflowId });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("# Self-Heal Report: E2E Failure Recovery (ISSUES FOUND)");
      expect(result.text).toContain("- Status: error");
      expect(result.text).toContain("### FAILED: Slack Post");
      expect(result.text).toContain("- Error: No credentials found for 'slackOAuth2Api'");
      expect(result.text).toContain("Classification: CREDENTIALS_MISSING");
      expect(result.text).toContain("- Passed: 1 nodes (Trigger)");
      expect(result.text).toContain("- Failed: 1 nodes (Slack Post)");

      // The fix plan has to name the node, the action, and the credential type.
      expect(result.text).toContain("1 node(s) need fixes:");
      expect(result.text).toContain("### Slack Post (n8n-nodes-base.slack)");
      expect(result.text).toContain("**Fix**: Add or update credentials for this node.");
      expect(result.text).toContain("3. Required credential types: slackApi");
      expect(result.text).toContain("1. Apply fixes using update_workflow");

      failedExecutionId = executionIdFrom(result.text);
      expect(failedExecutionId).toBe("exec-e2e-cred");
    });

    it("Step 3: diagnose_execution on the failed run repeats the root cause", async () => {
      const result = await harness.callTool("diagnose_execution", { executionId: failedExecutionId });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("### FAILED: Slack Post");
      expect(result.text).toContain("- Description: Node requires authentication credentials");
      expect(result.text).toContain("Classification: CREDENTIALS_MISSING");
      expect(result.text).toContain("- Passed: 1 nodes (Trigger)");
    });

    it("Step 4: update_workflow applies the suggested credential fix", async () => {
      const result = await harness.callTool("update_workflow", {
        workflowId,
        nodes: [
          { name: "Trigger", type: "n8n-nodes-base.manualTrigger", position: [250, 300], parameters: {} },
          {
            name: "Slack Post",
            type: "n8n-nodes-base.slack",
            position: [450, 300],
            parameters: { channel: "#general", text: "Hello" },
            credentials: { slackApi: { id: "cred-1", name: "My Slack" } },
          },
        ],
      });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("Workflow updated!");

      const stored = mock.state.workflows.get(workflowId)!;
      expect(stored.nodes).toHaveLength(2);
      expect(stored.nodes[1].credentials).toEqual({ slackApi: { id: "cred-1", name: "My Slack" } });
    });

    it("Step 5: self_heal_workflow verifies the fix and reports all nodes passed", async () => {
      mock.resetExecutionBehavior();

      const result = await harness.callTool("self_heal_workflow", { workflowId });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("# Self-Heal Report: E2E Failure Recovery (ALL NODES PASSED)");
      expect(result.text).toContain("- Status: success");
      expect(result.text).toContain("- Passed: 2 nodes (Trigger, Slack Post)");
      expect(result.text).toContain("- Failed: 0 nodes (none)");
      expect(result.text).toContain("No fixes needed - all nodes executed successfully.");
    });
  });

  describe("Expression failure", () => {
    it("self_heal_workflow classifies an expression error and prescribes the expression fix", async () => {
      const created = await harness.callTool("create_workflow", {
        name: "E2E Expression Error",
        nodes: [
          { name: "Trigger", type: "n8n-nodes-base.manualTrigger", position: [250, 300], parameters: {} },
          {
            name: "Set Fields",
            type: "n8n-nodes-base.set",
            position: [450, 300],
            parameters: { mode: "manual" },
          },
        ],
        connections: { Trigger: { main: [[{ node: "Set Fields", type: "main", index: 0 }]] } },
        settings: { executionOrder: "v1" },
      });
      const workflowId = workflowIdFrom(created.text);

      mock.setExecutionBehavior(
        failingExecution("exec-e2e-expr", "Set Fields", {
          message: "TypeError: Cannot read properties of undefined (reading 'value')",
          description: "Expression evaluation failed",
          stack: "TypeError: Cannot read properties of undefined\n    at Expression.eval\n    at Set.execute",
        })
      );

      const result = await harness.callTool("self_heal_workflow", { workflowId });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("### FAILED: Set Fields");
      expect(result.text).toContain("Classification: EXPRESSION_ERROR");
      expect(result.text).toContain("- Stack: TypeError: Cannot read properties of undefined");
      expect(result.text).toContain("**Fix**: An expression references data that doesn't exist.");
      expect(result.text).toContain("3. Add a Set node before this one to ensure required fields exist");
    });
  });

  describe("Multiple node failures", () => {
    it("diagnose_execution reports every failing branch and keeps the passing ones separate", async () => {
      const created = await harness.callTool("create_workflow", {
        name: "E2E Multi Failure",
        nodes: [
          { name: "Trigger", type: "n8n-nodes-base.manualTrigger", position: [250, 300], parameters: {} },
          { name: "IF Check", type: "n8n-nodes-base.if", position: [450, 300], parameters: {} },
          { name: "Branch A", type: "n8n-nodes-base.httpRequest", position: [650, 200], parameters: {} },
          { name: "Branch B", type: "n8n-nodes-base.slack", position: [650, 400], parameters: {} },
        ],
        connections: {
          Trigger: { main: [[{ node: "IF Check", type: "main", index: 0 }]] },
          "IF Check": {
            main: [
              [{ node: "Branch A", type: "main", index: 0 }],
              [{ node: "Branch B", type: "main", index: 0 }],
            ],
          },
        },
        settings: { executionOrder: "v1" },
      });
      const workflowId = workflowIdFrom(created.text);

      mock.setExecutionBehavior((workflow) => ({
        id: "exec-e2e-multi",
        finished: true,
        mode: "manual",
        startedAt: new Date().toISOString(),
        stoppedAt: new Date().toISOString(),
        workflowId: workflow.id,
        status: "error",
        retryOf: null,
        retrySuccessId: null,
        data: {
          resultData: {
            runData: {
              Trigger: [{ startTime: Date.now(), executionTime: 2, data: { main: [[{ json: {} }]] } }],
              "IF Check": [{ startTime: Date.now(), executionTime: 1, data: { main: [[{ json: {} }]] } }],
              "Branch A": [
                { startTime: Date.now(), executionTime: 5000, error: { message: "Request timed out after 5000ms" } },
              ],
              "Branch B": [
                {
                  startTime: Date.now(),
                  executionTime: 50,
                  error: { message: "401 Unauthorized - invalid_auth", description: "Slack auth failed" },
                },
              ],
            },
            lastNodeExecuted: "Branch A",
            error: { message: "Multiple nodes failed" },
          },
        },
      }));

      await harness.callTool("execute_workflow", { workflowId });
      const result = await harness.callTool("diagnose_execution", { executionId: "exec-e2e-multi" });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("### FAILED: Branch A");
      expect(result.text).toContain("Classification: CONNECTION_ERROR");
      expect(result.text).toContain("### FAILED: Branch B");
      expect(result.text).toContain("Classification: CREDENTIALS_MISSING");
      expect(result.text).toContain("- Passed: 2 nodes (Trigger, IF Check)");
      expect(result.text).toContain("- Failed: 2 nodes (Branch A, Branch B)");
    });
  });

  describe("Slow node detection", () => {
    it("diagnose_execution flags a node slower than 10s on an otherwise clean run", async () => {
      const created = await harness.callTool("create_workflow", {
        name: "E2E Slow Node",
        nodes: [
          { name: "Trigger", type: "n8n-nodes-base.manualTrigger", position: [250, 300], parameters: {} },
          { name: "Fast Node", type: "n8n-nodes-base.set", position: [450, 300], parameters: {} },
          { name: "Slow API", type: "n8n-nodes-base.httpRequest", position: [650, 300], parameters: {} },
        ],
        connections: {
          Trigger: { main: [[{ node: "Fast Node", type: "main", index: 0 }]] },
          "Fast Node": { main: [[{ node: "Slow API", type: "main", index: 0 }]] },
        },
        settings: { executionOrder: "v1" },
      });
      const workflowId = workflowIdFrom(created.text);

      mock.setExecutionBehavior((workflow) => ({
        id: "exec-e2e-slow",
        finished: true,
        mode: "manual",
        startedAt: new Date().toISOString(),
        stoppedAt: new Date().toISOString(),
        workflowId: workflow.id,
        status: "success",
        retryOf: null,
        retrySuccessId: null,
        data: {
          resultData: {
            runData: {
              Trigger: [{ startTime: Date.now(), executionTime: 1, data: { main: [[{ json: {} }]] } }],
              "Fast Node": [{ startTime: Date.now(), executionTime: 5, data: { main: [[{ json: {} }]] } }],
              "Slow API": [
                { startTime: Date.now(), executionTime: 15000, data: { main: [[{ json: { data: "response" } }]] } },
              ],
            },
          },
        },
      }));

      await harness.callTool("execute_workflow", { workflowId });
      const result = await harness.callTool("diagnose_execution", { executionId: "exec-e2e-slow" });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("- Failed: 0 nodes (none)");
      expect(result.text).toContain("- Slow (>10s): Slow API (15000ms)");
      expect(result.text).not.toContain("Fast Node (5ms)");
    });
  });
});
