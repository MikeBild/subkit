import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import { auditLog } from "../../db/schema/audit.ts";
import { conversationElicitations, conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import type { ElicitationBridge, ElicitationResult } from "../elicitation-bridge.ts";
import { ElicitationUnsupportedError, FORM_FAST_CANCEL_MS } from "../elicitation-bridge.ts";
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

async function freshConversation(): Promise<string> {
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning();
  return conv!.id;
}

function makeBridge(
  behaviour:
    | { kind: "accept"; content: Record<string, unknown> }
    | { kind: "decline"; delayMs?: number }
    | { kind: "cancel"; delayMs?: number }
    | { kind: "throw"; error: Error },
): ElicitationBridge {
  const elicitForm = async (): Promise<ElicitationResult> => {
    switch (behaviour.kind) {
      case "accept":
        return { action: "accept", content: behaviour.content };
      case "decline":
        if (behaviour.delayMs) await Bun.sleep(behaviour.delayMs);
        return { action: "decline" };
      case "cancel":
        if (behaviour.delayMs) await Bun.sleep(behaviour.delayMs);
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
  test("ask-user persists the EngineClient system-account actor", async () => {
    const conversation_id = await freshConversation();
    const actor_id = "10000000-0000-4000-8000-000000000021";
    const toolContext = buildCtx(conversation_id);
    toolContext.actor_id = actor_id;
    toolContext.engineClient = new EngineClient({
      tenant_id,
      actor_id,
      actor_type: "system_account",
      db: ctx.db,
    });

    const result = await pauseForUserInput(toolContext, {
      tool_name: "ask_user_text",
      summary: "Choose a value",
      input: { question: "Which value should be used?" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.pause) throw new Error("expected pending elicitation");
    const [audit] = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.action, AuditAction.APPROVAL_REQUESTED),
          eq(auditLog.resource_id, result.pause.elicitation_id),
        ),
      )
      .limit(1);
    expect(audit).toEqual({ actor_type: "system_account", actor_id });
  });

  test("accept → no pause, conversation back to active, row protocol_native + resolved", async () => {
    const conversation_id = await freshConversation();
    const bridge = makeBridge({ kind: "accept", content: { value: "my-answer" } });
    const result = await pauseForUserInput(buildCtx(conversation_id, bridge), {
      tool_name: "ask_user_text",
      summary: "What is your name?",
      input: { question: "What is your name?" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pause).toBeUndefined();
      expect(result.data).toEqual({ value: "my-answer" });
    }

    expect(await readConversationStatus(conversation_id)).toBe("active");

    const rows = await readElicitation(conversation_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.protocol_native).toBe(true);
    expect(rows[0]!.status).toBe("resolved");
    expect(rows[0]!.output).toEqual({ value: "my-answer" });

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

  test("cancel (after the fast-cancel window) → row resolved cancelled (user_cancelled), structured error", async () => {
    const conversation_id = await freshConversation();
    const bridge = makeBridge({ kind: "cancel", delayMs: FORM_FAST_CANCEL_MS + 100 });
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

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe(INVALID_ELICIT_RESPONSE);
      expect(result.pause).toBeUndefined();
    }
    expect(await readConversationStatus(conversation_id)).toBe("active");

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
    expect(await readConversationStatus(conversation_id)).toBe("awaiting_input");
    const rows = await readElicitation(conversation_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.protocol_native).toBe(false);
  });
});

describe("pauseForUserInput — bridge transport failure", () => {
  test("non-ElicitationUnsupportedError throw → NON-DESTRUCTIVE demote: row stays pending, conversation stays awaiting_input, pause returned", async () => {
    const conversation_id = await freshConversation();
    const bridge = makeBridge({ kind: "throw", error: new Error("client disconnected") });
    const result = await pauseForUserInput(buildCtx(conversation_id, bridge), {
      tool_name: "ask_user_text",
      summary: "What is your name?",
      input: { question: "What is your name?" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pause).toBeDefined();
      expect(result.pause?.tool_name).toBe("ask_user_text");
      expect(result.data).toEqual({
        status: "awaiting_input",
        elicitation_id: result.pause!.elicitation_id,
      });
    }
    expect(await readConversationStatus(conversation_id)).toBe("awaiting_input");
    const rows = await readElicitation(conversation_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.protocol_native).toBe(false);
    if (result.ok) expect(result.pause?.elicitation_id).toBe(rows[0]!.id);

    const demoteAudit = await readResolveAudit(rows[0]!.id, "elicitation.demoted_to_portal");
    expect(demoteAudit).toBeDefined();
    expect(demoteAudit!.tenant_id).toBe(tenant_id);
    const rejectedAudit = await readResolveAudit(rows[0]!.id, "approval.rejected");
    expect(rejectedAudit).toBeUndefined();
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

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pause).toBeDefined();
    expect(await readConversationStatus(conversation_id)).toBe("awaiting_input");
    const rows = await readElicitation(conversation_id);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.protocol_native).toBe(false);
  });

  test("ElicitationUnsupportedError mid-call demotes the SAME row — no second elicitation minted", async () => {
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

    const rows = await readElicitation(conversation_id);
    expect(rows).toHaveLength(1);
    const originalRowId = rows[0]!.id;

    expect(rows[0]!.protocol_native).toBe(false);
    expect(rows[0]!.status).toBe("pending");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pause?.elicitation_id).toBe(originalRowId);
      expect((result.data as { elicitation_id: string }).elicitation_id).toBe(originalRowId);
    }

    const demoteAudit = await readResolveAudit(originalRowId, "elicitation.demoted_to_portal");
    expect(demoteAudit).toBeDefined();
    expect(demoteAudit!.resource_id).toBe(originalRowId);
    expect(demoteAudit!.tenant_id).toBe(tenant_id);
  });
});

