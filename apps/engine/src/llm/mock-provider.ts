import { logger } from "../logging/logger.ts";
import { LlmProviderError } from "./errors.ts";
import type { EnhancedPrompt, LlmFlow } from "./types.ts";

export interface MockCall {
  model: string;
  flow: LlmFlow;
  system_length: number;
  last_user: string;
  prompt_tokens_estimate: number;
  included_skill_ids: string[];
  included_chunk_ids: string[];
}

export interface MockResult<T = unknown> {
  text: string;
  object?: T;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
}

export type MockFailure =
  | "rate_limit"
  | "quota_exhausted"
  | "overloaded"
  | "context_length_exceeded";

export type ConverseMockStep = { tool: string; args: Record<string, unknown> } | { text: string };

class MockProvider {
  calls: MockCall[] = [];
  toolChoices: Array<{ type: string; toolName?: string } | undefined> = [];
  toolPalettes: Array<Array<{ name: string; description: string }>> = [];
  failureByModel: Map<string, MockFailure> = new Map();
  generateOverrides: Partial<Record<LlmFlow, (last: string) => unknown>> = {};
  conversePlans: Map<string, ConverseMockStep[]> = new Map();
  converseCursors: Map<string, number> = new Map();
  cacheSeenKey: Set<string> = new Set();
  defaultCriticPassWarned = false;
  defaultJudgePassWarned = false;

  reset(): void {
    this.calls = [];
    this.failureByModel = new Map();
    this.generateOverrides = {};
    this.conversePlans = new Map();
    this.toolChoices = [];
    this.toolPalettes = [];
    this.converseCursors = new Map();
    this.cacheSeenKey = new Set();
    this.defaultCriticPassWarned = false;
    this.defaultJudgePassWarned = false;
  }

  setConversePlan(conversation_id: string, plan: ConverseMockStep[]): void {
    this.conversePlans.set(conversation_id, plan);
    this.converseCursors.set(conversation_id, 0);
  }

  nextConverseStep(conversation_id: string): ConverseMockStep | { done: true } {
    const plan = this.conversePlans.get(conversation_id);
    if (!plan) return { done: true };
    const cursor = this.converseCursors.get(conversation_id) ?? 0;
    if (cursor >= plan.length) return { done: true };
    const step = plan[cursor];
    this.converseCursors.set(conversation_id, cursor + 1);
    if (!step) return { done: true };
    return step;
  }

  setFailure(model: string, mode: MockFailure): void {
    this.failureByModel.set(model, mode);
  }

