// Typed `request_credential_form` conversation event — deterministic
// no-LLM short-circuit on POST /v1/conversations/{id}/messages.
//
// The sk composer's input-side secret filter sends this event instead
// of relaying prose for the model to re-derive. The engine must:
//   1. synthesize the exact ask_user_form pause the LLM path produces
//      (assistant anchor + tool_call row + PAIRED elicitation) and flip
//      the conversation to awaiting_input — with ZERO LLM calls;
//   2. resume cleanly through the existing respondElicitation path
//      (the tool_use ↔ tool_result pairing invariant), and
//   3. persist the operator's typed secret REDACTED via the existing
//      field-metadata redaction (#304) — no new redaction code.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
} from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { ELICITATION_REDACTED_MARKER } from "../tools/ask-user/redact-answer.ts";

let http: HttpTestServer;

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  http = await createHttpTestServer("cred-form-event");
});

afterAll(async () => {
  await http.cleanup();
});

// Mirrors the sk composer's prose fallback — rides as the benign user
// message of the event turn (older engines degrade to it). It must
// never re-derive anything here: the typed event short-circuits first.
const FALLBACK_PROSE =
  "Please ask me for the credential through a masked form (ask_user_form with type: password, sensitive: true). I attempted to paste a credential into chat — do not echo anything; collect it via the form.";

