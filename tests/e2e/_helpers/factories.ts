import type { E2EEnv, PersonaName } from "../setup.ts";
import { type ApiClient, apiClient } from "./http.ts";
import { pollUntil } from "./poll.ts";

let seq = 0;
export function uniqueSuffix(label = "fix"): string {
  seq += 1;
  return `${label}-${seq.toString().padStart(4, "0")}`;
}

export interface SeedConnectorOpts {
  persona?: PersonaName;
  name?: string;
  slug?: string;
  driver?: string;
  auth_type?: string;
  base_url?: string;
}

export interface SeededConnector {
  id: string;
  slug: string;
}

export async function seedConnector(
  env: E2EEnv,
  opts: SeedConnectorOpts = {},
): Promise<SeededConnector> {
  const api = apiClient(env);
  const slug = opts.slug ?? uniqueSuffix("conn");
  const res = await api.post<{ id: string; slug: string }>(
    "/v1/connectors",
    {
      name: opts.name ?? `Seed ${slug}`,
      slug,
      driver: opts.driver ?? "http",
      auth_type: opts.auth_type ?? "none",
      base_url: opts.base_url ?? "https://example.com",
    },
    { persona: opts.persona ?? "admin" },
  );
  if (res.status !== 201) {
    throw new Error(`seedConnector failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.id, slug };
}

export interface WorkflowStep {
  id: string;
  kind: string;
  [key: string]: unknown;
}

export interface SeedWorkflowOpts {
  persona?: PersonaName;
  name?: string;
  slug?: string;
  description?: string;
  steps?: WorkflowStep[];
  trigger?: Record<string, unknown>;
}

export interface SeededWorkflow {
  id: string;
  slug: string;
}

export function defaultTransformSteps(): WorkflowStep[] {
  return [
    {
      id: "echo",
      kind: "transform",
      language: "javascript",
      expression: "return { ok: true, value: input.input ?? null };",
    },
  ];
}

export async function seedWorkflow(
  env: E2EEnv,
  opts: SeedWorkflowOpts = {},
): Promise<SeededWorkflow> {
  const api = apiClient(env);
  const slug = opts.slug ?? uniqueSuffix("wf");
  const res = await api.post<{ id: string; slug: string }>(
    "/v1/workflows",
    {
      name: opts.name ?? `Seed ${slug}`,
      slug,
      ...(opts.description ? { description: opts.description } : {}),
      steps: opts.steps ?? defaultTransformSteps(),
      ...(opts.trigger ? { trigger: opts.trigger } : {}),
    },
    { persona: opts.persona ?? "admin" },
  );
  if (res.status !== 201) {
    throw new Error(`seedWorkflow failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.id, slug };
}

export interface ExecutionRow {
  id: string;
  status: string;
  workflow_id: string | null;
  request_source: string;
  [key: string]: unknown;
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "succeeded",
  "failed",
  "cancelled",
  "canceled",
  "error",
]);

export async function waitForExecution(
  api: ApiClient,
  id: string,
  opts: { timeoutMs?: number; persona?: PersonaName } = {},
): Promise<ExecutionRow> {
  return pollUntil(
    async () => {
      const res = await api.get<ExecutionRow>(`/v1/executions/${id}`, {
        persona: opts.persona ?? "admin",
      });
      if (res.status !== 200) return null;
      return TERMINAL_STATUSES.has(res.body.status) ? res.body : null;
    },
    { timeoutMs: opts.timeoutMs ?? 20_000, label: `execution ${id} terminal` },
  );
}