  private canned(flow: LlmFlow, lastUser: string): { text: string; object: unknown } {
    const override = this.generateOverrides[flow];
    if (override) {
      const o = override(lastUser);
      return { text: JSON.stringify(o), object: o };
    }
    switch (flow) {
      case "generate": {
        const slug =
          lastUser
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "workflow";
        const obj = {
          name: `generated-${slug}`,
          slug: `generated-${slug}`,
          description: `Draft workflow for: ${lastUser}`.slice(0, 200),
          steps: [
            {
              kind: "request",
              id: "step-1",
              method: "GET",
              url: "https://jsonplaceholder.typicode.com/users",
            },
            {
              kind: "transform",
              id: "step-2",
              language: "javascript",
              expression:
                'return (input.scope["step-1"].data || []).slice(0, 2).map((u) => ({ name: u.name }));',
            },
          ],
        };
        return { text: JSON.stringify(obj), object: obj };
      }
      case "extract": {
        const obj = {
          schema: {
            fields: [
              { name: "id", type: "integer" },
              { name: "name", type: "string" },
            ],
          },
          data: [{ id: 1, name: lastUser.slice(0, 32) || "sample" }],
        };
        return { text: JSON.stringify(obj), object: obj };
      }
      case "catalog_describe": {
        const obj = {
          description: `Mock description: ${lastUser.slice(0, 80).replace(/\s+/g, " ")}`,
          category: "mock-category",
        };
        return { text: JSON.stringify(obj), object: obj };
      }
      case "repair": {
        const obj = {
          classification: "safe" as const,
          kind: "update_field_path" as const,
          description: "Rewrote field path to match drifted response shape",
          patch: { op: "replace", path: "/data/id", value: "data/result/id" },
          reasoning: `Drift observed: ${lastUser.slice(0, 80)}`,
        };
        return { text: JSON.stringify(obj), object: obj };
      }
      case "converse": {
        const text = `Acknowledged: ${lastUser.slice(0, 200)}. (mock)`;
        return { text, object: { text } };
      }
      case "discover": {
        const obj = {
          artifacts: [
            {
              kind: "connector" as const,
              title: "mock-discovered-connector",
              description: `Inferred from: ${lastUser.slice(0, 80)}`,
              draft: { name: "mock-discovered-connector", base_url: "https://example.com" },
              evidence_excerpts: ["mocked excerpt"],
              confidence: 82,
            },
          ],
        };
        return { text: JSON.stringify(obj), object: obj };
      }
      case "summarize": {
        const summary = lastUser.trim().replace(/\s+/g, " ").slice(0, 120);
        const text = summary.length > 0 ? `Summary: ${summary}` : "Summary: (empty)";
        return { text, object: { summary: text } };
      }
      case "critic_authoring": {
        if (!this.defaultCriticPassWarned) {
          this.defaultCriticPassWarned = true;
          logger.warn({
            module: "llm",
            action: "mock.critic.default_pass",
            msg: "mock-provider critic_authoring default pass returned — tests that intend to assert critic behaviour must install generateOverrides.critic_authoring",
          });
        }
        const obj = {
          passed: true,
          repairs: [],
          rationale: "mock_default_pass: no override installed",
        };
        return { text: JSON.stringify(obj), object: obj };
      }
      case "judge": {
        if (!this.defaultJudgePassWarned) {
          this.defaultJudgePassWarned = true;
          logger.warn({
            module: "llm",
            action: "mock.judge.default_pass",
            msg: "mock-provider judge default pass returned — tests that intend to assert judge behaviour must install generateOverrides.judge",
          });
        }
        const obj = {
          verdict: "passes" as const,
          reason: "mock_default_pass: no override installed",
          missing: [],
        };
        return { text: JSON.stringify(obj), object: obj };
      }
      default:
        return { text: "(mock)", object: null };
    }
  }

  private maybeFail(model: string, prompt: EnhancedPrompt): void {
    const fail = this.failureByModel.get(model);
    if (!fail) return;
    this.failureByModel.delete(model);
    if (fail === "rate_limit") {
      throw new LlmProviderError("rate_limit", `mock: rate limit on ${model}`);
    }
    if (fail === "quota_exhausted") {
      throw new LlmProviderError(
        "quota_exhausted",
        `mock: you have reached your specified api usage limits on ${model}. You will regain access on 2026-05-01 at 00:00 UTC.`,
      );
    }
    if (fail === "overloaded") {
      throw new LlmProviderError("overloaded", `mock: overloaded on ${model}`);
    }
    if (fail === "context_length_exceeded") {
      throw new LlmProviderError("context_length_exceeded", `mock: context too large on ${model}`, {
        tokens: prompt.token_counts.total,
      });
    }
  }

