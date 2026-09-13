// Pin the `@`-mention contract: a reference resolves per turn with tenant +
// RBAC scoping into a narrow projection; a missing or withdrawn object is
// reported with one truthful sentence; the persisted user row carries the
// references (label scrubbed) and, after resolution, the unresolved subset;
// the transcript projection hands both to the client.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";

import type { ResolvedPrincipal } from "../../auth/types.ts";
import { connectors, conversationMessages, workflows } from "../../db/schema/index.ts";
import { getConversationBudgetReport } from "../../llm/core/conversation-budget-report.ts";
import { scrubString } from "../../logging/scrub-secrets.ts";
import { TEST_HUMAN_ANSWER } from "../../test-helpers/answer-actor.ts";
import { registerConversationAbort, unregisterConversationAbort } from "../abort.ts";
import { toMessageParts } from "../parts.ts";
import {
  type ConversationReference,
  dedupeReferences,
  markLatestUserMessageUnresolvedReferences,
  REFERENCE_LABEL_RE,
  REFERENCED_ENTITIES_MARKER,
  referencesTrimRef,
  resolveReferences,
} from "../references.ts";
import { appendUserMessage, createConversation, runConversationTurn } from "../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;
let workflowId: string;
let connectorSlug: string;
const MISSING_ID = "00000000-0000-4000-8000-000000000001";

function admin(): ResolvedPrincipal {
  return {
    provider: "conversation_tool",
    kind: "user",
    id: ctx.user_id,
    tenant_id: ctx.tenant_id,
    roles: ["admin"],
  } as ResolvedPrincipal;
}

function powerless(): ResolvedPrincipal {
  return {
    provider: "conversation_tool",
    kind: "user",
    id: ctx.user_id,
    tenant_id: ctx.tenant_id,
    roles: ["no-such-role"],
  } as ResolvedPrincipal;
}

beforeAll(async () => {
  ctx = await createConversationTestCtx("references");
  const [wf] = await ctx.testDb.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenant_id,
      slug: "customer-sync",
      name: "Customer sync",
      lifecycle: "active",
    })
    .returning();
  workflowId = wf!.id;
  const [c] = await ctx.testDb.db
    .select({ slug: connectors.slug })
    .from(connectors)
    .where(eq(connectors.id, ctx.connector_id))
    .limit(1);
  connectorSlug = c!.slug;
});

afterAll(async () => {
  await ctx.cleanup();
});

function resolverCtx(principal: ResolvedPrincipal | null, conversation_id = "conv-test") {
  return { db: ctx.testDb.db, tenant_id: ctx.tenant_id, conversation_id, principal };
}

