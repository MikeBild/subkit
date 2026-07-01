// pauseForUserInput — MCP-native form elicitation integration tests.
//
// Three paths exercised against a real disposable Postgres:
//
//   1. Capable client → in-process resolution: no `pause`, the
//      conversation status flips awaiting_input → active, the
//      elicitation row is marked protocol_native AND resolved.
//   2. Capable client, decline/cancel → row resolved cancelled, no
//      continuation, structured error_code.
//   3. No bridge → DB-pause fallback (returns a `pause`, row pending).
//   4. Bridge present, non-ElicitationUnsupportedError transport
//      failure → row resolved cancelled with reason
//      `elicitation_transport_failed`, conversation flipped back to
//      active, structured `elicitation_transport_failed` error.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { conversationElicitations, conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import type { ElicitationBridge, ElicitationResult } from "../elicitation-bridge.ts";
import { ElicitationUnsupportedError } from "../elicitation-bridge.ts";
import { pauseForUserInput } from "../tools/ask-user/common.ts";
import { INVALID_ELICIT_RESPONSE } from "../tools/error-codes.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("pause_for_user_input_native");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-pfui", display_name: "T-PFUI" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

/** Fresh conversation in `active` state — pauseForUserInput will move it
 *  to `awaiting_input` via createElicitation. */
async function freshConversation(): Promise<string> {
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning();
  return conv!.id;
}

/**
 * A structural `ElicitationBridge` stub. Only `.capabilities` and
 * `.elicitForm` are reached by `pauseForUserInput`; `elicitOob` is
 * present for the type but unused here.
 */
function makeBridge(
  behaviour:
    | { kind: "accept"; content: Record<string, unknown> }
    | { kind: "decline" }
    | { kind: "cancel" }
    | { kind: "throw"; error: Error },
): ElicitationBridge {
  const elicitForm = async (): Promise<ElicitationResult> => {
    switch (behaviour.kind) {
      case "accept":
        return { action: "accept", content: behaviour.content };
      case "decline":
        return { action: "decline" };
      case "cancel":
        return { action: "cancel" };
      case "throw":
        throw behaviour.error;
    }
  };
  return {
    capabilities: { form: true, oob: true },
    elicitForm,
    elicitOob: elicitForm,
  } as unknown as ElicitationBridge;
}

function buildCtx(conversation_id: string, bridge?: ElicitationBridge): ToolContext {
  return {
    db: ctx.db,
    tenant_id,
    conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id,
      actor_id: null,
      actor_type: "system",
      db: ctx.db,
    }),
    getDraft: () => ({}) as DraftDocument,
    setDraft: async () => {},
    abortSignal: new AbortController().signal,
    ...(bridge ? { elicitationBridge: bridge } : {}),
  };
}

async function readConversationStatus(conversation_id: string): Promise<string> {
  const [row] = await ctx.db
    .select({ status: conversations.status })
    .from(conversations)
    .where(eq(conversations.id, conversation_id))
    .limit(1);
  return row!.status;
}

async function readElicitation(conversation_id: string) {
  const rows = await ctx.db
    .select()
    .from(conversationElicitations)
    .where(eq(conversationElicitations.conversation_id, conversation_id));
  return rows;
}

/** The resolve audit row for an elicitation carrier — `APPROVAL_APPROVED`
 *  or `APPROVAL_REJECTED`, keyed on the elicitation id as `resource_id`.
 *  Filtered by action so the paired `APPROVAL_REQUESTED` open row (same
 *  `resource_id`) is excluded. */
async function readResolveAudit(elicitation_id: string, action: string) {
  const [row] = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenant_id),
        eq(auditLog.resource_id, elicitation_id),
        eq(auditLog.action, action),
      ),
    );
  return row;
}

