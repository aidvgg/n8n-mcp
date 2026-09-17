/**
 * Mock n8n API server for integration and E2E testing.
 * Simulates realistic n8n API responses including execution data with per-node results.
 */
import type { Server } from "http";
import express from "express";

export interface MockExecution {
  id: string;
  finished: boolean;
  mode: string;
  startedAt: string;
  stoppedAt: string | null;
  workflowId: string;
  status: "success" | "error" | "running" | "waiting" | "crashed";
  retryOf: null;
  retrySuccessId: null;
  data?: {
    resultData: {
      runData: Record<
        string,
        Array<{
          startTime: number;
          executionTime: number;
          executionStatus?: string;
          error?: { message: string; description?: string; stack?: string };
          data?: {
            main: Array<Array<{ json: Record<string, unknown> }>>;
          };
        }>
      >;
      lastNodeExecuted?: string;
      error?: { message: string };
    };
  };
}

export interface MockWorkflow {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  nodes: Array<{
    name: string;
    type: string;
    typeVersion: number;
    position: [number, number];
    parameters: Record<string, unknown>;
    credentials?: Record<string, unknown>;
  }>;
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
}

interface MockState {
  workflows: Map<string, MockWorkflow>;
  executions: Map<string, MockExecution>;
  executionCounter: number;
  workflowCounter: number;
  /** Every HTTP request the fake receives, in arrival order. */
  requests: Array<{ method: string; path: string; query: Record<string, unknown> }>;
  /** When set, every request is answered with this status instead of the real handler. */
  forcedStatus: number | null;
  // When a workflow is "executed", this function determines the result
  executionBehavior: (workflow: MockWorkflow) => MockExecution;
}