describe("resolveReferences", () => {
  test("renders a workflow and a connector as narrow projections under the marker", async () => {
    const out = await resolveReferences(
      [
        { type: "workflow", id: workflowId, label: "customer-sync" },
        { type: "connector", id: ctx.connector_id, label: connectorSlug },
      ],
      resolverCtx(admin()),
    );
    expect(out.unresolved).toEqual([]);
    expect(out.resolved).toHaveLength(2);
    expect(out.block).toStartWith(REFERENCED_ENTITIES_MARKER);
    expect(out.block).toContain("use the ids directly instead of searching by name");
    expect(out.block).toContain(`WORKFLOW @customer-sync (id: ${workflowId})`);
    expect(out.block).toContain(`"lifecycle": "active"`);
    expect(out.block).toContain(`CONNECTOR @${connectorSlug} (id: ${ctx.connector_id})`);
    // Auth TYPE is fine; a credential value or config blob is not.
    expect(out.block).toContain(`"auth_type"`);
    expect(out.block).not.toContain(`"config"`);
    expect(out.block).not.toContain(`"dsn"`);
    expect(out.outcomes.map((o) => o.outcome)).toEqual(["ok", "ok"]);
  });

  test("an unknown id is reported as gone-or-forbidden with a no-guessing instruction", async () => {
    const out = await resolveReferences(
      [{ type: "workflow", id: MISSING_ID, label: "ghost" }],
      resolverCtx(admin()),
    );
    expect(out.resolved).toEqual([]);
    expect(out.unresolved).toHaveLength(1);
    expect(out.block).toContain("THIS WORKFLOW NO LONGER EXISTS OR IS NOT ACCESSIBLE");
    expect(out.block).toContain("do not search for it with tools");
    expect(out.outcomes[0]?.outcome).toBe("missing_or_forbidden");
  });

  test("a principal without read permission gets the SAME sentence as a missing object", async () => {
    const denied = await resolveReferences(
      [{ type: "workflow", id: workflowId, label: "customer-sync" }],
      resolverCtx(powerless()),
    );
    const missing = await resolveReferences(
      [{ type: "workflow", id: MISSING_ID, label: "customer-sync" }],
      resolverCtx(admin()),
    );
    expect(denied.outcomes[0]?.outcome).toBe("missing_or_forbidden");
    const strip = (s: string | null) => (s ?? "").replace(/\(id: [^)]+\)/g, "(id)");
    expect(strip(denied.block)).toBe(strip(missing.block));
    // The projection never leaks to a principal that may not read it.
    expect(denied.block).not.toContain(`"lifecycle"`);
  });

  test("a system actor (no principal) is trusted and resolves", async () => {
    const out = await resolveReferences(
      [{ type: "workflow", id: workflowId, label: "customer-sync" }],
      resolverCtx(null),
    );
    expect(out.resolved).toHaveLength(1);
  });

  test("the same object mentioned twice resolves once", async () => {
    const twice: ConversationReference[] = [
      { type: "workflow", id: workflowId, label: "customer-sync" },
      { type: "workflow", id: workflowId, label: "customer-sync" },
    ];
    expect(dedupeReferences(twice)).toHaveLength(1);
    const out = await resolveReferences(twice, resolverCtx(admin()));
    expect(out.resolved).toHaveLength(1);
    expect(out.block?.split("WORKFLOW @customer-sync")).toHaveLength(2);
  });

  test("nothing to resolve yields no block and no log noise", async () => {
    const out = await resolveReferences([], resolverCtx(admin()));
    expect(out.block).toBeNull();
    expect(out.trim_ref).toBeNull();
  });

  test("the trim reference keeps every id and names the tool that reloads it", () => {
    const ref = referencesTrimRef([
      { type: "workflow", id: workflowId, label: "customer-sync" },
      { type: "connector", id: ctx.connector_id, label: connectorSlug },
    ]);
    expect(ref).toStartWith(REFERENCED_ENTITIES_MARKER);
    expect(ref).toContain(`@customer-sync (id: ${workflowId}) — reload with inspect_workflow`);
    expect(ref).toContain(`(id: ${ctx.connector_id}) — reload with get_connector`);
    expect(ref).not.toContain("```");
  });

  test("label charset admits slugs and display names, rejects everything else", () => {
    expect(REFERENCE_LABEL_RE.test("customer-sync")).toBe(true);
    expect(REFERENCE_LABEL_RE.test("Kunden Export v2")).toBe(true);
    expect(REFERENCE_LABEL_RE.test("stripe.prod/eu")).toBe(true);
    expect(REFERENCE_LABEL_RE.test("")).toBe(false);
    expect(REFERENCE_LABEL_RE.test("x".repeat(201))).toBe(false);
    expect(REFERENCE_LABEL_RE.test("token=ghp_abc")).toBe(false);
    expect(REFERENCE_LABEL_RE.test("<script>")).toBe(false);
  });
});

