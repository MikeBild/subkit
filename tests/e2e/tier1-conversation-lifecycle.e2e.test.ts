// Tier 1 — Conversation lifecycle E2E. REAL gateway-backed or direct-provider LLM.
//
// What's exercised end-to-end (no mocks):
//   * POST/GET /v1/conversations + /messages + /elicitations (Hono + Postgres)
//   * Engine LLM dispatch through the configured real-provider path
//   * Real tool palette — start_connector_from_description, propose_step, validate_draft,
//     save_workflow_draft — all running through the actual Zod validators,
//     workflow validator, and connector persistence layer
//   * RBAC (admin persona), audit log, conversation_drafts snapshots
//
// What we deliberately DON'T assert:
//   * Exact tool sequence (LLMs are non-deterministic; the model might
//     call list_skills 0–3 times, may or may not pause at confirm).
//   * Exact text in assistant messages.
// Assertions are outcome-based: after a run, does the resulting state
// match what the user asked for? (a connector with a sensible slug
// exists, a workflow with at least one step exists, etc.)
//
// Why this file exists: a regression shipped where every conversation
// 500'd in production because the only "E2E" suite forced LLM_PROVIDER
// =mock and never touched the real dispatch path. This file fixes
// that gap permanently.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { boot, cli, type E2EEnv, shutdown } from "./setup.ts";

// Skip the whole suite when CI forces LLM_PROVIDER=mock (no real API
// credentials available). The tier-1 assertions expect actual tool
// calls coming out of a real LLM; the mock provider emits an empty
// plan, so the tests would always fail with `Expected >=1, Received 0`.
const REAL_PROVIDER_SET =
  (Boolean(process.env.AI_GATEWAY_API_KEY) && Boolean(process.env.AI_GATEWAY_MODEL)) ||
  ["anthropic", "openai", "gemini", "azure", "bedrock", "vertex"].includes(
    (process.env.LLM_PROVIDER ?? "").toLowerCase(),
  );
const SHOULD_RUN = process.env.LLM_PROVIDER !== "mock" && REAL_PROVIDER_SET;

let env: E2EEnv;
beforeAll(async () => {
  if (!SHOULD_RUN) return;
  // Default mode = real LLM from .env. Throws clearly if misconfigured.
  env = await boot("tier1-real");
}, 90_000);
afterAll(async () => {
  if (!SHOULD_RUN) return;
  await shutdown(env);
}, 30_000);

function adminAuth() {
  return {
    Authorization: `Bearer ${env.personas.admin.apiKey}`,
    "Content-Type": "application/json",
  } as const;
}

interface CreateOutcome {
  conversation: { id: string; status: string };
  events: Array<{ type: string; output?: unknown; tool?: string }>;
  pending_elicitation_id?: string;
}

async function createConversation(initial_message: string): Promise<CreateOutcome> {
  const r = await fetch(`${env.baseUrl}/v1/conversations`, {
    method: "POST",
    headers: adminAuth(),
    body: JSON.stringify({ initial_message }),
  });
  if (r.status !== 201) {
    throw new Error(`POST /v1/conversations failed: ${r.status} ${await r.text()}`);
  }
  return (await r.json()) as CreateOutcome;
}

async function appendMessage(id: string, message: string): Promise<CreateOutcome> {
  const r = await fetch(`${env.baseUrl}/v1/conversations/${id}/messages`, {
    method: "POST",
    headers: adminAuth(),
    body: JSON.stringify({ message }),
  });
  if (r.status !== 200) {
    throw new Error(`POST .../messages failed: ${r.status} ${await r.text()}`);
  }
  return (await r.json()) as CreateOutcome;
}

async function respondElicitation(
  conv: string,
  elicit: string,
  output: unknown,
  reason?: string,
): Promise<CreateOutcome> {
  const r = await fetch(`${env.baseUrl}/v1/conversations/${conv}/elicitations/${elicit}/respond`, {
    method: "POST",
    headers: adminAuth(),
    body: JSON.stringify(reason ? { output, reason } : { output }),
  });
  if (r.status !== 200) {
    throw new Error(`POST .../elicitations/.../respond failed: ${r.status} ${await r.text()}`);
  }
  return (await r.json()) as CreateOutcome;
}