export function createMockN8nServer(port: number = 0) {
  const app = express();
  app.use(express.json());

  const state: MockState = {
    workflows: new Map(),
    executions: new Map(),
    executionCounter: 0,
    workflowCounter: 0,
    requests: [],
    forcedStatus: null,
    executionBehavior: defaultExecutionBehavior,
  };

  app.use((req, res, next) => {
    state.requests.push({ method: req.method, path: req.path, query: { ...req.query } });
    if (state.forcedStatus !== null) {
      return res.status(state.forcedStatus).json({ message: "n8n instance failure (injected by the test fake)" });
    }
    next();
  });

  // ============ WORKFLOW ENDPOINTS ============

  app.get("/api/v1/workflows", (req, res) => {
    let workflows = Array.from(state.workflows.values());
    if (typeof req.query.name === "string") {
      const wanted = req.query.name;
      workflows = workflows.filter((w) => w.name === wanted);
    }
    res.json({ data: workflows });
  });

  app.get("/api/v1/workflows/:id", (req, res) => {
    const workflow = state.workflows.get(req.params.id);
    if (!workflow) return res.status(404).json({ message: "Workflow not found" });
    res.json(workflow);
  });

  app.post("/api/v1/workflows", (req, res) => {
    state.workflowCounter++;
    const id = `wf-${state.workflowCounter}`;
    const workflow: MockWorkflow = {
      id,
      name: req.body.name,
      active: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: req.body.nodes || [],
      connections: req.body.connections || {},
      settings: req.body.settings || {},
    };
    state.workflows.set(id, workflow);
    res.status(201).json(workflow);
  });

  app.put("/api/v1/workflows/:id", (req, res) => {
    const workflow = state.workflows.get(req.params.id);
    if (!workflow) return res.status(404).json({ message: "Workflow not found" });

    const updated = { ...workflow, ...req.body, id: workflow.id, updatedAt: new Date().toISOString() };
    state.workflows.set(req.params.id, updated);
    res.json(updated);
  });

  app.delete("/api/v1/workflows/:id", (req, res) => {
    if (!state.workflows.has(req.params.id)) {
      return res.status(404).json({ message: "Workflow not found" });
    }
    state.workflows.delete(req.params.id);
    res.status(200).json({});
  });

  app.post("/api/v1/workflows/:id/activate", (req, res) => {
    const workflow = state.workflows.get(req.params.id);
    if (!workflow) return res.status(404).json({ message: "Workflow not found" });
    workflow.active = true;
    res.json(workflow);
  });

  app.post("/api/v1/workflows/:id/deactivate", (req, res) => {
    const workflow = state.workflows.get(req.params.id);
    if (!workflow) return res.status(404).json({ message: "Workflow not found" });
    workflow.active = false;
    res.json(workflow);
  });

  // ============ EXECUTION ENDPOINTS ============

  // Execute workflow (public API)
  app.post("/api/v1/workflows/:id/execute", (req, res) => {
    const workflow = state.workflows.get(req.params.id);
    if (!workflow) return res.status(404).json({ message: "Workflow not found" });

    const execution = state.executionBehavior(workflow);
    state.executions.set(execution.id, execution);

    res.json({ data: { id: execution.id } });
  });

  app.get("/api/v1/executions", (req, res) => {
    let executions = Array.from(state.executions.values());
    if (req.query.workflowId) {
      executions = executions.filter((e) => e.workflowId === req.query.workflowId);
    }
    if (req.query.status) {
      executions = executions.filter((e) => e.status === req.query.status);
    }
    // Return without data unless includeData
    const data = executions.map((e) => {
      if (req.query.includeData === "true") return e;
      const { data: _, ...rest } = e;
      return rest;
    });
    res.json({ data });
  });

  app.get("/api/v1/executions/:id", (req, res) => {
    const execution = state.executions.get(req.params.id);
    if (!execution) return res.status(404).json({ message: "Execution not found" });

    if (req.query.includeData === "true") {
      res.json(execution);
    } else {
      const { data: _, ...rest } = execution;
      res.json(rest);
    }
  });

  app.delete("/api/v1/executions/:id", (req, res) => {
    state.executions.delete(req.params.id);
    res.status(200).json({});
  });

  // ============ OTHER ENDPOINTS ============

  app.get("/api/v1/tags", (_req, res) => res.json({ data: [] }));
  app.post("/api/v1/tags", (req, res) => res.json({ id: "tag-1", name: req.body.name }));
  app.get("/api/v1/credentials", (_req, res) => res.json({ data: [] }));
  app.get("/api/v1/credentials/schema/:type", (req, res) => res.json({ properties: {} }));
  app.get("/api/v1/variables", (_req, res) => res.json({ data: [] }));
  app.post("/api/v1/audit", (_req, res) => res.json({ risk: "low" }));

  // Webhook endpoints live outside /api/v1, mirroring a real n8n instance.
  app.post("/webhook/:path", (req, res) => {
    res.json({ received: req.body, webhookPath: req.params.path });
  });

  // ============ SERVER LIFECYCLE ============

  let server: Server;

  function defaultExecutionBehavior(workflow: MockWorkflow): MockExecution {
    state.executionCounter++;
    const execId = `exec-${state.executionCounter}`;

    const runData: MockExecution["data"] = {
      resultData: {
        runData: {},
      },
    };

    // Simulate each node running
    for (const node of workflow.nodes) {
      runData!.resultData.runData[node.name] = [
        {
          startTime: Date.now(),
          executionTime: Math.floor(Math.random() * 500) + 10,
          data: {
            main: [[{ json: { success: true, node: node.name } }]],
          },
        },
      ];
    }

    return {
      id: execId,
      finished: true,
      mode: "manual",
      startedAt: new Date().toISOString(),
      stoppedAt: new Date().toISOString(),
      workflowId: workflow.id,
      status: "success",
      retryOf: null,
      retrySuccessId: null,
      data: runData,
    };
  }

  return {
    app,
    state,

    /** Set custom execution behavior for testing specific scenarios */
    setExecutionBehavior(fn: (workflow: MockWorkflow) => MockExecution) {
      state.executionBehavior = fn;
    },

    /** Reset to default (all nodes succeed) */
    resetExecutionBehavior() {
      state.executionBehavior = defaultExecutionBehavior;
    },

    /** Requests the fake has received since the last clearRequests() call */
    get requests() {
      return state.requests;
    },

    /** Forget the recorded request log, so a test can assert "no HTTP happened" */
    clearRequests() {
      state.requests.length = 0;
    },

    /** Answer every subsequent request with this status; null restores normal behavior */
    setForcedStatus(status: number | null) {
      state.forcedStatus = status;
    },

    /** Add a workflow directly to the mock state */
    addWorkflow(workflow: MockWorkflow) {
      state.workflows.set(workflow.id, workflow);
    },

    /** Add an execution directly to the mock state */
    addExecution(execution: MockExecution) {
      state.executions.set(execution.id, execution);
    },

    /** Start the mock server */
    start(): Promise<{ port: number; baseUrl: string }> {
      return new Promise((resolve) => {
        server = app.listen(port, () => {
          const addr = server.address();
          const actualPort = typeof addr === "object" && addr ? addr.port : port;
          resolve({
            port: actualPort,
            baseUrl: `http://localhost:${actualPort}/api/v1`,
          });
        });
      });
    },

    /** Stop the mock server */
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        if (!server) return resolve();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
