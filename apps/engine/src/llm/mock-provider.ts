// Deterministic in-process mock LLM provider.
//
// The mock is the *only* provider tests ever touch. It never opens a
// network socket and never imports `@ai-sdk/anthropic`. Tests set
// `LLM_PROVIDER=mock` (or the per-tenant `llm_provider = 'mock'`) and the
// provider registry reads back a MockCall array describing everything
// that would have been sent to the real SDK.
//
// The mock supports two operations matching the provider interface:
//   - `generateText(prompt)` → `{ text, usage }`
//   - `generateObject(prompt)` → `{ object, usage }`
//
// Each flow has a canned canned response that is influenced by the last
// user turn so tests can assert on grounding. A mutable `failureMode`
// flag lets the routing test simulate `rate_limit` / `overloaded`
// errors on the primary model.

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
  /**
   * Anthropic ephemeral cache metrics. Mock provider reports 0/0; real
   * provider pulls from `providerMetadata.anthropic`.
   */
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
}

export type MockFailure = "rate_limit" | "overloaded" | "context_length_exceeded";

/**
 * One item in the canned conversation tool-call plan. The loop reads
 * these one at a time and feeds each tool result back before asking
 * the mock for the next step. When the plan is empty the mock emits
 * `{ done: true }` and the loop ends.
 */
export interface ConverseMockStep {
  tool: string;
  args: Record<string, unknown>;
}

class MockProvider {
  calls: MockCall[] = [];
  /** When set, the very next call with this model fails with this kind. */
  failureByModel: Map<string, MockFailure> = new Map();
  /** Canned generator overrides by flow — tests may patch these. */
  generateOverrides: Partial<Record<LlmFlow, (last: string) => unknown>> = {};
  /**
   * Per-conversation converse plans. Each call into the converse flow
   * advances its conversation's plan cursor by one. When a plan matches
   * the user message pattern, subsequent calls pick up where the last
   * left off — even across approval pauses. Keyed by `conversation_id`
   * so tests with multiple concurrent conversations don't cross-talk.
   */
  conversePlans: Map<string, ConverseMockStep[]> = new Map();
  converseCursors: Map<string, number> = new Map();

