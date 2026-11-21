import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, connectors, conversations, tenants, vaultItems } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import {
  withConnectorInspection,
  withConnectorProbe,
  withConnectorValidation,
} from "../authoring-state/index.ts";
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

    const credRows = await ctx.db
      .select()
      .from(vaultItems)
      .where(
        and(eq(vaultItems.tenant_id, tenant_id), eq(vaultItems.connector_id, data.connector.id)),
      );
    expect(credRows).toHaveLength(1);
    expect(credRows[0]!.mode).toBe("bearer");
    expect(credRows[0]!.environment).toBe("dev");

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
    expect(secondData.already_persisted ?? secondData.idempotent).toBe(true);

    const connectorRows = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, "acme-idem")));
    expect(connectorRows).toHaveLength(1);

    const credRows = await ctx.db
      .select()
      .from(vaultItems)
      .where(and(eq(vaultItems.tenant_id, tenant_id), eq(vaultItems.connector_id, firstId)));
    expect(credRows).toHaveLength(1);
  });

  test("save without credential on a bearer-auth draft returns the credential_required envelope", async () => {
    const draftRef = { current: readyDraft("acme-nocred") };
    const result = await saveConnectorDraftTool.execute(buildToolCtx(draftRef), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const data = result.data as { error_code?: string } | undefined;
      expect(result.error_code ?? data?.error_code).toBe("credential_required");
      expect(result.next_best_actions ?? []).toContain("ask_user_form");
    }
  });
});
