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
  /**
   * Anthropic ephemeral cache metrics. Mock provider reports 0/0; real
   * provider pulls from `providerMetadata.anthropic`.
   */
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
}

export type MockFailure =
  | "rate_limit"
  | "quota_exhausted"
  | "overloaded"
  | "context_length_exceeded";

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
  /**
   * Per-(model, flow) cache-state tracking used by `call()` to simulate
   * prompt-cache write-on-first-turn + read-on-subsequent-turns semantics.
   * Real providers report `cache_creation_tokens` the first time a stable
   * block lands and `cache_read_tokens` on every reuse; the mock mirrors
   * that shape so tests can assert the accounting without needing a live
   * provider.
   */
  cacheSeenKey: Set<string> = new Set();
  /** One-shot guard so the critic_authoring default-pass warning fires
   *  at most once per process. Reset alongside the rest of the mock
   *  state in `reset()` so per-test isolation still works. */
  defaultCriticPassWarned = false;
  /** Same one-shot guard for the preview-judge default pass. */
  defaultJudgePassWarned = false;

  reset(): void {
    this.calls = [];
    this.failureByModel = new Map();
    this.generateOverrides = {};
    this.conversePlans = new Map();
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
              language: "javascript",
              expression:
                'return (input.scope["step-1"].data || []).slice(0, 2).map((u) => ({ name: u.name }));',
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
        // Default: pass with no repairs. Tests that exercise critic
        // behaviour install an override via
        // `generateOverrides.critic_authoring`. Without that, a test
        // that intended to assert on the critic silently sees a pass —
        // emit a one-time `logger.warn` the first time the default
        // fires per process so missed overrides surface in CI output.
        // Real-LLM code never hits this branch.
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
        // Default: passes. Tests that exercise judge behaviour install
        // an override via `generateOverrides.judge`. Mirrors the
        // critic_authoring default-pass pattern, including the one-time
        // warn so a missed override surfaces in CI output instead of
        // silently reading as a passing verdict.
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
    // Consume — fail fires exactly once so fallback tests are simple.
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

    // Simulate Anthropic-style prompt-cache accounting. First call for a
    // given (model, flow) with cache enabled and a non-trivial stable
    // block produces `cache_creation_tokens`; subsequent calls produce
    // `cache_read_tokens` covering the same stable span. Tests asserting
    // cache hit rate use `LLM_PROVIDER=mock` + `enable_prompt_cache=true`
    // and read the recorded metric.
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

/**
 * Canned "list users" plan — the loop walks through this sequence when
 * the user asks to list users from an API. Covers author (via
 * edit_workflow_patch, the whole-draft editor) → validate_draft →
 * ask_user_confirm → save_workflow_draft. The preview step runs a pure
 * transform over sample input so the commit gate stays deterministic in
 * hermetic CI.
 */
export function cannedListUsersPlan(connector_id?: string): ConverseMockStep[] {
  return [
    { tool: "list_skills", args: {} },
    { tool: "fetch_connector_docs", args: { query: "users" } },
    // Assemble the whole draft in one edit_workflow_patch call: name +
    // slug + the request/transform steps.
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
    // Preview a pure transform step before asking for commit approval.
    // This keeps the authoring loop deterministic even when request
    // endpoints are unreachable in CI.
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
    // Resume after the user answers. No confirm marker exists on any tool
    // schema: the resolved `ask_user_confirm` IS the durable approval
    // `findPriorSaveWorkflowApproval` matches, so the post-rebuild tool-policy
    // gate proceeds without pausing a second time.
    { tool: "save_workflow_draft", args: {} },
  ];
}

/**
 * Canned "list my private GitHub repos" authoring plan. Assembles a
 * `request` step against the GitHub connector plus a tail transform in
 * one edit_workflow_patch call, validates, dry-runs on a fixture
 * payload, asks for save confirmation, then commits. The dry-run input
 * is sealed in-plan so hermetic CI never reaches out to api.github.com.
 */
export function cannedListPrivateGithubReposPlan(connector_id?: string): ConverseMockStep[] {
  return [
    { tool: "list_skills", args: {} },
    { tool: "fetch_connector_docs", args: { query: "github private repos" } },
    // Tail transform so the auto-commit preview targets a pure transform
    // rather than the live HTTP request — mirrors cannedListUsersPlan.
    // The shape is what an operator typically asks for: a slim repo
    // summary rather than the raw GitHub envelope.
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

/**
 * Canned "open-meteo weather" authoring plan. Drives the conversation
 * loop through: get_engine_status → list_connectors → start_connector_from_description
 * → edit_workflow_patch (Berlin forecast) → validate_draft → ask_user_confirm
 * → save_workflow_draft. Intentionally grounded in the open-meteo forecast
 * endpoint which needs no API key:
 *   https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&daily=temperature_2m_max,temperature_2m_min&forecast_days=2
 * The final step filters tomorrow's row via a transform step.
 */
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
    // Preview the transform output over the forecast scope so save_workflow_draft
    // clears the preview-before-commit gate.
    { tool: "dry_run_step", args: { step_id: "tomorrow-only" } },
    {
      tool: "ask_user_confirm",
      args: {
        question: "Commit the Berlin tomorrow-weather workflow?",
        kind: "save_workflow_draft",
        summary: "commit weather workflow",
      },
    },
    // After the operator confirms (test-side or canned), the resolved
    // ask_user_confirm is the durable approval the save path's prior-approval
    // predicate matches, so the post-rebuild tool-policy gate does NOT pause
    // again — otherwise turn-2 resume tests sit in awaiting_input forever
    // waiting on a phantom second confirm.
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
    // One call. It pauses on the policy gate's ask_user_confirm, whose
    // commit_intent the harness dispatches on approve — the model does not, and
    // cannot, re-issue it.
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