  reset(): void {
    this.calls = [];
    this.failureByModel = new Map();
    this.generateOverrides = {};
    this.conversePlans = new Map();
    this.converseCursors = new Map();
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
        // Synthesize a small WorkflowDef draft grounded in the user ask.
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
              expression: "$[0..1].{name: name}",
              language: "jsonata",
            },
          ],
        };
        return { text: JSON.stringify(obj), object: obj };
      }
      case "extract": {
        // Canned schema + data for the sample.
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
      case "repair": {
        // Canned PatchProposal. Shape matches PatchProposalSchema so the
        // real-provider code path (`generateObject` with the schema)
        // sees the same envelope as the mock short-circuit.
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
        // The loop reads `nextConverseStep()` directly after the
        // provider call to pull the next planned tool call — this
        // canned branch just acknowledges. Older single-turn tests
        // relied on this shape so we preserve it.
        const text = `Acknowledged: ${lastUser.slice(0, 200)}. (mock)`;
        return { text, object: { text } };
      }
      case "discover": {
        // Canned DiscoverEnvelope so generateObject returns a real
        // object even when LLM_PROVIDER=mock.
        const obj = {
          artifacts: [
            {
              kind: "connector" as const,
              title: "mock-discovered-connector",
              description: `Inferred from: ${lastUser.slice(0, 80)}`,
              draft: { base_url: "https://example.com" },
              evidence_excerpts: ["mocked excerpt"],
              confidence: 82,
            },
          ],
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
    // Consume — fail fires exactly once so fallback tests are simple.
    this.failureByModel.delete(model);
    if (fail === "rate_limit") {
      throw new LlmProviderError("rate_limit", `mock: rate limit on ${model}`);
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

  call<T = unknown>(args: { flow: LlmFlow; model: string; prompt: EnhancedPrompt }): MockResult<T> {
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
    return {
      text: canned.text,
      object: canned.object as T,
      prompt_tokens: args.prompt.token_counts.total,
      completion_tokens,
    };
  }
}

const singleton = new MockProvider();

export function getMockProvider(): MockProvider {
  return singleton;
}

/**
 * Canned "list users" plan — the loop walks through this sequence when
 * the user asks to list users from an API. Covers propose_step →
 * validate_draft → ask_user_confirm → commit_draft with an intentional
 * first-pass validation-error (missing url) so the self-correct loop
 * is exercised.
 */
export function cannedListUsersPlan(connector_id?: string): ConverseMockStep[] {
  return [
    { tool: "list_skills", args: {} },
    { tool: "fetch_connector_docs", args: { query: "users" } },
    // First attempt: missing url AND missing connector_id → triggers
    // validation-error feedback loop.
    { tool: "propose_step", args: { step: { kind: "request", id: "get-users", method: "GET" } } },
    // After the validator complains, the model "fixes" the step by
    // supplying a real URL.
    {
      tool: "propose_step",
      args: {
        step: {
          kind: "request",
          id: "get-users",
          method: "GET",
          url: "https://jsonplaceholder.typicode.com/users",
          ...(connector_id ? { connector_id } : {}),
        },
      },
    },
    { tool: "validate_draft", args: {} },
    // Preview the request step before asking for commit approval. The
    // underlying fetch hits jsonplaceholder in canned flows, which is
    // unreachable in hermetic CI — the commit uses `force: true` so the
    // journey test is not network-dependent. The override lands in the
    // audit log (WORKFLOW_COMMITTED_OVERRIDE) where operators can review.
    { tool: "dry_run_step", args: { step_id: "get-users" } },
    {
      tool: "ask_user_confirm",
      args: {
        question: "Commit this 1-step workflow?",
        kind: "commit_draft",
        summary: "commit 1-step workflow",
      },
    },
    // Resume after the user answers:
    { tool: "commit_draft", args: { force: true } },
  ];
}

export function resetMockProvider(): void {
  singleton.reset();
}

/**
 * Canned "open-meteo weather" authoring plan. Drives the conversation
 * loop through: get_engine_status → list_connectors → propose_connector
 * → propose_step (Berlin forecast) → validate_draft → ask_user_confirm
 * → commit_draft. Intentionally grounded in the open-meteo forecast
 * endpoint which needs no API key:
 *   https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&daily=temperature_2m_max,temperature_2m_min&forecast_days=2
 * The final step filters tomorrow's row via a transform step.
 */
export function cannedOpenMeteoBerlinPlan(): ConverseMockStep[] {
  return [
    { tool: "get_engine_status", args: {} },
    { tool: "list_connectors", args: {} },
    {
      tool: "propose_connector",
      args: {
        name: "Open-Meteo",
        slug: "open-meteo",
        driver: "http",
        auth_type: "none",
        base_url: "https://api.open-meteo.com",
        reason: "Public weather API — no auth required, used for tomorrow's forecast in Berlin.",
      },
    },
    {
      tool: "propose_step",
      args: {
        step: {
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
    },
    {
      tool: "propose_step",
      args: {
        step: {
          kind: "transform",
          id: "tomorrow-only",
          expression:
            "daily.{date: time[1], tmax: temperature_2m_max[1], tmin: temperature_2m_min[1]}",
          language: "jsonata",
        },
      },
    },
    { tool: "validate_draft", args: {} },
    // Preview the transform output over the forecast scope so commit_draft
    // clears the preview-before-commit gate.
    { tool: "dry_run_step", args: { step_id: "tomorrow-only" } },
    {
      tool: "ask_user_confirm",
      args: {
        question: "Commit the Berlin tomorrow-weather workflow?",
        kind: "commit_draft",
        summary: "commit weather workflow",
      },
    },
    // Transform previews are pure, so normal commit (no force) works here.
    { tool: "commit_draft", args: {} },
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
    { tool: "probe_connector_draft", args: { method: "GET", path: "/v1/health" } },
    { tool: "inspect_connector_draft", args: {} },
    { tool: "save_connector_draft", args: {} },
    { tool: "save_connector_draft", args: { __policy_confirmed: true } },
    {
      tool: "build_workflow",
      args: {
        name: "engine-health-check",
        slug: "engine-health-check",
        description: "Checks the local subkit engine health endpoint.",
        steps: [
          {
            id: "health",
            kind: "request",
            method: "GET",
            url: `${baseUrl}/v1/health`,
          },
        ],
        environment: "dev",
      },
    },
    { tool: "inspect_workflow_draft", args: {} },
    { tool: "dry_run_step", args: { step_id: "health", input: { source: "smoke" } } },
    {
      tool: "ask_user_confirm",
      args: {
        question: "Commit this engine health workflow?",
        kind: "commit_draft",
        summary: "commit engine health workflow",
      },
    },
    { tool: "commit_draft", args: {} },
  ];
}
