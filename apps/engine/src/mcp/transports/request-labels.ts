// Turning an MCP request and its response into telemetry labels.
//
// Separated from the transport because it is a vocabulary, not a mechanism:
// the transport owns sessions, leases and streaming, while these functions
// decide what a request is CALLED in a metric. Keeping them together matters
// because the labels must stay a bounded set — an unbounded label explodes
// the metric's cardinality — and that bound is only visible when the
// allow-list and the classifier sit side by side.

export interface McpRequestClass {
  operation: string;
  taskPhase?: "working" | "cancelled" | "none" | undefined;
}

const JSON_RPC_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "tasks/get",
  "tasks/result",
  "tasks/list",
  "tasks/cancel",
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/progress",
]);

function toolClass(name: unknown): string {
  if (typeof name !== "string") return "other";
  if (name.startsWith("conversation_")) return "conversation";
  if (name.includes("workflow")) return "workflow";
  if (name.includes("knowledge") || name.includes("search_")) return "knowledge";
  if (name.includes("connector") || name.includes("probe")) return "connector";
  if (name.includes("execution") || name.startsWith("run_")) return "execution";
  return "other";
}

export async function classifyMcpRequest(request: Request): Promise<McpRequestClass> {
  if (request.method === "GET") return { operation: "notifications/stream" };
  if (request.method === "DELETE") return { operation: "session/close" };
  if (request.method !== "POST") return { operation: "transport/other" };
  try {
    const value = (await request.clone().json()) as unknown;
    if (Array.isArray(value)) return { operation: "jsonrpc/batch" };
    if (!value || typeof value !== "object") return { operation: "jsonrpc/invalid" };
    const envelope = value as { method?: unknown; params?: unknown };
    const rawMethod = typeof envelope.method === "string" ? envelope.method : "";
    const method = JSON_RPC_METHODS.has(rawMethod) ? rawMethod : "jsonrpc/other";
    if (method === "tools/call") {
      const params =
        envelope.params && typeof envelope.params === "object"
          ? (envelope.params as { name?: unknown; task?: unknown })
          : {};
      return {
        operation: `tools/call:${toolClass(params.name)}`,
        taskPhase: params.task === undefined ? "none" : "working",
      };
    }
    if (method === "tasks/cancel") return { operation: method, taskPhase: "cancelled" };
    return { operation: method };
  } catch {
    return { operation: "jsonrpc/invalid" };
  }
}

export function mcpOutcome(status: number): string {
  if (status === 503) return "capacity_rejected";
  if (status === 401 || status === 403) return "denied";
  if (status === 404) return "not_found";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "success";
}