// Deterministic fake with a real-shape DigitalOcean prefix — the
// operator's answer that must never survive at rest.
const FAKE_SECRET = "dop_v1_a9053683ac4c864800f693f0c7b325d880a44f056bd884c8d975db2ece655796";

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${http.baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${http.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/conversations/{id}/messages — request_credential_form event", () => {
  test("event turn opens the masked form deterministically, then resumes + redacts on respond", async () => {
    // ── Setup: conversation with no initial message (no turn, no LLM) ──
    const createRes = await postJson("/v1/conversations", {});
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { conversation: { id: string } };
    const convId = created.conversation.id;

    const llmCallsBefore = getMockProvider().calls.length;

    // ── The typed event turn ───────────────────────────────────────────
    const res = await postJson(`/v1/conversations/${convId}/messages`, {
      message: FALLBACK_PROSE,
      event: { type: "request_credential_form", credential_hint: "digitalocean_pat" },
    });
    expect(res.status).toBe(200);
    const outcome = (await res.json()) as {
      conversation: { status: string };
      events: Array<Record<string, unknown>>;
      status: string;
      pending_elicitation_id?: string;
    };

    // Deterministic-path proof: the mock LLM provider recorded ZERO calls.
    expect(getMockProvider().calls.length).toBe(llmCallsBefore);

    // The turn ended awaiting_input with a pending elicitation handle.
    expect(outcome.status).toBe("awaiting_input");
    expect(outcome.conversation.status).toBe("awaiting_input");
    expect(typeof outcome.pending_elicitation_id).toBe("string");
    const elicitationId = outcome.pending_elicitation_id as string;

    // The event stream carries the same envelope the LLM pause produces.
    const elicitFrame = outcome.events.find((e) => e.type === "elicit_request");
    expect(elicitFrame).toBeDefined();
    expect(elicitFrame?.tool_name).toBe("ask_user_form");
    expect(elicitFrame?.elicitation_id).toBe(elicitationId);
    expect(outcome.events.some((e) => e.type === "completed")).toBe(true);

    // ── Persisted pause shape: pending ask_user_form with a masked field ──
    const [elicitationRow] = await http.db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, http.tenantId),
          eq(conversationElicitations.id, elicitationId),
        ),
      );
    expect(elicitationRow).toBeDefined();
    expect(elicitationRow?.status).toBe("pending");
    expect(elicitationRow?.tool_name).toBe("ask_user_form");
    const formInput = elicitationRow?.input as {
      question: string;
      fields: Array<{ name: string; type: string; sensitive?: boolean }>;
    };
    // A REAL password/sensitive field spec — this is what makes
    // resolveElicitation's existing redaction fire at persist.
    expect(formInput.fields).toHaveLength(1);
    expect(formInput.fields[0]?.name).toBe("credential");
    expect(formInput.fields[0]?.type).toBe("password");
    expect(formInput.fields[0]?.sensitive).toBe(true);
    // The hint titles the form; it is a kind label, never a secret.
    expect(formInput.question).toContain("digitalocean pat");

    // ── Pairing invariant: the elicitation is anchored to a synthesized
    // ask_user_form tool_use, never a bare (tool_call_id: null) row that
    // would orphan the resume path's tool_use ↔ tool_result pairing. ──
    expect(elicitationRow?.tool_call_id).not.toBeNull();
    const toolCallId = elicitationRow?.tool_call_id as string;
    const [toolCallRow] = await http.db
      .select()
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, http.tenantId),
          eq(conversationToolCalls.id, toolCallId),
        ),
      );
    expect(toolCallRow).toBeDefined();
    expect(toolCallRow?.tool).toBe("ask_user_form");
    // Anchored to the assistant message of the turn (causal threading).
    expect(toolCallRow?.parent_message_id).not.toBeNull();
    expect(elicitationRow?.parent_message_id).toBe(toolCallRow?.parent_message_id ?? null);
    // Same pending placeholder the paused LLM tool writes.
    expect((toolCallRow?.output as { status?: string })?.status).toBe("awaiting_input");

    // ── The reader's view: the masked field is answerable in the cockpit ──
    const detailRes = await fetch(`${http.baseUrl}/v1/conversations/${convId}`, {
      headers: { authorization: `Bearer ${http.apiKey}` },
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      tool_calls: Array<{ id: string }>;
      resume_summary?: {
        pending_approval?: {
          id: string;
          tool_call_id?: string;
          prompt?: { fields?: Array<Record<string, unknown>> };
        };
      };
    };
    const pendingView = detail.resume_summary?.pending_approval;
    expect(pendingView?.id).toBe(elicitationId);
    expect(detail.tool_calls.some((call) => call.id === pendingView?.tool_call_id)).toBe(true);
    expect(pendingView?.prompt?.fields).toEqual([
      expect.objectContaining({ name: "credential", type: "password", sensitive: true }),
    ]);
    expect(pendingView?.prompt?.fields?.[0]).not.toHaveProperty("default");

    // ── Resume: respond to the elicitation with the (fake) secret ──────
    const respondRes = await postJson(
      `/v1/conversations/${convId}/elicitations/${elicitationId}/respond`,
      { output: { values: { credential: FAKE_SECRET } } },
    );
    expect(respondRes.status).toBe(200);
    const resumed = (await respondRes.json()) as {
      conversation: { status: string };
      status: string;
    };
    // The loop resumed without error and the conversation left
    // awaiting_input — the pairing invariant held on replay.
    expect(resumed.status).not.toBe("awaiting_input");
    const [convRow] = await http.db
      .select({ status: conversations.status })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, http.tenantId), eq(conversations.id, convId)));
    expect(convRow?.status).not.toBe("awaiting_input");

    // ── Redaction at persist (#304, reused — zero new redaction code) ──
    const [resolvedRow] = await http.db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, http.tenantId),
          eq(conversationElicitations.id, elicitationId),
        ),
      );
    expect(resolvedRow?.status).toBe("resolved");
    const storedOutput = resolvedRow?.output as { values?: Record<string, string> };
    expect(storedOutput?.values?.credential).toBe(ELICITATION_REDACTED_MARKER);
    expect(JSON.stringify(resolvedRow ?? {})).not.toContain(FAKE_SECRET);

    // No secret anywhere in the conversation's persisted rows: messages,
    // tool calls (input/output/interaction_log), elicitations.
    const messageRows = await http.db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.tenant_id, http.tenantId),
          eq(conversationMessages.conversation_id, convId),
        ),
      );
    expect(JSON.stringify(messageRows)).not.toContain(FAKE_SECRET);
    const toolCallRows = await http.db
      .select()
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, http.tenantId),
          eq(conversationToolCalls.conversation_id, convId),
        ),
      );
    expect(JSON.stringify(toolCallRows)).not.toContain(FAKE_SECRET);
    const elicitationRows = await http.db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, http.tenantId),
          eq(conversationElicitations.conversation_id, convId),
        ),
      );
    expect(JSON.stringify(elicitationRows)).not.toContain(FAKE_SECRET);
  }, 60_000);

  test("event without credential_hint falls back to a generic credential label", async () => {
    const createRes = await postJson("/v1/conversations", {});
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { conversation: { id: string } };

    const llmCallsBefore = getMockProvider().calls.length;
    const res = await postJson(`/v1/conversations/${created.conversation.id}/messages`, {
      message: FALLBACK_PROSE,
      event: { type: "request_credential_form" },
    });
    expect(res.status).toBe(200);
    const outcome = (await res.json()) as {
      status: string;
      pending_elicitation_id?: string;
    };
    expect(getMockProvider().calls.length).toBe(llmCallsBefore);
    expect(outcome.status).toBe("awaiting_input");
    const [row] = await http.db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, http.tenantId),
          eq(conversationElicitations.id, outcome.pending_elicitation_id as string),
        ),
      );
    const input = row?.input as { fields: Array<{ label: string; type: string }> };
    expect(input.fields[0]?.type).toBe("password");
    expect(input.fields[0]?.label).toBe("credential");
  }, 60_000);
});