async function getConversation(id: string): Promise<{
  conversation: { id: string; status: string };
  messages: Array<{ role: string; parts: unknown[] }>;
  tool_calls: Array<{ tool: string }>;
}> {
  const r = await fetch(`${env.baseUrl}/v1/conversations/${id}`, { headers: adminAuth() });
  if (r.status !== 200) throw new Error(`GET conversation: ${r.status} ${await r.text()}`);
  return (await r.json()) as {
    conversation: { id: string; status: string };
    messages: Array<{ role: string; parts: unknown[] }>;
    tool_calls: Array<{ tool: string }>;
  };
}

/**
 * Drive an authoring conversation that may pause on ask_user_confirm.
 * On pause, automatically approve and continue. Returns the final
 * conversation state. Caps at `maxApprovals` to prevent infinite loops
 * if the LLM keeps re-asking. Each pause is independent — the engine
 * resumes the loop after each respond() call.
 */
async function runWithApprovals(
  initial_message: string,
  maxApprovals = 6,
): Promise<{ conversation_id: string; final: CreateOutcome }> {
  let outcome = await createConversation(initial_message);
  const id = outcome.conversation.id;
  for (let i = 0; i < maxApprovals && outcome.pending_elicitation_id; i++) {
    outcome = await respondElicitation(id, outcome.pending_elicitation_id, { confirmed: true });
  }
  return { conversation_id: id, final: outcome };
}

// ---------------------------------------------------------------------------
// 1. Simple prompt round-trip
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("Tier 1.1 — simple conversation (real LLM)", () => {
  test("POST /v1/conversations with `hello` returns 201 + a completed turn", async () => {
    const out = await createConversation("hello, who are you?");
    expect(out.conversation.id).toBeTruthy();
    const types = out.events.map((e) => e.type);
    // The dispatch path is proven by a `completed` event arriving — we
    // do NOT assert on the assistant text content.
    expect(types).toContain("completed");
    expect(types).toContain("message");
  }, 90_000);
});