describe("references on the persisted user row", () => {
  test("append persists references, scrubs the label, and records the unresolved subset", async () => {
    const created = await createConversation(
      { tenant_id: ctx.tenant_id, actor_id: ctx.user_id, initial_message: "hello" },
      ctx.testDb.db,
    );
    const conversation_id = created.conversation.id;
    // The label regex at the HTTP boundary rejects this; the persist
    // chokepoint scrubs anyway (defense in depth for non-HTTP callers).
    const secretLabel = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    expect(scrubString(secretLabel)).not.toBe(secretLabel);
    await appendUserMessage(
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        actor_id: ctx.user_id,
        message: "check @customer-sync and @ghost",
        references: [
          { type: "workflow", id: workflowId, label: "customer-sync" },
          { type: "workflow", id: MISSING_ID, label: secretLabel },
        ],
      },
      ctx.testDb.db,
    );
    const unresolved: ConversationReference[] = [
      { type: "workflow", id: MISSING_ID, label: "ghost" },
    ];
    await markLatestUserMessageUnresolvedReferences(
      ctx.testDb.db,
      ctx.tenant_id,
      conversation_id,
      unresolved,
    );

    const rows = await ctx.testDb.db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversation_id, conversation_id),
          eq(conversationMessages.role, "user"),
        ),
      )
      .orderBy(asc(conversationMessages.created_at));
    const last = rows[rows.length - 1]!;
    const content = last.content as {
      text: string;
      references: ConversationReference[];
      unresolved_references: ConversationReference[];
    };
    expect(content.references).toHaveLength(2);
    expect(content.references[0]).toEqual({
      type: "workflow",
      id: workflowId,
      label: "customer-sync",
    });
    expect(content.references[1]?.label).toBe(scrubString(secretLabel));
    expect(JSON.stringify(content)).not.toContain(secretLabel);
    expect(content.unresolved_references).toEqual(unresolved);

    // The transcript projection hands both lists to the client on the text part.
    const ui = toMessageParts(
      {
        id: last.id,
        conversation_id,
        role: "user",
        content: last.content,
        model: null,
        created_at: "now",
      },
      [],
    );
    const textPart = ui.parts[0] as {
      type: string;
      references?: ConversationReference[];
      unresolved_references?: ConversationReference[];
    };
    expect(textPart.type).toBe("text");
    expect(textPart.references).toHaveLength(2);
    expect(textPart.unresolved_references).toEqual(unresolved);
  });

  test("a turn without references leaves the row exactly as before", async () => {
    const created = await createConversation(
      { tenant_id: ctx.tenant_id, actor_id: ctx.user_id, initial_message: "plain" },
      ctx.testDb.db,
    );
    const [row] = await ctx.testDb.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversation_id, created.conversation.id));
    expect(row!.content).toEqual({ text: "plain" });
    await markLatestUserMessageUnresolvedReferences(
      ctx.testDb.db,
      ctx.tenant_id,
      created.conversation.id,
      [],
    );
    const [again] = await ctx.testDb.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversation_id, created.conversation.id));
    expect(again!.content).toEqual({ text: "plain" });
  });
});

describe("a turn with references (mock provider)", () => {
  test("resolves on the turn, marks the unresolved subset on the row, records the budget report", async () => {
    const created = await createConversation(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        initial_message: "what does @customer-sync do, and @ghost?",
        references: [
          { type: "workflow", id: workflowId, label: "customer-sync" },
          { type: "workflow", id: MISSING_ID, label: "ghost" },
        ],
      },
      ctx.testDb.db,
    );
    const conversation_id = created.conversation.id;
    const ctrl = registerConversationAbort(ctx.tenant_id, conversation_id);
    try {
      const outcome = await runConversationTurn(
        {
          tenant_id: ctx.tenant_id,
          conversation_id,
          actor_id: ctx.user_id,
          user_message: created.initial_message ?? "",
          user_references: created.references,
          answer_actor: TEST_HUMAN_ANSWER,
          user_memory: created.user_memory,
          turn_abort_ctrl: ctrl,
        },
        ctx.testDb.db,
      );
      expect(outcome.result.status).toBeDefined();
    } finally {
      unregisterConversationAbort(ctx.tenant_id, conversation_id, ctrl);
    }
    const [row] = await ctx.testDb.db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversation_id, conversation_id),
          eq(conversationMessages.role, "user"),
        ),
      )
      .orderBy(asc(conversationMessages.created_at))
      .limit(1);
    const content = row!.content as { unresolved_references?: ConversationReference[] };
    expect(content.unresolved_references).toEqual([
      { type: "workflow", id: MISSING_ID, label: "ghost" },
    ]);
    const report = getConversationBudgetReport(ctx.tenant_id, conversation_id);
    expect(report).not.toBeNull();
    expect(report!.total_tokens).toBeGreaterThan(0);
    expect(report!.dropped_sections).not.toContain("referenced_entities");
  });
});
