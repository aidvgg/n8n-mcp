import { createChildLogger } from "./logger.js";

const logger = createChildLogger("n8n-client");

// ============ TYPES ============

export interface Workflow {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  nodes: WorkflowNode[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
  tags?: Tag[];
}

export interface WorkflowNode {
  name: string;
  type: string;
  position: [number, number];
  parameters?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  typeVersion?: number;
}

export interface Execution {
  id: string;
  finished: boolean;
  mode: string;
  retryOf: string | null;
  retrySuccessId: string | null;
  startedAt: string;
  stoppedAt: string | null;
  workflowId: string;
  status: ExecutionStatus;
  data?: Record<string, unknown>;
}

export type ExecutionStatus = "success" | "error" | "running" | "waiting" | "crashed";

export interface Tag {
  id: string;
  name: string;
}

export interface Credential {
  id: string;
  name: string;
  type: string;
  createdAt: string;
  updatedAt: string;
}

export interface Variable {
  id: string;
  key: string;
  value: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  nextCursor?: string;
}

export interface CreateWorkflowInput {
  name: string;
  nodes: WorkflowNode[];
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
}

export interface N8nClientOptions {
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
}

// ============ ERROR CLASSES ============

export class N8nApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly endpoint: string,
    public readonly isRetryable: boolean
  ) {
    super(message);
    this.name = "N8nApiError";
  }
}

export class N8nTimeoutError extends Error {
  constructor(endpoint: string, timeout: number) {
    super(`Request to ${endpoint} timed out after ${timeout}ms`);
    this.name = "N8nTimeoutError";
  }
}

// ============ CLIENT ============