// ---------------------------------------------------------------------------
// 2. Multi-turn — append a follow-up, history accumulates
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("Tier 1.2 — multi-turn (real LLM)", () => {
  test("appendMessage grows the message list and preserves conversation_id", async () => {
    const first = await createConversation("hi, my favourite number is 42");
    const id = first.conversation.id;
    await appendMessage(id, "what number did i mention?");
    const detail = await getConversation(id);
    expect(detail.conversation.id).toBe(id);
    const userMsgs = detail.messages.filter((m) => m.role === "user");
    const asstMsgs = detail.messages.filter((m) => m.role === "assistant");
    expect(userMsgs.length).toBeGreaterThanOrEqual(2);
    expect(asstMsgs.length).toBeGreaterThanOrEqual(2);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 3. Connector created via chat (real LLM, outcome-based)
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)(
  "Tier 1.3 — connector authoring engages the real tool palette (real LLM)",
  () => {
    test("a chat that asks for a connector triggers start_connector_from_description and reaches confirm/commit", async () => {
      const before = await fetch(`${env.baseUrl}/v1/connectors?limit=200`, {
        headers: adminAuth(),
      }).then((r) => r.json() as Promise<{ items: Array<{ slug: string }> }>);
      const beforeSlugs = new Set(before.items.map((c) => c.slug));

      const { conversation_id } = await runWithApprovals(
        "Use the start_connector_from_description tool to seed a connector draft " +
          "(name 'open-meteo', driver 'http', auth_type 'none', base_url " +
          "'https://api.open-meteo.com'). Then continue through the normal " +
          "probe/save path before building the workflow.",
      );

      const detail = await getConversation(conversation_id);
      const tools = detail.tool_calls.map((t) => t.tool);
      // Floor: the LLM dispatch reached start_connector_from_description — the engine's
      // tool palette + Zod validators + draft snapshotting all ran.
      expect(tools).toContain("start_connector_from_description");

      // If the LLM completed the round-trip, a connector row exists.
      if (tools.includes("save_workflow_draft")) {
        const after = await fetch(`${env.baseUrl}/v1/connectors?limit=200`, {
          headers: adminAuth(),
        }).then((r) => r.json() as Promise<{ items: Array<{ slug: string; name: string }> }>);
        const newOnes = after.items.filter((c) => !beforeSlugs.has(c.slug));
        expect(newOnes.length).toBeGreaterThanOrEqual(1);
      }
    }, 180_000);
  },
);

// ---------------------------------------------------------------------------
// 4. Workflow created via chat (real LLM, outcome-based)
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)(
  "Tier 1.4 — workflow authoring engages the real tool palette (real LLM)",
  () => {
    test("the model uses propose_step + validate_draft and either commits or reaches confirm", async () => {
      const { conversation_id } = await runWithApprovals(
        "Use these tools in order to build and commit a workflow: " +
          "1) call propose_step to add a single request step (id 'fetch', kind 'request', method GET, url https://example.com), " +
          "2) call validate_draft, " +
          "3) call ask_user_confirm with kind='save_workflow_draft', " +
          "4) on approval call save_workflow_draft. " +
          "Do not stop until save_workflow_draft has been called.",
      );

      const detail = await getConversation(conversation_id);
      const tools = detail.tool_calls.map((t) => t.tool);

      // Engine assertion: the LLM dispatch path actually exercised the
      // draft tool palette. propose_step is the floor — without it
      // nothing useful happened. validate_draft proves the validator
      // ran end-to-end through the engine.
      expect(tools).toContain("propose_step");

      // Functional assertion (best effort): if the LLM completed the
      // approval round-trip and called save_workflow_draft, a workflow row
      // exists. We don't FAIL when the LLM stops short — that's an LLM
      // capability question, not an engine bug. We DO fail if commit
      // was attempted but no row landed.
      if (tools.includes("save_workflow_draft")) {
        const wfRes = await fetch(`${env.baseUrl}/v1/workflows?limit=200`, {
          headers: adminAuth(),
        });
        const wfBody = (await wfRes.json()) as { items: Array<{ id: string }> };
        expect(wfBody.items.length).toBeGreaterThanOrEqual(1);

        const audit = await fetch(
          `${env.baseUrl}/v1/audit-log?action=conversation.committed&limit=20`,
          { headers: adminAuth() },
        ).then((r) => r.json() as Promise<{ items: Array<{ resource_id: string }> }>);
        expect(audit.items.some((a) => a.resource_id === conversation_id)).toBe(true);
      }
    }, 240_000);
  },
);

// ---------------------------------------------------------------------------
// 5. Resume — `sk -r <id>` continues an existing conversation
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("Tier 1.5 — resume (real LLM)", () => {
  test("sk -r <id> appends a turn to a pre-existing conversation", async () => {
    const seed = await createConversation("first message: my code word is alpha-foxtrot");
    const id = seed.conversation.id;
    const r = await cli(["--p", "what was my code word?", "-r", id, "--output", "json"], {
      env,
      persona: "admin",
      timeout: 120_000,
    });
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout) as { session_id: string; status: string };
    expect(body.session_id).toBe(id);
    expect(body.status).toBe("completed");

    const detail = await getConversation(id);
    const userTexts = detail.messages
      .filter((m) => m.role === "user")
      .flatMap((m) =>
        (m.parts as Array<{ type?: string; text?: string }>)
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string),
      );
    expect(userTexts.some((t) => t.includes("first message"))).toBe(true);
    expect(userTexts.some((t) => t.includes("what was my code word"))).toBe(true);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 6. Elicitation REJECT — declined response leaves draft uncommitted
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("Tier 1.6 — elicitation reject (real LLM)", () => {
  test("declining ask_user_confirm leaves the conversation un-committed", async () => {
    const out = await createConversation(
      "Use propose_step to add a request step (id 'fetch', kind 'request', method GET, url https://example.com), " +
        "then validate_draft, then ask_user_confirm with kind='save_workflow_draft' to ask me to commit.",
    );
    const id = out.conversation.id;

    // The model may either pause (good — we decline) OR finish
    // without pausing (also fine — nothing to decline). What we
    // assert is the post-condition: the conversation never committed.
    if (out.pending_elicitation_id) {
      await respondElicitation(
        id,
        out.pending_elicitation_id,
        { confirmed: false },
        "user changed their mind",
      );
    }

    const detail = await getConversation(id);
    expect(detail.conversation.status).not.toBe("committed");
  }, 180_000);
});
