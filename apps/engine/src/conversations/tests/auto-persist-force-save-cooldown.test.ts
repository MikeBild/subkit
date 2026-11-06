import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import {
  auditLog,
  connectors,
  conversationElicitations,
  conversations,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { TEST_HUMAN_ANSWER } from "../../test-helpers/answer-actor.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import {
  withConnectorInspection,
  withConnectorProbe,
  withConnectorValidation,
} from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { appendSnapshot, loadDraft } from "../draft.ts";
import { maybeAutoPersistFromElicitation } from "../persistence/auto-persist.ts";
import { saveConnectorAtomic } from "../persistence/save-connector.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("auto_persist_force_cooldown");
  tenant_id = (await seedTenant(ctx.db, { slug: "t-fsc", display_name: "T-FSC" })).id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function freshFailedProbeDraft(slug: string): DraftDocument {
  const baseDraft: DraftDocument = {
    mode: "connector_authoring",
    connector: {
      name: slug,
      slug,
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://api.example.test",
    },
    workflow: { name: "", steps: [] },
  };
  const validated = withConnectorValidation(
    withConnectorInspection(baseDraft),
    {
      ...baseDraft.connector,
      validation: validateConnectorDraft(baseDraft.connector ?? null, []),
    },
    true,
    "Connector draft validated.",
  );
  return withConnectorProbe(
    validated,
    {
      ...validated.connector,
      latest_probe: {
        ok: false,
        method: "GET",
        path: "/health",
        environment: "dev",
        status_code: 503,
        duration_ms: 1,
        summary: "Probe reached the system but returned HTTP 503.",
        response_preview: "upstream maintenance window",
        probed_at: new Date(getTestNow()).toISOString(),
      },
    },
    false,
    "probe failed: HTTP 503",
    "connector_probe_failed",
  );
}

async function seedConversationWithDraft(slug: string): Promise<{ conversation_id: string }> {
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "awaiting_input" })
    .returning();
  await appendSnapshot(tenant_id, conv!.id, freshFailedProbeDraft(slug), ctx.db);
  return { conversation_id: conv!.id };
}

describe("force_save through a resolved approval bypasses the probe-failure cooldown", () => {
  test("approved ask_user_confirm commit_intent persists despite the fresh failed probe and audits the bypass", async () => {
    const { conversation_id } = await seedConversationWithDraft("fsc-approved");
    const [row] = await ctx.db
      .insert(conversationElicitations)
      .values({
        tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "Force-save the connector despite probe failure?",
        input: {
          question: "Force-save the connector despite probe failure?",
          kind: "generic",
          commit_intent: {
            kind: "save_connector_draft",
            payload: { force_save: true, environment: "dev" },
            description: "Force-save the connector despite the failed probe.",
          },
        },
        output: { confirmed: true },
        status: "resolved",
      })
      .returning();
    if (!row) throw new Error("failed to insert elicitation");

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: { confirmed: true },
      elicitation: { id: row.id, tool_name: row.tool_name, input: row.input },
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(true);

    const saved = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, "fsc-approved")));
    expect(saved.length).toBe(1);

    const overrides = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.action, AuditAction.CONNECTOR_SAVED_OVERRIDE),
          eq(auditLog.resource_id, saved[0]!.id),
        ),
      )
      .orderBy(desc(auditLog.ts));
    expect(overrides.length).toBeGreaterThan(0);
    const meta = overrides[0]!.metadata as {
      forced?: boolean;
      cooldown_bypassed?: boolean;
      source?: string;
    };
    expect(meta.forced).toBe(true);
    expect(meta.cooldown_bypassed).toBe(true);
    expect(meta.source).toBe("harness_auto_persist");

    const draftAfter = await loadDraft(tenant_id, conversation_id, ctx.db);
    expect(draftAfter.connector?.saved_connector_id).toBe(saved[0]!.id);
  });

  test("bare force_save without an approval keeps the cooldown refusal", async () => {
    const { conversation_id } = await seedConversationWithDraft("fsc-bare");
    let draft = freshFailedProbeDraft("fsc-bare");
    const toolCtx: ToolContext = {
      db: ctx.db,
      tenant_id,
      conversation_id,
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      engineClient: {} as never,
      getDraft: () => draft,
      setDraft: async (next: DraftDocument) => {
        draft = next;
      },
    };

    const blocked = await saveConnectorAtomic({
      ctx: toolCtx,
      environment: "dev",
      forceSave: true,
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected cooldown rejection");
    expect(blocked.error_code).toBe("force_save_cooldown");

    const saved = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, "fsc-bare")));
    expect(saved.length).toBe(0);
  });
});