  call<T = unknown>(args: {
    flow: LlmFlow;
    model: string;
    prompt: EnhancedPrompt;
    enable_prompt_cache?: boolean;
  }): MockResult<T> {
    this.maybeFail(args.model, args.prompt);
    const lastUser =
      [...args.prompt.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    this.calls.push({
      model: args.model,
      flow: args.flow,
      system_length: args.prompt.system.length,
      last_user: lastUser,
      prompt_tokens_estimate: args.prompt.token_counts.total,
      included_skill_ids: args.prompt.included_skill_ids,
      included_chunk_ids: args.prompt.included_chunk_ids,
    });
    const canned = this.canned(args.flow, lastUser);
    const completion_tokens = Math.max(16, Math.min(400, Math.floor(canned.text.length / 4)));

    const stableTokens = Math.max(0, Math.floor(args.prompt.token_counts.system / 2));
    let cache_creation_tokens = 0;
    let cache_read_tokens = 0;
    if (args.enable_prompt_cache && stableTokens > 0) {
      const cacheKey = `${args.model}::${args.flow}`;
      if (this.cacheSeenKey.has(cacheKey)) {
        cache_read_tokens = stableTokens;
      } else {
        cache_creation_tokens = stableTokens;
        this.cacheSeenKey.add(cacheKey);
      }
    }

    return {
      text: canned.text,
      object: canned.object as T,
      prompt_tokens: args.prompt.token_counts.total,
      completion_tokens,
      cache_read_tokens,
      cache_creation_tokens,
    };
  }
}

const singleton = new MockProvider();

export function getMockProvider(): MockProvider {
  return singleton;
}

export function cannedListUsersPlan(connector_id?: string): ConverseMockStep[] {
  return [
    { tool: "list_skills", args: {} },
    { tool: "fetch_connector_docs", args: { query: "users" } },
    {
      tool: "edit_workflow_patch",
      args: {
        patches: [
          { op: "replace", path: "/name", value: "list-users" },
          { op: "add", path: "/slug", value: "list-users" },
          {
            op: "add",
            path: "/steps/-",
            value: {
              kind: "request",
              id: "get-users",
              method: "GET",
              ...(connector_id
                ? { connector_id, path: "/users" }
                : { url: "https://jsonplaceholder.typicode.com/users" }),
            },
          },
          {
            op: "add",
            path: "/steps/-",
            value: {
              kind: "transform",
              id: "shape-users",
              language: "javascript",
              expression: "return input.input.users;",
            },
          },
        ],
      },
    },
    { tool: "inspect_workflow_draft", args: {} },
    { tool: "validate_draft", args: {} },
    {
      tool: "dry_run_step",
      args: {
        step_id: "shape-users",
        input: {
          users: [
            { id: 1, name: "Ada", email: "ada@example.com" },
            { id: 2, name: "Grace", email: "grace@example.com" },
          ],
        },
      },
    },
    {
      tool: "ask_user_confirm",
      args: {
        question: "Commit this 2-step workflow?",
        kind: "save_workflow_draft",
        summary: "commit 2-step workflow",
      },
    },
    { tool: "save_workflow_draft", args: {} },
  ];
}

export function cannedListPrivateGithubReposPlan(connector_id?: string): ConverseMockStep[] {
  return [
    { tool: "list_skills", args: {} },
    { tool: "fetch_connector_docs", args: { query: "github private repos" } },
    {
      tool: "edit_workflow_patch",
      args: {
        patches: [
          { op: "replace", path: "/name", value: "list-private-github-repos" },
          { op: "add", path: "/slug", value: "list-private-github-repos" },
          {
            op: "add",
            path: "/steps/-",
            value: {
              kind: "request",
              id: "list-private-repos",
              method: "GET",
              ...(connector_id
                ? { connector_id, path: "/user/repos" }
                : { url: "https://api.github.com/user/repos" }),
              query: { visibility: "private", affiliation: "owner", per_page: 100 },
              paginate: { strategy: "page", page_param: "page", start: 1 },
            },
          },
          {
            op: "add",
            path: "/steps/-",
            value: {
              kind: "transform",
              id: "shape-repos",
              language: "javascript",
              expression:
                "return (input.input.items || []).map((r) => ({ id: r.id, name: r.full_name, private: r.private }));",
            },
          },
        ],
      },
    },
    { tool: "inspect_workflow_draft", args: {} },
    { tool: "validate_draft", args: {} },
    {
      tool: "dry_run_step",
      args: {
        step_id: "shape-repos",
        input: {
          items: [
            { id: 101, full_name: "octocat/private-alpha", private: true },
            { id: 102, full_name: "octocat/private-beta", private: true },
          ],
        },
      },
    },
    {
      tool: "ask_user_confirm",
      args: {
        question: "Commit this 2-step GitHub-private-repos workflow?",
        kind: "save_workflow_draft",
        summary: "commit list-private-github-repos workflow",
      },
    },
    { tool: "save_workflow_draft", args: {} },
  ];
}

export function resetMockProvider(): void {
  singleton.reset();
}

export function cannedOpenMeteoBerlinPlan(): ConverseMockStep[] {
  return [
    { tool: "get_engine_status", args: {} },
    { tool: "list_connectors", args: {} },
    {
      tool: "start_connector_from_description",
      args: {
        name: "Open-Meteo",
        driver: "http",
        auth_type: "none",
        base_url: "https://api.open-meteo.com",
        description: "Public weather API with no auth, used for tomorrow's forecast in Berlin.",
      },
    },
    {
      tool: "edit_workflow_patch",
      args: {
        patches: [
          { op: "replace", path: "/name", value: "berlin-tomorrow-weather" },
          { op: "add", path: "/slug", value: "berlin-tomorrow-weather" },
          {
            op: "add",
            path: "/steps/-",
            value: {
              kind: "request",
              id: "forecast-berlin",
              method: "GET",
              url: "https://api.open-meteo.com/v1/forecast",
              query: {
                latitude: 52.52,
                longitude: 13.41,
                daily: "temperature_2m_max,temperature_2m_min",
                forecast_days: 2,
              },
            },
          },
          {
            op: "add",
            path: "/steps/-",
            value: {
              kind: "transform",
              id: "tomorrow-only",
              language: "javascript",
              expression:
                'const d = input.scope["forecast-berlin"].data.daily; return { date: d.time[1], tmax: d.temperature_2m_max[1], tmin: d.temperature_2m_min[1] };',
            },
          },
        ],
      },
    },
    { tool: "validate_draft", args: {} },
    { tool: "dry_run_step", args: { step_id: "tomorrow-only" } },
    {
      tool: "ask_user_confirm",
      args: {
        question: "Commit the Berlin tomorrow-weather workflow?",
        kind: "save_workflow_draft",
        summary: "commit weather workflow",
      },
    },
    { tool: "save_workflow_draft", args: {} },
  ];
}

export function cannedConnectorWorkflowPlan(baseUrl: string): ConverseMockStep[] {
  return [
    { tool: "suggest_connector_templates", args: { query: "subkit engine", limit: 3 } },
    {
      tool: "start_connector_from_description",
      args: {
        name: "Subkit Engine",
        description: "Local subkit engine used for onboarding smoke coverage.",
        driver: "http",
        environment: "dev",
        base_url: baseUrl,
        auth_type: "none",
      },
    },
    { tool: "validate_connector_draft", args: {} },
    { tool: "probe_connector_draft", args: { method: "GET", path: "/health" } },
    { tool: "inspect_connector_draft", args: {} },
    { tool: "save_connector_draft", args: {} },
    {
      tool: "edit_workflow_patch",
      args: {
        patches: [
          { op: "replace", path: "/name", value: "engine-health-check" },
          { op: "add", path: "/slug", value: "engine-health-check" },
          {
            op: "add",
            path: "/description",
            value: "Checks the local subkit engine health endpoint.",
          },
          {
            op: "add",
            path: "/steps/-",
            value: {
              id: "health",
              kind: "request",
              method: "GET",
              url: `${baseUrl}/health`,
            },
          },
        ],
      },
    },
    { tool: "inspect_workflow_draft", args: {} },
    { tool: "validate_draft", args: {} },
    { tool: "dry_run_step", args: { step_id: "health", input: { source: "smoke" } } },
    {
      tool: "ask_user_confirm",
      args: {
        question: "Commit this engine health workflow?",
        kind: "save_workflow_draft",
        summary: "commit engine health workflow",
      },
    },
    { tool: "save_workflow_draft", args: {} },
  ];
}
