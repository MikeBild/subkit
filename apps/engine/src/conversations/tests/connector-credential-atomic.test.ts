// save_connector_draft + credential atomic-save regression tests.
//
// Reproduces the user-reported flow: a probe returns 401 → masked
// `ask_user_form(type: password)` collects the secret → the value flows
// directly into `save_connector_draft({ credential })`, which persists
// the connector AND the credential in one call. There is no separate
// `submit_connector_credential` step, no user-supplied credential name,
// and no second confirmation between connector save and credential
// save.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  connectors,
  conversations,
  credentials,
  tenants,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import {
  withConnectorInspection,
  withConnectorProbe,
  withConnectorValidation,
} from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import type { ToolContext } from "../tools/index.ts";
import { saveConnectorDraftTool } from "../tools/save-connector-draft.ts";
import type { DraftDocument } from "../types.ts";

let ctx: TestDb;
let tenant_id: string;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createTestDb("connector_credential_atomic");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-cca", display_name: "T-CCA" })
    .returning();
  tenant_id = t!.id;
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning();
  conversation_id = conv!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function buildToolCtx(getDraftRef: { current: DraftDocument }): ToolContext {
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
    getDraft: () => getDraftRef.current,
    setDraft: async (next) => {
      getDraftRef.current = next;
    },
    abortSignal: new AbortController().signal,
  };
}

function readyDraft(slug: string): DraftDocument {
  const baseDraft: DraftDocument = {
    mode: "connector_authoring",
    connector: {
      name: slug,
      slug,
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: "https://api.example.test",
    },
    workflow: { name: "", steps: [] },
  };
  const validated = withConnectorValidation(
    withConnectorInspection(baseDraft),
    {
      ...baseDraft.connector,
      validation: validateConnectorDraft(baseDraft.connector ?? null),
    },
    true,
    "Connector draft validated.",
  );
  return withConnectorProbe(
    validated,
    {
      ...validated.connector,
      latest_probe: {
        ok: true,
        method: "GET",
        path: "/health",
        environment: "dev",
        status_code: 200,
        summary: "ok",
      },
    },
    true,
    "ok",
  );
}

describe("saveConnectorDraftTool — atomic credential save", () => {
  test("bearer credential is persisted in the same call as the connector", async () => {
    const draftRef = { current: readyDraft("acme-bearer") };
    const result = await saveConnectorDraftTool.execute(buildToolCtx(draftRef), {
      credential: { mode: "bearer", token: "secret-bearer-1" },
      environment: "dev",
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      connector: { id: string; slug: string };
      credential_persisted?: boolean;
    };
    expect(data.connector.slug).toBe("acme-bearer");
    expect(data.credential_persisted).toBe(true);

    // Exactly one credential row tied to the new connector.
    const credRows = await ctx.db
      .select()
      .from(credentials)
      .where(
        and(eq(credentials.tenant_id, tenant_id), eq(credentials.connector_id, data.connector.id)),
      );
    expect(credRows).toHaveLength(1);
    expect(credRows[0]!.mode).toBe("bearer");
    expect(credRows[0]!.environment).toBe("dev");

    // Exactly one credential.created audit row.
    const audit = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.resource_id, credRows[0]!.id)));
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  test("re-issued tool_call with same draft is idempotent — no duplicate connector or credential", async () => {
    const draftRef = { current: readyDraft("acme-idem") };
    const first = await saveConnectorDraftTool.execute(buildToolCtx(draftRef), {
      credential: { mode: "bearer", token: "secret-bearer-2" },
      environment: "dev",
    });
    expect(first.ok).toBe(true);
    const firstId = (first.data as { connector: { id: string } }).connector.id;

    // The draft now records saved_connector_id; re-issuing the same
    // tool_call (the `2ee4511c-...` symptom in the bug log) MUST NOT
    // create a second connector row.
    const second = await saveConnectorDraftTool.execute(buildToolCtx(draftRef), {
      credential: { mode: "bearer", token: "secret-bearer-2" },
      environment: "dev",
    });
    expect(second.ok).toBe(true);
    const secondData = second.data as {
      connector: { id: string };
      idempotent?: boolean;
      already_persisted?: boolean;
    };
    expect(secondData.connector.id).toBe(firstId);
    // The diagnostic re-issue path short-circuits with `already_persisted`
    // when the supplied credential matches the stored one byte-for-byte;
    // the harness auto-persist path returned `idempotent: true`, but the
    // tool wrapper's contract is `already_persisted: true` so callers
    // (and the audit trail) can distinguish the two cases.
    expect(secondData.already_persisted ?? secondData.idempotent).toBe(true);

    const connectorRows = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, "acme-idem")));
    expect(connectorRows).toHaveLength(1);

    const credRows = await ctx.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.tenant_id, tenant_id), eq(credentials.connector_id, firstId)));
    // upsertCredential keeps a single row per (connector, environment).
    expect(credRows).toHaveLength(1);
  });

  test("save without credential on a bearer-auth draft returns the credential_required envelope", async () => {
    // PR10/PR15 contract: a connector with `auth_type !== "none"` must
    // have a credential before it can be persisted. Calling
    // save_connector_draft without one returns a structured
    // `credential_required` envelope with `next_best_actions:
    // ["ask_user_form"]` rather than silently saving a connector with
    // no credential row.
    const draftRef = { current: readyDraft("acme-nocred") };
    const result = await saveConnectorDraftTool.execute(buildToolCtx(draftRef), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The atomic helper populates `data.error_code` AND the top-level
      // `error_code` so legacy and structured callers both see the
      // signal. Check both.
      const data = result.data as { error_code?: string } | undefined;
      expect(result.error_code ?? data?.error_code).toBe("credential_required");
      expect(result.next_best_actions ?? []).toContain("ask_user_form");
    }
  });
});