describe("pauseForUserInput — fast-cancel heuristic", () => {
  test("instant cancel (< FORM_FAST_CANCEL_MS) → NON-DESTRUCTIVE demote to portal DB-pause", async () => {
    const conversation_id = await freshConversation();
    const bridge = makeBridge({ kind: "cancel" });
    const result = await pauseForUserInput(buildCtx(conversation_id, bridge), {
      tool_name: "ask_user_text",
      summary: "What is your name?",
      input: { question: "What is your name?" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pause).toBeDefined();
      expect(result.data).toEqual({
        status: "awaiting_input",
        elicitation_id: result.pause!.elicitation_id,
      });
    }
    expect(await readConversationStatus(conversation_id)).toBe("awaiting_input");
    const rows = await readElicitation(conversation_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.protocol_native).toBe(false);

    const demoteAudit = await readResolveAudit(rows[0]!.id, "elicitation.demoted_to_portal");
    expect(demoteAudit).toBeDefined();
    const rejectedAudit = await readResolveAudit(rows[0]!.id, "approval.rejected");
    expect(rejectedAudit).toBeUndefined();
  });

  test("cancel after the fast-cancel window → genuine human cancel: destructive resolution", async () => {
    const conversation_id = await freshConversation();
    const bridge = makeBridge({ kind: "cancel", delayMs: FORM_FAST_CANCEL_MS + 100 });
    const result = await pauseForUserInput(buildCtx(conversation_id, bridge), {
      tool_name: "ask_user_text",
      summary: "What is your name?",
      input: { question: "What is your name?" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("user_cancelled");
      expect(result.pause).toBeUndefined();
    }
    expect(await readConversationStatus(conversation_id)).toBe("active");
    const rows = await readElicitation(conversation_id);
    expect(rows[0]!.status).toBe("cancelled");
    expect(rows[0]!.decision_reason).toBe("user_cancelled");
  });

  test("instant decline is STILL honored — decline is always a human decision", async () => {
    const conversation_id = await freshConversation();
    const bridge = makeBridge({ kind: "decline" });
    const result = await pauseForUserInput(buildCtx(conversation_id, bridge), {
      tool_name: "ask_user_text",
      summary: "What is your name?",
      input: { question: "What is your name?" },
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

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pause).toBeDefined();
    const rows = await readElicitation(conversation_id);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.protocol_native).toBe(false);
  });
});

describe("pauseForUserInput — D7 secret-elicitation guard (surface gated)", () => {
  test("password form without an active connector draft → directive and no row", async () => {
    const conversation_id = await freshConversation();
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
    expect(await readElicitation(conversation_id)).toHaveLength(0);
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

  test("subkit-cli local surface is NOT weakened — a password form still pauses for input", async () => {
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
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pause?.tool_name).toBe("ask_user_form");
    expect(await readElicitation(conversation_id)).toHaveLength(1);
  });
});

describe("pauseForUserInput — placeholder-destination hints are dropped (every surface)", () => {
  test("a form field hinting an example address is asked without the hint", async () => {
    const conversation_id = await freshConversation();
    const result = await pauseForUserInput(buildCtx(conversation_id), {
      tool_name: "ask_user_form",
      summary: "Where should the report go?",
      input: {
        question: "Where should the report go?",
        fields: [
          {
            name: "recipient_email",
            label: "Recipient email address",
            type: "text",
            placeholder: "you@example.com",
            required: true,
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pause).toBeDefined();
    const rows = await readElicitation(conversation_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    const stored = JSON.stringify(rows[0]);
    expect(stored).toContain("Recipient email address");
    expect(stored).not.toContain("you@example.com");
    expect(JSON.stringify(result)).not.toContain("you@example.com");
  });

  test("a text default carrying an example address is asked without the default", async () => {
    const conversation_id = await freshConversation();
    const result = await pauseForUserInput(buildCtx(conversation_id), {
      tool_name: "ask_user_text",
      summary: "Recipient?",
      input: { question: "Which address should receive the report?", default: "user@example.com" },
    });
    expect(result.ok).toBe(true);
    const rows = await readElicitation(conversation_id);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("user@example.com");
  });

  test("a question that names the placeholder it refuses is asked unchanged", async () => {
    const conversation_id = await freshConversation();
    const result = await pauseForUserInput(buildCtx(conversation_id), {
      tool_name: "ask_user_text",
      summary: "Real address needed",
      input: {
        question:
          "test@example.com is a placeholder — which real address should receive the report?",
        placeholder: "name@company.tld",
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pause).toBeDefined();
    const rows = await readElicitation(conversation_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(JSON.stringify(rows[0])).toContain("test@example.com");
  });
});
