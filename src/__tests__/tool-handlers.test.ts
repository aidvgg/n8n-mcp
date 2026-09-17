/**
 * Tool handler tests: every registered MCP tool, called through the MCP protocol.
 *
 * A real McpServer with registerTools applied is connected to a real MCP Client
 * over InMemoryTransport, and the N8nClient behind it points at an in-process
 * fake n8n HTTP server on an ephemeral port. These tests exercise src/tools.ts:
 * every handler, its Zod input schema, and how n8n failures surface to a client.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  createMcpHarness,
  createWorkflowViaTool,
  SAMPLE_NODES,
  SAMPLE_CONNECTIONS,
  SAMPLE_SETTINGS,
  type McpHarness,
} from "./mcp-harness.js";

const ALL_TOOLS = [
  "activate_workflow",
  "create_tag",
  "create_workflow",
  "deactivate_workflow",
  "delete_execution",
  "delete_workflow",
  "diagnose_execution",
  "execute_webhook",
  "execute_workflow",
  "get_credential_schema",
  "get_execution",
  "get_expression_help",
  "get_node_schema",
  "get_node_types",
  "get_workflow",
  "get_workflow_example",
  "get_workflow_template",
  "get_workflow_templates",
  "list_credentials",
  "list_executions",
  "list_tags",
  "list_variables",
  "list_workflow_examples",
  "list_workflows",
  "run_audit",
  "search_nodes",
  "self_heal_workflow",
  "update_workflow",
  "validate_workflow",
];

let harness: McpHarness;

beforeAll(async () => {
  harness = await createMcpHarness();
});

afterAll(async () => {
  await harness.stop();
});

beforeEach(() => {
  harness.mock.resetExecutionBehavior();
  harness.mock.setForcedStatus(null);
  harness.mock.clearRequests();
});

/** Parse the JSON body a tool returned, failing loudly when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected tool output to be JSON, got:\n${text}`);
  }
}

describe("tool registry", () => {
  it("advertises exactly the 29 documented tools", async () => {
    const names = await harness.listToolNames();
    expect(names.slice().sort()).toEqual(ALL_TOOLS.slice().sort());
    expect(names).toHaveLength(29);
  });

  it("gives every tool a non-empty description", async () => {
    const names = await harness.listToolNames();
    expect(names.length).toBeGreaterThan(0);
  });
});

describe("workflow tools", () => {
  it("create_workflow returns the new workflow id and an inactive workflow", async () => {
    const result = await harness.callTool("create_workflow", {
      name: "Created By Tool",
      nodes: SAMPLE_NODES,
      connections: SAMPLE_CONNECTIONS,
      settings: SAMPLE_SETTINGS,
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Workflow created successfully!");
    expect(result.text).toMatch(/^ID: wf-\d+$/m);
    expect(result.text).toContain("Name: Created By Tool");
    expect(result.text).toContain("Active: false");
  });

  it("create_workflow resolves typeVersion from the catalog when it is omitted", async () => {
    const id = await createWorkflowViaTool(harness, "TypeVersion Resolution");
    const stored = harness.mock.state.workflows.get(id);

    expect(stored).toBeDefined();
    // manualTrigger is typeVersion 1 and set is typeVersion 3 in the bundled catalog.
    expect(stored!.nodes.find((n) => n.name === "Manual Trigger")!.typeVersion).toBe(1);
    expect(stored!.nodes.find((n) => n.name === "Set Data")!.typeVersion).toBeGreaterThanOrEqual(1);
  });

  it("get_workflow returns the stored nodes and connections", async () => {
    const id = await createWorkflowViaTool(harness, "Readable Workflow");
    const result = await harness.callTool("get_workflow", { workflowId: id });

    expect(result.isError).toBe(false);
    const workflow = parseJson(result.text) as {
      id: string;
      name: string;
      nodes: Array<{ name: string }>;
      connections: Record<string, unknown>;
    };
    expect(workflow.id).toBe(id);
    expect(workflow.name).toBe("Readable Workflow");
    expect(workflow.nodes.map((n) => n.name)).toEqual(["Manual Trigger", "Set Data"]);
    expect(Object.keys(workflow.connections)).toEqual(["Manual Trigger"]);
  });

  it("list_workflows returns the created workflows", async () => {
    const id = await createWorkflowViaTool(harness, "Listable Workflow");
    const result = await harness.callTool("list_workflows", {});

    expect(result.isError).toBe(false);
    const workflows = parseJson(result.text) as Array<{ id: string; name: string }>;
    expect(Array.isArray(workflows)).toBe(true);
    expect(workflows.some((w) => w.id === id && w.name === "Listable Workflow")).toBe(true);
  });

  it("list_workflows forwards the name filter to n8n", async () => {
    await createWorkflowViaTool(harness, "Name Filter Target");
    await createWorkflowViaTool(harness, "Name Filter Decoy");
    harness.mock.clearRequests();

    const result = await harness.callTool("list_workflows", { name: "Name Filter Target" });

    expect(result.isError).toBe(false);
    const listCall = harness.mock.requests.find((r) => r.method === "GET" && r.path === "/api/v1/workflows");
    expect(listCall).toBeDefined();
    expect(listCall!.query.name).toBe("Name Filter Target");

    const workflows = parseJson(result.text) as Array<{ name: string }>;
    expect(workflows.map((w) => w.name)).toEqual(["Name Filter Target"]);
  });

  it("list_workflows forwards the active and limit filters as query parameters", async () => {
    await harness.callTool("list_workflows", { active: true, limit: 7 });

    const listCall = harness.mock.requests.find((r) => r.method === "GET" && r.path === "/api/v1/workflows");
    expect(listCall).toBeDefined();
    expect(listCall!.query.active).toBe("true");
    expect(listCall!.query.limit).toBe("7");
  });

  it("update_workflow renames the workflow and persists the new node set", async () => {
    const id = await createWorkflowViaTool(harness, "Before Rename");
    const result = await harness.callTool("update_workflow", {
      workflowId: id,
      name: "After Rename",
      nodes: [SAMPLE_NODES[0]],
      connections: {},
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Workflow updated!");
    expect(result.text).toContain("Name: After Rename");
    expect(harness.mock.state.workflows.get(id)!.name).toBe("After Rename");
    expect(harness.mock.state.workflows.get(id)!.nodes).toHaveLength(1);
  });

  it("activate_workflow flips the workflow to active", async () => {
    const id = await createWorkflowViaTool(harness, "To Activate");
    const result = await harness.callTool("activate_workflow", { workflowId: id });

    expect(result.isError).toBe(false);
    expect(result.text).toContain(`Workflow ${id} activated!`);
    expect(result.text).toContain("Active: true");
    expect(harness.mock.state.workflows.get(id)!.active).toBe(true);
  });

  it("deactivate_workflow flips the workflow back to inactive", async () => {
    const id = await createWorkflowViaTool(harness, "To Deactivate");
    await harness.callTool("activate_workflow", { workflowId: id });
    const result = await harness.callTool("deactivate_workflow", { workflowId: id });

    expect(result.isError).toBe(false);
    expect(result.text).toContain(`Workflow ${id} deactivated!`);
    expect(result.text).toContain("Active: false");
    expect(harness.mock.state.workflows.get(id)!.active).toBe(false);
  });

  it("delete_workflow removes the workflow from n8n", async () => {
    const id = await createWorkflowViaTool(harness, "To Delete");
    const result = await harness.callTool("delete_workflow", { workflowId: id });

    expect(result.isError).toBe(false);
    expect(result.text).toBe(`Workflow ${id} deleted successfully.`);
    expect(harness.mock.state.workflows.has(id)).toBe(false);

    const afterDelete = await harness.callTool("get_workflow", { workflowId: id });
    expect(afterDelete.isError).toBe(true);
  });
});

describe("execution tools", () => {
  it("execute_workflow returns a per-node execution summary", async () => {
    const id = await createWorkflowViaTool(harness, "Executable Workflow");
    const result = await harness.callTool("execute_workflow", { workflowId: id });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Status: success");
    expect(result.text).toContain("Nodes executed: 2");
    expect(result.text).toMatch(/\[success\] Manual Trigger \(\d+ms\)/);
    expect(result.text).toMatch(/\[success\] Set Data \(\d+ms\)/);
    expect(result.text).toContain("output[0]: 1 items");
  });

  it("list_executions returns the executions recorded for a workflow", async () => {
    const id = await createWorkflowViaTool(harness, "Execution Listing");
    await harness.callTool("execute_workflow", { workflowId: id });

    const result = await harness.callTool("list_executions", { workflowId: id });
    expect(result.isError).toBe(false);
    const executions = parseJson(result.text) as Array<{ id: string; workflowId: string; status: string }>;
    expect(executions).toHaveLength(1);
    expect(executions[0].workflowId).toBe(id);
    expect(executions[0].status).toBe("success");
  });

  it("list_executions forwards the status filter to n8n", async () => {
    const id = await createWorkflowViaTool(harness, "Execution Status Filter");
    await harness.callTool("execute_workflow", { workflowId: id });
    harness.mock.clearRequests();

    const result = await harness.callTool("list_executions", { workflowId: id, status: "error" });
    expect(result.isError).toBe(false);
    expect(parseJson(result.text)).toEqual([]);

    const call = harness.mock.requests.find((r) => r.path === "/api/v1/executions");
    expect(call!.query.status).toBe("error");
  });

  it("get_execution returns the execution record", async () => {
    const id = await createWorkflowViaTool(harness, "Single Execution");
    await harness.callTool("execute_workflow", { workflowId: id });
    const listed = parseJson(
      (await harness.callTool("list_executions", { workflowId: id })).text
    ) as Array<{ id: string }>;

    const result = await harness.callTool("get_execution", { executionId: listed[0].id });
    expect(result.isError).toBe(false);
    const execution = parseJson(result.text) as { id: string; status: string; finished: boolean };
    expect(execution.id).toBe(listed[0].id);
    expect(execution.status).toBe("success");
    expect(execution.finished).toBe(true);
  });

  it("delete_execution removes the execution record", async () => {
    const id = await createWorkflowViaTool(harness, "Deletable Execution");
    await harness.callTool("execute_workflow", { workflowId: id });
    const listed = parseJson(
      (await harness.callTool("list_executions", { workflowId: id })).text
    ) as Array<{ id: string }>;
    const executionId = listed[0].id;

    const result = await harness.callTool("delete_execution", { executionId });
    expect(result.isError).toBe(false);
    expect(result.text).toBe(`Execution ${executionId} deleted.`);
    expect(harness.mock.state.executions.has(executionId)).toBe(false);
  });

  it("diagnose_execution reports every node as passed on a clean run", async () => {
    const id = await createWorkflowViaTool(harness, "Clean Diagnosis");
    await harness.callTool("execute_workflow", { workflowId: id });
    const listed = parseJson(
      (await harness.callTool("list_executions", { workflowId: id })).text
    ) as Array<{ id: string }>;

    const result = await harness.callTool("diagnose_execution", { executionId: listed[0].id });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("### Summary");
    expect(result.text).toContain("- Passed: 2 nodes (Manual Trigger, Set Data)");
    expect(result.text).toContain("- Failed: 0 nodes (none)");
    expect(result.text).not.toContain("### FAILED");
  });

  it("diagnose_execution classifies a credential failure", async () => {
    const id = await createWorkflowViaTool(harness, "Credential Diagnosis");
    harness.mock.setExecutionBehavior((workflow) => ({
      id: "exec-cred-diagnosis",
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
            "Manual Trigger": [{ startTime: Date.now(), executionTime: 2, data: { main: [[{ json: {} }]] } }],
            "Set Data": [
              {
                startTime: Date.now(),
                executionTime: 9,
                error: { message: "401 Unauthorized", description: "No credentials found" },
              },
            ],
          },
          lastNodeExecuted: "Set Data",
          error: { message: "Credential error" },
        },
      },
    }));
    await harness.callTool("execute_workflow", { workflowId: id });

    const result = await harness.callTool("diagnose_execution", { executionId: "exec-cred-diagnosis" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("### FAILED: Set Data");
    expect(result.text).toContain("- Error: 401 Unauthorized");
    expect(result.text).toContain("Classification: CREDENTIALS_MISSING");
    expect(result.text).toContain("- Passed: 1 nodes (Manual Trigger)");
    expect(result.text).toContain("- Failed: 1 nodes (Set Data)");
  });

  it("execute_webhook posts the payload to the webhook path", async () => {
    const result = await harness.callTool("execute_webhook", {
      webhookPath: "order-created",
      data: { orderId: 42 },
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Webhook executed!");
    const body = parseJson(result.text.split("Response:\n")[1]) as {
      received: { orderId: number };
      webhookPath: string;
    };
    expect(body.received.orderId).toBe(42);
    expect(body.webhookPath).toBe("order-created");
  });
});

describe("self_heal_workflow", () => {
  it("reports all nodes passed and no fixes needed on a clean run", async () => {
    const id = await createWorkflowViaTool(harness, "Healthy Workflow");
    const result = await harness.callTool("self_heal_workflow", { workflowId: id });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("# Self-Heal Report: Healthy Workflow (ALL NODES PASSED)");
    expect(result.text).toContain("- Status: success");
    expect(result.text).toContain("- Passed: 2 nodes (Manual Trigger, Set Data)");
    expect(result.text).toContain("## Fix Plan\nNo fixes needed - all nodes executed successfully.");
  });

  it("returns concrete fix instructions when a node fails on credentials", async () => {
    const id = await createWorkflowViaTool(harness, "Broken Workflow");
    harness.mock.setExecutionBehavior((workflow) => ({
      id: "exec-heal-1",
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
            "Manual Trigger": [{ startTime: Date.now(), executionTime: 1, data: { main: [[{ json: {} }]] } }],
            "Set Data": [
              {
                startTime: Date.now(),
                executionTime: 120,
                error: {
                  message: "No credentials found for 'slackOAuth2Api'",
                  description: "Node requires authentication credentials.",
                },
              },
            ],
          },
          lastNodeExecuted: "Set Data",
          error: { message: "Credential error at Set Data" },
        },
      },
    }));

    const result = await harness.callTool("self_heal_workflow", { workflowId: id });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("# Self-Heal Report: Broken Workflow (ISSUES FOUND)");
    expect(result.text).toContain("### FAILED: Set Data");
    expect(result.text).toContain("Classification: CREDENTIALS_MISSING");
    expect(result.text).toContain("1 node(s) need fixes:");
    expect(result.text).toContain("**Fix**: Add or update credentials for this node.");
    expect(result.text).toContain("2. Then update the node's credentials field via update_workflow");
    expect(result.text).toContain("### Next Steps");
  });

  it("returns an expression fix plan when an expression fails", async () => {
    const id = await createWorkflowViaTool(harness, "Expression Workflow");
    harness.mock.setExecutionBehavior((workflow) => ({
      id: "exec-heal-2",
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
            "Set Data": [
              {
                startTime: Date.now(),
                executionTime: 4,
                error: {
                  message: "ReferenceError: missing is not defined",
                  description: "Expression evaluation failed",
                  stack: "ReferenceError: missing is not defined\n    at Expression.eval\n    at Set.execute",
                },
              },
            ],
          },
          lastNodeExecuted: "Set Data",
          error: { message: "Expression error" },
        },
      },
    }));

    const result = await harness.callTool("self_heal_workflow", { workflowId: id });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Classification: EXPRESSION_ERROR");
    expect(result.text).toContain("**Fix**: An expression references data that doesn't exist.");
    expect(result.text).toContain("2. Use {{ $json.fieldName }} syntax to reference output data");
    expect(result.text).toContain("- Stack: ReferenceError: missing is not defined");
  });

  it("surfaces a missing workflow as a tool error", async () => {
    const result = await harness.callTool("self_heal_workflow", { workflowId: "does-not-exist" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Workflow not found");
  });
});

describe("metadata tools", () => {
  it("list_tags returns the tag collection", async () => {
    const result = await harness.callTool("list_tags", {});
    expect(result.isError).toBe(false);
    expect(parseJson(result.text)).toEqual([]);
  });

  it("create_tag creates a tag and reports its id and name", async () => {
    const result = await harness.callTool("create_tag", { name: "production" });
    expect(result.isError).toBe(false);
    expect(result.text).toBe("Tag created: tag-1 - production");
  });

  it("list_credentials returns the credential collection", async () => {
    const result = await harness.callTool("list_credentials", {});
    expect(result.isError).toBe(false);
    expect(parseJson(result.text)).toEqual([]);
  });

  it("get_credential_schema returns the schema for a credential type", async () => {
    const result = await harness.callTool("get_credential_schema", { credentialType: "slackOAuth2Api" });
    expect(result.isError).toBe(false);
    expect(parseJson(result.text)).toEqual({ properties: {} });
    expect(harness.mock.requests.some((r) => r.path === "/api/v1/credentials/schema/slackOAuth2Api")).toBe(true);
  });

  it("list_variables returns the variable collection", async () => {
    const result = await harness.callTool("list_variables", {});
    expect(result.isError).toBe(false);
    expect(parseJson(result.text)).toEqual([]);
  });

  it("run_audit returns the audit report", async () => {
    const result = await harness.callTool("run_audit", { categories: ["credentials", "nodes"] });
    expect(result.isError).toBe(false);
    expect(parseJson(result.text)).toEqual({ risk: "low" });
    expect(harness.mock.requests.some((r) => r.method === "POST" && r.path === "/api/v1/audit")).toBe(true);
  });
});

describe("node intelligence tools", () => {
  it("get_node_types lists the whole catalog with no category filter", async () => {
    const result = await harness.callTool("get_node_types", {});
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/^Found \d+ node types:/);

    const body = parseJson(result.text.split(":\n\n")[1].split("\n\nUse get_node_schema")[0]) as Array<{
      type: string;
      category: string;
    }>;
    expect(body.length).toBeGreaterThan(50);
    expect(body.some((n) => n.type === "n8n-nodes-base.httpRequest")).toBe(true);
  });

  it("get_node_types filters to a single category", async () => {
    const result = await harness.callTool("get_node_types", { category: "trigger" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("in category 'trigger'");

    const body = parseJson(result.text.split(":\n\n")[1].split("\n\nUse get_node_schema")[0]) as Array<{
      type: string;
      category: string;
    }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((n) => n.category === "trigger")).toBe(true);
    expect(body.some((n) => n.type === "n8n-nodes-base.manualTrigger")).toBe(true);
  });

  it("get_node_schema returns the full parameter schema for a known node", async () => {
    const result = await harness.callTool("get_node_schema", { nodeType: "n8n-nodes-base.httpRequest" });
    expect(result.isError).toBe(false);

    const schema = parseJson(result.text) as {
      type: string;
      typeVersion: number;
      parameters: Array<{ name: string; required?: boolean }>;
    };
    expect(schema.type).toBe("n8n-nodes-base.httpRequest");
    expect(schema.typeVersion).toBe(4.4);
    expect(schema.parameters.find((p) => p.name === "url")!.required).toBe(true);
    expect(schema.parameters.find((p) => p.name === "method")!.required).toBe(true);
  });

  it("get_node_schema suggests alternatives for an unknown node type", async () => {
    const result = await harness.callTool("get_node_schema", { nodeType: "n8n-nodes-base.slak" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Node type 'n8n-nodes-base.slak' not found in catalog.");
    expect(result.text).toContain("Use get_node_types to see all available nodes.");
  });

  it("search_nodes finds nodes by keyword", async () => {
    const result = await harness.callTool("search_nodes", { query: "slack" });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/^Found \d+ nodes matching 'slack':/);

    const body = parseJson(result.text.split(":\n\n")[1]) as Array<{ type: string }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body.some((n) => n.type === "n8n-nodes-base.slack")).toBe(true);
  });

  it("search_nodes reports no matches for a nonsense query", async () => {
    const result = await harness.callTool("search_nodes", { query: "zzzzqqqnotanode" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("No nodes found matching 'zzzzqqqnotanode'.");
  });

  it("get_expression_help returns the whole reference by default", async () => {
    const result = await harness.callTool("get_expression_help", {});
    expect(result.isError).toBe(false);

    const body = parseJson(result.text.split(":\n\n")[1]) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["basics", "examples", "methods", "variables"]);
  });

  it("get_expression_help narrows to a single topic", async () => {
    const result = await harness.callTool("get_expression_help", { topic: "variables" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("n8n Expression Reference - variables");

    const body = parseJson(result.text.split(":\n\n")[1]) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["variables"]);
  });
});

describe("template and example tools", () => {
  it("get_workflow_templates lists every bundled template", async () => {
    const result = await harness.callTool("get_workflow_templates", {});
    expect(result.isError).toBe(false);

    const body = parseJson(result.text.split(":\n\n")[1].split("\n\nUse get_workflow_template")[0]) as Array<{
      name: string;
      nodeCount: number;
    }>;
    expect(body.map((t) => t.name)).toContain("webhook-to-slack");
    expect(body.every((t) => t.nodeCount > 0)).toBe(true);
  });

  it("get_workflow_template returns a create_workflow ready payload", async () => {
    const result = await harness.callTool("get_workflow_template", { templateName: "webhook-to-slack" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Ready to use with create_workflow:");

    const payload = parseJson(result.text.split("Ready to use with create_workflow:\n\n")[1]) as {
      name: string;
      nodes: Array<{ type: string; typeVersion: number }>;
      settings: { executionOrder: string };
    };
    expect(payload.nodes.length).toBeGreaterThan(0);
    expect(payload.settings.executionOrder).toBe("v1");
    expect(payload.nodes.every((n) => typeof n.typeVersion === "number")).toBe(true);
  });

  it("get_workflow_template lists the alternatives for an unknown name", async () => {
    const result = await harness.callTool("get_workflow_template", { templateName: "no-such-template" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Template 'no-such-template' not found.");
    expect(result.text).toContain("webhook-to-slack");
  });

  it("a returned template payload is accepted by create_workflow", async () => {
    const templateResult = await harness.callTool("get_workflow_template", { templateName: "webhook-to-slack" });
    const payload = parseJson(
      templateResult.text.split("Ready to use with create_workflow:\n\n")[1]
    ) as Record<string, unknown>;

    const created = await harness.callTool("create_workflow", payload);
    expect(created.isError).toBe(false);
    expect(created.text).toContain("Workflow created successfully!");
  });

  it("list_workflow_examples lists the golden-path patterns", async () => {
    const result = await harness.callTool("list_workflow_examples", {});
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/^Available workflow examples \(\d+ golden-path patterns\):/);

    const body = parseJson(result.text.split(":\n\n")[1].split("\n\nUse get_workflow_example")[0]) as Array<{
      name: string;
      pattern: string;
      tags: string[];
    }>;
    expect(body.map((e) => e.name)).toContain("webhook-transform-respond");
    expect(body.every((e) => e.pattern.length > 0 && e.tags.length > 0)).toBe(true);
  });

  it("get_workflow_example returns annotations and a usable payload", async () => {
    const result = await harness.callTool("get_workflow_example", { exampleName: "webhook-transform-respond" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("## Node Annotations");
    expect(result.text).toContain("## Ready-to-use payload for create_workflow");

    const json = result.text.split("```json\n")[1].split("\n```")[0];
    const payload = parseJson(json) as { nodes: Array<{ name: string }>; settings: { executionOrder: string } };
    expect(payload.nodes.length).toBeGreaterThan(0);
    expect(payload.settings.executionOrder).toBe("v1");
  });

  it("get_workflow_example lists the alternatives for an unknown name", async () => {
    const result = await harness.callTool("get_workflow_example", { exampleName: "no-such-example" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Example 'no-such-example' not found.");
    expect(result.text).toContain("webhook-transform-respond");
  });
});

describe("validate_workflow", () => {
  const trigger = {
    name: "Manual Trigger",
    type: "n8n-nodes-base.manualTrigger",
    position: [250, 300],
    parameters: {},
  };

  it("passes a correct workflow definition", async () => {
    const result = await harness.callTool("validate_workflow", {
      nodes: SAMPLE_NODES,
      connections: SAMPLE_CONNECTIONS,
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("**Status**: PASSED");
    expect(result.text).toContain("**Nodes**: 2");
    expect(result.text).not.toContain("## Errors (must fix)");
  });

  it("flags an unknown node type", async () => {
    const result = await harness.callTool("validate_workflow", {
      nodes: [trigger, { name: "Bogus", type: "n8n-nodes-base.notARealNode", position: [450, 300], parameters: {} }],
      connections: { "Manual Trigger": { main: [[{ node: "Bogus", type: "main", index: 0 }]] } },
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("**Status**: FAILED");
    expect(result.text).toContain("## Errors (must fix)");
    expect(result.text).toContain('[Bogus] type**: Unknown node type "n8n-nodes-base.notARealNode".');
  });

  it("flags a missing required parameter", async () => {
    const result = await harness.callTool("validate_workflow", {
      nodes: [
        trigger,
        { name: "Call API", type: "n8n-nodes-base.httpRequest", position: [450, 300], parameters: {} },
      ],
      connections: { "Manual Trigger": { main: [[{ node: "Call API", type: "main", index: 0 }]] } },
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("**Status**: FAILED");
    expect(result.text).toContain('[Call API] url**: Required parameter "url" is missing.');
    expect(result.text).toContain('[Call API] method**: Required parameter "method" is missing.');
    expect(result.text).toContain('Use get_node_schema("n8n-nodes-base.httpRequest") for details.');
  });

  it("flags a connection pointing at a node that does not exist", async () => {
    const result = await harness.callTool("validate_workflow", {
      nodes: [trigger, SAMPLE_NODES[1]],
      connections: { "Manual Trigger": { main: [[{ node: "Ghost Node", type: "main", index: 0 }]] } },
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("**Status**: FAILED");
    expect(result.text).toContain(
      'connections**: Connection target "Ghost Node" (from "Manual Trigger") does not match any node name.'
    );
  });

  it("flags duplicate node names", async () => {
    const result = await harness.callTool("validate_workflow", {
      nodes: [
        trigger,
        { name: "Step", type: "n8n-nodes-base.set", position: [450, 300], parameters: {} },
        { name: "Step", type: "n8n-nodes-base.set", position: [650, 300], parameters: {} },
      ],
      connections: { "Manual Trigger": { main: [[{ node: "Step", type: "main", index: 0 }]] } },
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("**Status**: FAILED");
    expect(result.text).toContain('[Step]**: Duplicate node name "Step" used 2 times.');
    expect(result.text).toContain('Rename duplicates to "Step 1", "Step 2", etc.');
  });

  it("warns about an orphan node", async () => {
    const result = await harness.callTool("validate_workflow", {
      nodes: [
        trigger,
        SAMPLE_NODES[1],
        {
          name: "Orphan Call",
          type: "n8n-nodes-base.httpRequest",
          position: [850, 300],
          parameters: { method: "GET", url: "https://example.invalid/ping" },
        },
      ],
      connections: SAMPLE_CONNECTIONS,
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("## Warnings (should review)");
    expect(result.text).toContain('[Orphan Call]**: Node "Orphan Call" is not connected to any other node (orphan).');
  });

  it("warns about a typeVersion that disagrees with the catalog", async () => {
    const result = await harness.callTool("validate_workflow", {
      nodes: [{ ...trigger, typeVersion: 99 }, SAMPLE_NODES[1]],
      connections: SAMPLE_CONNECTIONS,
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("## Warnings (should review)");
    expect(result.text).toContain(
      '[Manual Trigger] typeVersion**: typeVersion 99 specified, but catalog recommends version 1'
    );
  });

  it("skips a required parameter whose displayOptions condition is not met", async () => {
    const totp = (operation: string) => ({
      name: "TOTP",
      type: "n8n-nodes-base.totp",
      position: [450, 300],
      parameters: { operation, secret: "JBSWY3DPEHPK3PXP" },
    });
    const connections = { "Manual Trigger": { main: [[{ node: "TOTP", type: "main", index: 0 }]] } };

    const generating = await harness.callTool("validate_workflow", {
      nodes: [trigger, totp("generate")],
      connections,
    });
    // "token" is only required when operation is "verify", so generating must pass.
    expect(generating.text).toContain("**Status**: PASSED");
    expect(generating.text).not.toContain('Required parameter "token" is missing.');

    const verifying = await harness.callTool("validate_workflow", {
      nodes: [trigger, totp("verify")],
      connections,
    });
    expect(verifying.text).toContain("**Status**: FAILED");
    expect(verifying.text).toContain('[TOTP] token**: Required parameter "token" is missing.');
  });

  it("warns when a node that needs credentials has none", async () => {
    const result = await harness.callTool("validate_workflow", {
      nodes: [
        trigger,
        {
          name: "Slack Post",
          type: "n8n-nodes-base.slack",
          position: [450, 300],
          parameters: { resource: "message", operation: "post", select: "channel", channelId: "#general", text: "hi" },
        },
      ],
      connections: { "Manual Trigger": { main: [[{ node: "Slack Post", type: "main", index: 0 }]] } },
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("## Warnings (should review)");
    expect(result.text).toContain("typically requires credentials: slackApi");
    expect(result.text).toContain("Use list_credentials to check available credentials");
  });

  it("flags a credential type the node does not accept", async () => {
    const result = await harness.callTool("validate_workflow", {
      nodes: [
        trigger,
        {
          name: "Slack Post",
          type: "n8n-nodes-base.slack",
          position: [450, 300],
          parameters: { resource: "message", operation: "post", select: "channel", channelId: "#general", text: "hi" },
          credentials: { githubApi: { id: "cred-9", name: "Wrong Credential" } },
        },
      ],
      connections: { "Manual Trigger": { main: [[{ node: "Slack Post", type: "main", index: 0 }]] } },
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("**Status**: FAILED");
    expect(result.text).toContain(
      '[Slack Post] credentials**: Credential type "githubApi" is not valid for node type "n8n-nodes-base.slack".'
    );
    expect(result.text).toContain("Valid credential types: slackApi");
  });

  it("warns about two nodes sharing the same canvas position", async () => {
    const result = await harness.callTool("validate_workflow", {
      nodes: [trigger, { ...SAMPLE_NODES[1], position: [250, 300] }],
      connections: SAMPLE_CONNECTIONS,
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("## Warnings (should review)");
    expect(result.text).toContain('[Set Data]**: Node "Set Data" overlaps with "Manual Trigger" at position [250, 300].');
  });

  it("flags a connection whose source node does not exist", async () => {
    const result = await harness.callTool("validate_workflow", {
      nodes: [trigger],
      connections: { "Phantom Source": { main: [[{ node: "Manual Trigger", type: "main", index: 0 }]] } },
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("**Status**: FAILED");
    expect(result.text).toContain('connections**: Connection source "Phantom Source" does not match any node name.');
  });

  it("warns when no trigger node is present", async () => {
    const result = await harness.callTool("validate_workflow", {
      nodes: [SAMPLE_NODES[1]],
      connections: {},
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("No trigger node found.");
  });
});

describe("n8n failures surface as tool errors", () => {
  it("a 404 from n8n becomes an isError result naming the missing resource", async () => {
    const result = await harness.callTool("get_workflow", { workflowId: "wf-missing" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Error:");
    expect(result.text).toContain("Workflow not found");
  });

  it("a 404 on an execution becomes an isError result", async () => {
    const result = await harness.callTool("get_execution", { executionId: "exec-missing" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Execution not found");
  });

  it("a 500 from n8n becomes an isError result rather than a thrown exception", async () => {
    harness.mock.setForcedStatus(500);

    const result = await harness.callTool("list_workflows", {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Error:");
    expect(result.text).toContain("n8n instance failure (injected by the test fake)");
  });

  it("a 500 during create_workflow reports the create-specific message", async () => {
    harness.mock.setForcedStatus(500);

    const result = await harness.callTool("create_workflow", {
      name: "Never Created",
      nodes: SAMPLE_NODES,
      connections: SAMPLE_CONNECTIONS,
      settings: SAMPLE_SETTINGS,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Error creating workflow:");
    expect(result.text).toContain("n8n instance failure (injected by the test fake)");
  });

  it("a 500 during execute_workflow reports the execute-specific message", async () => {
    const id = await createWorkflowViaTool(harness, "Will Fail To Execute");
    harness.mock.setForcedStatus(500);

    const result = await harness.callTool("execute_workflow", { workflowId: id });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Error executing workflow:");
  });
});

describe("invalid input is rejected by the Zod schema before any HTTP call", () => {
  const cases: Array<{ tool: string; args: Record<string, unknown>; field: string }> = [
    { tool: "list_workflows", args: { limit: 1000 }, field: "limit" },
    { tool: "get_workflow", args: { workflowId: 123 }, field: "workflowId" },
    { tool: "create_workflow", args: { name: "Empty", nodes: [], connections: {}, settings: {} }, field: "nodes" },
    { tool: "update_workflow", args: { workflowId: "wf-1", nodes: "not-an-array" }, field: "nodes" },
    { tool: "delete_workflow", args: {}, field: "workflowId" },
    { tool: "activate_workflow", args: { workflowId: 7 }, field: "workflowId" },
    { tool: "deactivate_workflow", args: { workflowId: null }, field: "workflowId" },
    { tool: "list_executions", args: { status: "exploded" }, field: "status" },
    { tool: "get_execution", args: { executionId: false }, field: "executionId" },
    { tool: "delete_execution", args: {}, field: "executionId" },
    { tool: "execute_webhook", args: { webhookPath: 5 }, field: "webhookPath" },
    { tool: "execute_workflow", args: { workflowId: "wf-1", timeoutMs: 10 }, field: "timeoutMs" },
    { tool: "diagnose_execution", args: { executionId: [] }, field: "executionId" },
    { tool: "self_heal_workflow", args: { workflowId: "wf-1", timeoutMs: 999999999 }, field: "timeoutMs" },
    { tool: "create_tag", args: { name: 42 }, field: "name" },
    { tool: "get_credential_schema", args: { credentialType: {} }, field: "credentialType" },
    { tool: "run_audit", args: { categories: ["not-a-category"] }, field: "categories" },
    { tool: "get_node_types", args: { category: "not-a-category" }, field: "category" },
    { tool: "get_node_schema", args: { nodeType: 1 }, field: "nodeType" },
    { tool: "search_nodes", args: {}, field: "query" },
    { tool: "get_workflow_template", args: { templateName: [] }, field: "templateName" },
    { tool: "get_expression_help", args: { topic: "nonsense" }, field: "topic" },
    { tool: "validate_workflow", args: { nodes: [], connections: {} }, field: "nodes" },
    { tool: "get_workflow_example", args: { exampleName: 0 }, field: "exampleName" },
  ];

  for (const { tool, args, field } of cases) {
    it(`${tool} rejects a bad ${field}`, async () => {
      harness.mock.clearRequests();

      const result = await harness.callTool(tool, args);

      expect(result.isError).toBe(true);
      expect(result.text).toContain(`Input validation error: Invalid arguments for tool ${tool}`);
      expect(result.text).toContain(`"${field}"`);
      expect(harness.mock.requests).toEqual([]);
    });
  }

  it("covers every tool that declares an input schema", async () => {
    const noInputTools = [
      "list_tags",
      "list_credentials",
      "list_variables",
      "get_workflow_templates",
      "list_workflow_examples",
    ];
    const covered = new Set(cases.map((c) => c.tool));
    const uncovered = ALL_TOOLS.filter((t) => !covered.has(t) && !noInputTools.includes(t));

    expect(uncovered).toEqual([]);
  });

  it("a nonexistent tool name is reported as an error", async () => {
    const result = await harness.callTool("not_a_tool", {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Tool not_a_tool not found");
  });
});