export class N8nClient {
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly retryDelay: number;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    options: N8nClientOptions = {}
  ) {
    this.timeout = options.timeout ?? 30000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelay = options.retryDelay ?? 1000;
  }

  private isRetryableStatus(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private sanitizeErrorMessage(status: number, rawError: string): string {
    // Don't expose internal error details in production
    if (process.env.NODE_ENV === "production") {
      switch (status) {
        case 400:
          return "Invalid request parameters";
        case 401:
          return "Authentication failed - check API key";
        case 403:
          return "Access denied - insufficient permissions";
        case 404:
          return "Resource not found";
        case 429:
          return "Rate limit exceeded - try again later";
        default:
          return status >= 500
            ? "n8n server error - try again later"
            : "Request failed";
      }
    }
    // In development, show full error but truncate if too long
    return rawError.length > 500 ? rawError.slice(0, 500) + "..." : rawError;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const method = options.method || "GET";
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        logger.debug({ endpoint, method, attempt }, "Making API request");

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            "X-N8N-API-KEY": this.apiKey,
            "Content-Type": "application/json",
            ...options.headers,
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const rawError = await response.text();
          const isRetryable = this.isRetryableStatus(response.status);

          logger.warn(
            { endpoint, status: response.status, attempt, isRetryable },
            "API request failed"
          );

          if (isRetryable && attempt < this.maxRetries) {
            const delay = this.retryDelay * Math.pow(2, attempt - 1);
            logger.info({ delay, attempt }, "Retrying after delay");
            await this.sleep(delay);
            continue;
          }

          throw new N8nApiError(
            this.sanitizeErrorMessage(response.status, rawError),
            response.status,
            endpoint,
            isRetryable
          );
        }

        // Handle empty responses (e.g., DELETE operations)
        const text = await response.text();
        if (!text) {
          return undefined as T;
        }

        const data = JSON.parse(text) as T;
        logger.debug({ endpoint, method }, "API request successful");
        return data;
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof N8nApiError) {
          throw error;
        }

        if (error instanceof Error && error.name === "AbortError") {
          logger.error({ endpoint, timeout: this.timeout }, "Request timed out");
          throw new N8nTimeoutError(endpoint, this.timeout);
        }

        lastError = error as Error;
        logger.error({ endpoint, error: lastError.message, attempt }, "Request error");

        if (attempt < this.maxRetries) {
          const delay = this.retryDelay * Math.pow(2, attempt - 1);
          logger.info({ delay, attempt }, "Retrying after network error");
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  // ============ WORKFLOWS ============

  async listWorkflows(params?: {
    active?: boolean;
    tags?: string;
    name?: string;
    cursor?: string;
    limit?: number;
  }): Promise<PaginatedResponse<Workflow>> {
    const query = new URLSearchParams();
    if (params?.active !== undefined) query.set("active", String(params.active));
    if (params?.tags) query.set("tags", params.tags);
    if (params?.name) query.set("name", params.name);
    if (params?.cursor) query.set("cursor", params.cursor);
    if (params?.limit) query.set("limit", String(params.limit));

    const queryString = query.toString();
    return this.request(`/workflows${queryString ? `?${queryString}` : ""}`);
  }

  async getWorkflow(id: string): Promise<Workflow> {
    return this.request(`/workflows/${encodeURIComponent(id)}`);
  }

  async createWorkflow(workflow: CreateWorkflowInput): Promise<Workflow> {
    return this.request("/workflows", {
      method: "POST",
      body: JSON.stringify(workflow),
    });
  }

  async updateWorkflow(
    id: string,
    workflow: Partial<Workflow>
  ): Promise<Workflow> {
    return this.request(`/workflows/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(workflow),
    });
  }

  async deleteWorkflow(id: string): Promise<void> {
    await this.request(`/workflows/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async activateWorkflow(id: string): Promise<Workflow> {
    return this.request(`/workflows/${encodeURIComponent(id)}/activate`, {
      method: "POST",
    });
  }

  async deactivateWorkflow(id: string): Promise<Workflow> {
    return this.request(`/workflows/${encodeURIComponent(id)}/deactivate`, {
      method: "POST",
    });
  }

  // ============ EXECUTIONS ============

  async listExecutions(params?: {
    workflowId?: string;
    status?: ExecutionStatus;
    cursor?: string;
    limit?: number;
  }): Promise<PaginatedResponse<Execution>> {
    const query = new URLSearchParams();
    if (params?.workflowId) query.set("workflowId", params.workflowId);
    if (params?.status) query.set("status", params.status);
    if (params?.cursor) query.set("cursor", params.cursor);
    if (params?.limit) query.set("limit", String(params.limit));

    const queryString = query.toString();
    return this.request(`/executions${queryString ? `?${queryString}` : ""}`);
  }

  async getExecution(id: string, includeData = false): Promise<Execution> {
    const query = includeData ? "?includeData=true" : "";
    return this.request(`/executions/${encodeURIComponent(id)}${query}`);
  }

  async deleteExecution(id: string): Promise<void> {
    await this.request(`/executions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async retryExecution(id: string, loadWorkflow = false): Promise<Execution> {
    return this.request(`/executions/${encodeURIComponent(id)}/retry`, {
      method: "POST",
      body: JSON.stringify({ loadWorkflow }),
    });
  }

  // ============ CREDENTIALS ============

  async listCredentials(): Promise<PaginatedResponse<Credential>> {
    return this.request("/credentials");
  }

  async getCredentialSchema(type: string): Promise<Record<string, unknown>> {
    return this.request(`/credentials/schema/${encodeURIComponent(type)}`);
  }

  // ============ TAGS ============

  async listTags(): Promise<{ data: Tag[] }> {
    return this.request("/tags");
  }

  async createTag(name: string): Promise<Tag> {
    return this.request("/tags", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  // ============ VARIABLES ============

  async listVariables(): Promise<{ data: Variable[] }> {
    return this.request("/variables");
  }

  // ============ AUDIT ============

  async runAudit(categories?: string[]): Promise<Record<string, unknown>> {
    return this.request("/audit", {
      method: "POST",
      body: JSON.stringify({ categories }),
    });
  }

  // ============ WORKFLOW EXECUTION ============

  /**
   * Execute a workflow by ID and wait for completion.
   * Tries the public API endpoint POST /workflows/{id}/execute first.
   * Falls back to POST /workflows/{id}/run if not available.
   * Returns the execution ID for result inspection.
   */
  async executeWorkflow(
    id: string,
    payload?: Record<string, unknown>
  ): Promise<{ executionId: string }> {
    // Try public API endpoint first (available in newer n8n versions)
    try {
      const result = await this.request<{ data: { id: string } }>(
        `/workflows/${encodeURIComponent(id)}/execute`,
        {
          method: "POST",
          body: JSON.stringify(payload ?? {}),
        }
      );
      return { executionId: result.data?.id ?? (result as unknown as { id: string }).id };
    } catch (error) {
      if (error instanceof N8nApiError && error.statusCode === 404) {
        logger.info("Public execute endpoint not available, trying /run fallback");
      } else {
        throw error;
      }
    }

    // Fallback: try the /run endpoint
    try {
      const result = await this.request<{ data: { id: string } }>(
        `/workflows/${encodeURIComponent(id)}/run`,
        {
          method: "POST",
          body: JSON.stringify(payload ?? {}),
        }
      );
      return { executionId: result.data?.id ?? (result as unknown as { id: string }).id };
    } catch (error) {
      if (error instanceof N8nApiError && error.statusCode === 404) {
        throw new N8nApiError(
          "Workflow execution endpoint not available. Your n8n version may not support programmatic execution via the public API. " +
          "Workaround: Add a Webhook trigger node to the workflow and use execute_webhook instead, or upgrade n8n.",
          404,
          `/workflows/${id}/execute`,
          false
        );
      }
      throw error;
    }
  }

  /**
   * Poll for an execution to finish, then return full data.
   */
  async waitForExecution(
    executionId: string,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<Execution> {
    const timeout = options.timeoutMs ?? 120000;
    const pollInterval = options.pollIntervalMs ?? 2000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const execution = await this.getExecution(executionId, true);
      if (execution.finished || execution.status === "error" || execution.status === "crashed") {
        return execution;
      }
      await this.sleep(pollInterval);
    }

    throw new N8nTimeoutError(`/executions/${executionId} (polling)`, timeout);
  }

  // ============ WEBHOOK EXECUTION ============

  async executeWebhook(
    webhookPath: string,
    data: Record<string, unknown>,
    auth?: { username: string; password: string }
  ): Promise<unknown> {
    const webhookBaseUrl = this.baseUrl.replace("/api/v1", "");
    const url = `${webhookBaseUrl}/webhook/${encodeURIComponent(webhookPath)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (auth) {
      const credentials = Buffer.from(
        `${auth.username}:${auth.password}`
      ).toString("base64");
      headers["Authorization"] = `Basic ${credentials}`;
    }

    try {
      logger.debug({ webhookPath }, "Executing webhook");

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(data),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const rawError = await response.text();
        throw new N8nApiError(
          this.sanitizeErrorMessage(response.status, rawError),
          response.status,
          `/webhook/${webhookPath}`,
          this.isRetryableStatus(response.status)
        );
      }

      const text = await response.text();
      if (!text) {
        return undefined;
      }

      return JSON.parse(text);
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof N8nApiError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new N8nTimeoutError(`/webhook/${webhookPath}`, this.timeout);
      }

      throw error;
    }
  }
}