describe("pauseForUserInput — MCP-native form elicitation (capable client)", () => {
  test("accept → no pause, conversation back to active, row protocol_native + resolved", async () => {
    const conversation_id = await freshConversation();
    const bridge = makeBridge({ kind: "accept", content: { value: "my-answer" } });
    const result = await pauseForUserInput(buildCtx(conversation_id, bridge), {
      tool_name: "ask_user_text",
      summary: "What is your name?",
      input: { question: "What is your name?" },
    });

    // The loop continues this turn — no pause envelope.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pause).toBeUndefined();
      expect(result.data).toEqual({ value: "my-answer" });
    }

    // The conversation was flipped back to `active` (createElicitation
    // moved it to awaiting_input; the in-process accept transition
    // restores it).
    expect(await readConversationStatus(conversation_id)).toBe("active");

    const rows = await readElicitation(conversation_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.protocol_native).toBe(true);
    expect(rows[0]!.status).toBe("resolved");
    expect(rows[0]!.output).toEqual({ value: "my-answer" });

    // The resolve audit row carries the tri-state discriminators
    // (docs/developers/tool-palette.md): a bridge-delivered accept records
    // `surface: mcp_elicitation` and `elicitation_transport: succeeded`.
    const audit = await readResolveAudit(rows[0]!.id, "approval.approved");
    expect(audit).toBeDefined();
    const meta = audit!.metadata as Record<string, unknown>;
    expect(meta.surface).toBe("mcp_elicitation");
    expect(meta.elicitation_transport).toBe("succeeded");
  });

  test("decline → row resolved cancelled (user_declined), structured error, no pause", async () => {
    const conversation_id = await freshConversation();
    const bridge = makeBridge({ kind: "decline" });
    const result = await pauseForUserInput(buildCtx(conversation_id, bridge), {
      tool_name: "ask_user_text",
      summary: "Secret?",
      input: { question: "Secret?" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("user_declined");
      expect(result.pause).toBeUndefined();
    }
    expect(await readConversationStatus(conversation_id)).toBe("active");
    const rows = await readElicitation(conversation_id);
    expect(rows[0]!.status).toBe("cancelled");
    expect(rows[0]!.decision_reason).toBe("user_declined");
  });

  test("cancel → row resolved cancelled (user_cancelled), structured error", async () => {
    const conversation_id = await freshConversation();
    const bridge = makeBridge({ kind: "cancel" });
    const result = await pauseForUserInput(buildCtx(conversation_id, bridge), {
      tool_name: "ask_user_text",
      summary: "Secret?",
      input: { question: "Secret?" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("user_cancelled");
    const rows = await readElicitation(conversation_id);
    expect(rows[0]!.status).toBe("cancelled");
    expect(rows[0]!.decision_reason).toBe("user_cancelled");
  });

  test("accept with a contract-violating answer → row cancelled (invalid_elicit_response), structured error", async () => {
    // The client returns an `accept` action but an `ask_user_choice`
    // answer outside the requested enum. `mapElicitResultToAskUserOutput`
    // maps it to `null`, so the bridge path collapses the bogus accept
    // into the decline/cancel path: the row resolves `cancelled` with
    // `decision_reason: invalid_elicit_response` and the tool result
    // carries `error_code: invalid_elicit_response`.
    const conversation_id = await freshConversation();
    const bridge = makeBridge({ kind: "accept", content: { value: "not-in-enum" } });
    const result = await pauseForUserInput(buildCtx(conversation_id, bridge), {
      tool_name: "ask_user_choice",
      summary: "Pick a colour",
      input: {
        question: "Pick a colour",
        options: [
          { value: "red", label: "Red" },
          { value: "blue", label: "Blue" },
        ],
      },
    });

    // (b) the returned tool result reports the structured error code.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe(INVALID_ELICIT_RESPONSE);
      expect(result.pause).toBeUndefined();
    }
    // The conversation is unwedged — no longer awaiting input.
    expect(await readConversationStatus(conversation_id)).toBe("active");

    // (a) the elicitation row ends `cancelled` with the matching reason.
    const rows = await readElicitation(conversation_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("cancelled");
    expect(rows[0]!.decision_reason).toBe(INVALID_ELICIT_RESPONSE);
  });
});

describe("pauseForUserInput — DB-pause fallback (no bridge)", () => {
  test("no elicitationBridge → returns a pause, row stays pending, NOT protocol_native", async () => {
    const conversation_id = await freshConversation();
    const result = await pauseForUserInput(buildCtx(conversation_id), {
      tool_name: "ask_user_text",
      summary: "What is your name?",
      input: { question: "What is your name?" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pause).toBeDefined();
      expect(result.pause?.tool_name).toBe("ask_user_text");
    }
    // The DB-pause path leaves the conversation awaiting input.
    expect(await readConversationStatus(conversation_id)).toBe("awaiting_input");
    const rows = await readElicitation(conversation_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.protocol_native).toBe(false);
  });
});

describe("pauseForUserInput — bridge transport failure", () => {
  test("non-ElicitationUnsupportedError throw → row cancelled, conversation unwedged, structured error", async () => {
    const conversation_id = await freshConversation();
    const bridge = makeBridge({ kind: "throw", error: new Error("client disconnected") });
    const result = await pauseForUserInput(buildCtx(conversation_id, bridge), {
      tool_name: "ask_user_text",
      summary: "What is your name?",
      input: { question: "What is your name?" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("elicitation_transport_failed");
      // No `pause` — an external MCP client cannot resume a DB-pause.
      expect(result.pause).toBeUndefined();
    }
    // The conversation is no longer wedged in awaiting_input.
    expect(await readConversationStatus(conversation_id)).toBe("active");
    const rows = await readElicitation(conversation_id);
    expect(rows[0]!.status).toBe("cancelled");
    expect(rows[0]!.decision_reason).toBe("elicitation_transport_failed");

    // The resolve audit row records the tri-state: a bridge round-trip
    // that broke in transit is `APPROVAL_REJECTED` with
    // `surface: mcp_elicitation` and `elicitation_transport: failed`
    // (docs/developers/tool-palette.md — transport failure ≠ a governance
    // decision the operator made).
    const audit = await readResolveAudit(rows[0]!.id, "approval.rejected");
    expect(audit).toBeDefined();
    const meta = audit!.metadata as Record<string, unknown>;
    expect(meta.surface).toBe("mcp_elicitation");
    expect(meta.elicitation_transport).toBe("failed");
  });

  test("ElicitationUnsupportedError throw → falls back to a DB-pause on the existing row", async () => {
    const conversation_id = await freshConversation();
    const bridge = makeBridge({
      kind: "throw",
      error: new ElicitationUnsupportedError("form"),
    });
    const result = await pauseForUserInput(buildCtx(conversation_id, bridge), {
      tool_name: "ask_user_text",
      summary: "What is your name?",
      input: { question: "What is your name?" },
    });

    // Capability raced away mid-call — the row already exists and is
    // pending; surface it as a normal pause.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pause).toBeDefined();
    expect(await readConversationStatus(conversation_id)).toBe("awaiting_input");
    const rows = await readElicitation(conversation_id);
    expect(rows[0]!.status).toBe("pending");
    // The row was opened on the bridge path (protocol_native), but the
    // capability raced away and it now resumes via a portal POST. The
    // fallback demotes it so the `surface` audit metadata resolves to
    // `portal`, not `mcp_elicitation`.
    expect(rows[0]!.protocol_native).toBe(false);
  });

  test("ElicitationUnsupportedError mid-call demotes the SAME row — no second elicitation minted", async () => {
    // The `elicitForm` call raises `ElicitationUnsupportedError` AFTER
    // `createNativeElicitation` already wrote the `protocol_native: true`
    // carrier row. The fallback must NOT mint a second row: it demotes
    // the original to a portal carrier and the pause references its id —
    // so the one-row APPROVAL_REQUESTED → APPROVAL_* audit lifecycle is
    // preserved.
    const conversation_id = await freshConversation();
    const bridge = makeBridge({
      kind: "throw",
      error: new ElicitationUnsupportedError("form"),
    });
    const result = await pauseForUserInput(buildCtx(conversation_id, bridge), {
      tool_name: "ask_user_text",
      summary: "What is your name?",
      input: { question: "What is your name?" },
    });

    // Exactly ONE `conversation_elicitations` row for this conversation —
    // the demote reuses the row `createNativeElicitation` opened.
    const rows = await readElicitation(conversation_id);
    expect(rows).toHaveLength(1);
    const originalRowId = rows[0]!.id;

    // The original row was demoted in place: protocol_native flipped to
    // false, still pending (it now resumes via a portal POST).
    expect(rows[0]!.protocol_native).toBe(false);
    expect(rows[0]!.status).toBe("pending");

    // The returned pause references the SAME row id, both on the pause
    // envelope and the `data` payload — not a freshly-minted second row.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pause?.elicitation_id).toBe(originalRowId);
      expect((result.data as { elicitation_id: string }).elicitation_id).toBe(originalRowId);
    }

    // The demote leaves a forensic `elicitation.demoted_to_portal` audit
    // row keyed on the elicitation id — without it an audit reader cannot
    // tell the carrier ever attempted the MCP bridge.
    const demoteAudit = await readResolveAudit(originalRowId, "elicitation.demoted_to_portal");
    expect(demoteAudit).toBeDefined();
    expect(demoteAudit!.resource_id).toBe(originalRowId);
    expect(demoteAudit!.tenant_id).toBe(tenant_id);
  });
});

describe("pauseForUserInput — degrade-to-DB-pause for non-flat tool input", () => {
  test("ask_user_form with a json field degrades — DB-pause even with a capable bridge", async () => {
    const conversation_id = await freshConversation();
    const bridge = makeBridge({ kind: "accept", content: {} });
    const result = await pauseForUserInput(buildCtx(conversation_id, bridge), {
      tool_name: "ask_user_form",
      summary: "Connector config",
      input: {
        question: "Connector config",
        fields: [{ name: "blob", label: "Raw config", type: "json" }],
      },
    });

    // The json field cannot map to a flat primitive — `mapAskUserToPrimitiveSchema`
    // degrades, so the bridge is never called and the DB-pause path runs.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pause).toBeDefined();
    const rows = await readElicitation(conversation_id);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.protocol_native).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D7 — no secret is elicited as chat text over MCP. The guard is scoped to
// `surface === "mcp"`; sk-cli / web input surfaces are untouched.
// ---------------------------------------------------------------------------
describe("pauseForUserInput — D7 secret-elicitation guard (surface gated)", () => {
  test("ask_user_form(password) over MCP → directive, NO pause, NO elicitation row", async () => {
    const conversation_id = await freshConversation();
    // Capable bridge present — the guard must still preempt it: the secret
    // must never reach the wire, and no DB elicitation row may be opened.
    const bridge = makeBridge({ kind: "accept", content: { token: "s3cr3t" } });
    const result = await pauseForUserInput(
      { ...buildCtx(conversation_id, bridge), surface: "mcp" },
      {
        tool_name: "ask_user_form",
        summary: "Enter your API key",
        input: {
          question: "Enter your API key",
          fields: [{ name: "token", label: "Token", type: "password" }],
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("secret_elicitation_blocked");
      expect(result.next_best_actions).toContain("request_connector_reauth");
      expect(result.pause).toBeUndefined();
    }
    // No row opened — the elicitation never happened.
    expect(await readElicitation(conversation_id)).toHaveLength(0);
    // Conversation stays active (never flipped to awaiting_input).
    expect(await readConversationStatus(conversation_id)).toBe("active");
  });

  test("ask_user_text secret question over MCP → directive", async () => {
    const conversation_id = await freshConversation();
    const result = await pauseForUserInput(
      { ...buildCtx(conversation_id), surface: "mcp" },
      {
        tool_name: "ask_user_text",
        summary: "Paste your personal access token",
        input: { question: "Paste your personal access token" },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("secret_elicitation_blocked");
    expect(await readElicitation(conversation_id)).toHaveLength(0);
  });

  test("non-secret ask_user_text over MCP is NOT blocked (normal DB-pause)", async () => {
    const conversation_id = await freshConversation();
    const result = await pauseForUserInput(
      { ...buildCtx(conversation_id), surface: "mcp" },
      {
        tool_name: "ask_user_text",
        summary: "What should the workflow be named?",
        input: { question: "What should the workflow be named?" },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pause).toBeDefined();
  });

  test("sk-cli local surface is NOT weakened — a password form still pauses for input", async () => {
    const conversation_id = await freshConversation();
    const result = await pauseForUserInput(
      { ...buildCtx(conversation_id), surface: "sk_interactive" },
      {
        tool_name: "ask_user_form",
        summary: "Enter your API key",
        input: {
          question: "Enter your API key",
          fields: [{ name: "token", label: "Token", type: "password" }],
        },
      },
    );
    // On sk-cli the operator can paste into the masked field — the DB-pause
    // proceeds and an elicitation row is opened, exactly as before.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pause?.tool_name).toBe("ask_user_form");
    expect(await readElicitation(conversation_id)).toHaveLength(1);
  });
});
