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
        const obj = {
          patch: { op: "replace", path: "/data/id", value: "data/result/id" },
          classification: "safe" as const,
          notes: `Rewrote field path based on drift: ${lastUser.slice(0, 80)}`,
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
 * validate_draft → request_human_approval → commit_draft with an
 * intentional first-pass validation-error (missing url) so the
 * self-correct loop is exercised.
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
    {
      tool: "request_human_approval",
      args: { kind: "commit_draft", summary: "commit 1-step workflow" },
    },
    // Resume after approval:
    { tool: "commit_draft", args: {} },
  ];
}

export function resetMockProvider(): void {
  singleton.reset();
}
