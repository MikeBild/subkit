// Regression for session 16a8f1c7 (the "approve twice" symptom on
// connector save). Pre-fix the LLM proposed → probed → asked the user
// to confirm save WITHOUT calling inspect_connector_draft /
// validate_connector_draft first. The harness auto-persist path then
// bounced off saveConnectorAtomic's stale-checkpoint gate
// (`connector_not_ready`, missing `connector_inspected` /
// `connector_validated`). The LLM saw the failure, manually freshened
// the checkpoints, and re-issued save_connector_draft as a tool call
// — which hit the tool-policy gate (`confirm_before_execution`) and
// emitted a SECOND ask_user_confirm. The user had to approve twice.
//
// Post-fix the auto-persist dispatcher freshens both checkpoints
// before saveConnectorAtomic, so the operator's first "yes save"
// click is enough.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  connectors,
  conversationElicitations,
  conversations,
  credentials,
  tenants,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { TEST_HUMAN_ANSWER } from "../../test-helpers/answer-actor.ts";
import { withConnectorProbe } from "../authoring-state.ts";
import { appendSnapshot } from "../draft.ts";
import type { DraftDocument } from "../types.ts";
import { maybeAutoPersistFromElicitation } from "./auto-persist.ts";
import { _resetDraftCredentialCacheForTests } from "./draft-credential-cache.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("auto_persist_freshen_checkpoints");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-freshen", display_name: "T-FRESHEN" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  tenant_id = t.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

// A draft that has been probed (green) but NEVER inspected or
// validated — exactly the shape the LLM produces when it skips the
// discipline checkpoints and jumps from probe to ask_user_confirm.
function probedButUnvalidatedDraft(slug: string): DraftDocument {
  const draft: DraftDocument = {
    mode: "connector_authoring",
    connector: {
      name: slug,
      slug,
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://api.open-meteo.com",
    },
    workflow: { name: "", steps: [] },
  };
  return withConnectorProbe(
    draft,
    {
      ...draft.connector,
      latest_probe: {
        ok: true,
        method: "GET",
        path: "/v1/forecast",
        environment: "dev",
        status_code: 200,
        summary: "ok",
      },
    },
    true,
    "ok",
  );
}

async function seedConversation(draft: DraftDocument): Promise<{
  conversation_id: string;
  elicitation_id: string;
}> {
  _resetDraftCredentialCacheForTests();
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "awaiting_input" })
    .returning();
  if (!conv) throw new Error("seed conversation failed");
  await appendSnapshot(tenant_id, conv.id, draft, ctx.db);
  const [elic] = await ctx.db
    .insert(conversationElicitations)
    .values({
      tenant_id,
      conversation_id: conv.id,
      tool_name: "ask_user_confirm",
      summary: "Save the connector",
      input: {
        kind: "save_workflow_draft",
        commit_intent: {
          kind: "save_connector_draft",
          payload: { environment: "dev" },
          description: "Save the connector",
        },
      },
      output: { confirmed: true },
      status: "resolved",
    })
    .returning();
  if (!elic) throw new Error("seed elicitation failed");
  return { conversation_id: conv.id, elicitation_id: elic.id };
}

describe("auto-persist · save_connector_draft freshens stale checkpoints", () => {
  test("persists on first user confirmation even when inspect/validate were never called", async () => {
    const slug = "freshen-on-save";
    const { conversation_id, elicitation_id } = await seedConversation(
      probedButUnvalidatedDraft(slug),
    );

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: { confirmed: true },
      elicitation: {
        id: elicitation_id,
        tool_name: "ask_user_confirm",
        input: {
          kind: "save_workflow_draft",
          commit_intent: {
            kind: "save_connector_draft",
            payload: { environment: "dev" },
            description: "Save the connector",
          },
        },
      },
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    // Pre-fix this was `ok:false` with error_code `connector_not_ready`
    // because `connector_inspected`+`connector_validated` were stale.
    expect(dispatch.synthetic_result?.ok).toBe(true);
    expect(dispatch.synthetic_result?.tool).toBe("save_connector_draft");

    // The connector row was actually written.
    const rows = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, slug)));
    expect(rows).toHaveLength(1);
  });

  test("auth=none connector with no credential still saves cleanly through one confirmation", async () => {
    // Sanity: the auto-freshen runs before saveConnectorAtomic, so a
    // pure no-auth connector (Open-Meteo case from session 16a8f1c7)
    // should not need ANY second prompt — no credential cache, no
    // probe replay, no extra elicitation.
    const slug = "freshen-no-auth";
    const { conversation_id, elicitation_id } = await seedConversation(
      probedButUnvalidatedDraft(slug),
    );

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: { confirmed: true },
      elicitation: {
        id: elicitation_id,
        tool_name: "ask_user_confirm",
        input: {
          kind: "save_workflow_draft",
          commit_intent: {
            kind: "save_connector_draft",
            payload: { environment: "dev" },
            description: "Save",
          },
        },
      },
      db: ctx.db,
    });

    expect(dispatch.synthetic_result?.ok).toBe(true);
    // No credentials should be persisted for an auth=none connector.
    const conn = (
      await ctx.db
        .select()
        .from(connectors)
        .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, slug)))
    )[0];
    expect(conn).toBeDefined();
    const creds = await ctx.db
      .select()
      .from(credentials)
      .where(eq(credentials.connector_id, conn!.id));
    expect(creds).toHaveLength(0);
  });
});
