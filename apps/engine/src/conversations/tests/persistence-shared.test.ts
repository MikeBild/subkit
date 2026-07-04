// Persistence refactor sanity check.
//
// `saveConnectorAtomic` (in persistence/save-connector.ts) and the
// `save_connector_draft` tool wrapper must produce the same DB state
// for the same input. This test exercises both paths against
// equivalent draft snapshots and asserts the resulting connector +
// credential rows are equivalent (modulo the audit `source` tag).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { connectors, conversations, credentials, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import {
  withConnectorInspection,
  withConnectorProbe,
  withConnectorValidation,
} from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { saveConnectorAtomic } from "../persistence/save-connector.ts";
import type { ToolContext } from "../tools/index.ts";
import { saveConnectorDraftTool } from "../tools/save-connector-draft.ts";
import type { DraftDocument } from "../types.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("persistence_shared");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-ps", display_name: "T-PS" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

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

async function seedConversation(): Promise<string> {
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning();
  return conv!.id;
}

function buildToolCtx(conversation_id: string, draftRef: { current: DraftDocument }): ToolContext {
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
    getDraft: () => draftRef.current,
    setDraft: async (next) => {
      draftRef.current = next;
    },
    abortSignal: new AbortController().signal,
  };
}

describe("persistence/save-connector vs tool wrapper", () => {
  test("both paths produce identical connector + credential rows", async () => {
    // Path A: tool wrapper.
    const convA = await seedConversation();
    const draftRefA = { current: readyDraft("ps-tool") };
    const resA = await saveConnectorDraftTool.execute(buildToolCtx(convA, draftRefA), {
      credential: { mode: "bearer", token: "shared-secret-token" },
      environment: "dev",
    });
    expect(resA.ok).toBe(true);
    const idA = (resA.data as { connector: { id: string } }).connector.id;

    // Path B: direct call to saveConnectorAtomic.
    const convB = await seedConversation();
    const draftRefB = { current: readyDraft("ps-direct") };
    const resB = await saveConnectorAtomic({
      ctx: buildToolCtx(convB, draftRefB),
      environment: "dev",
      credential: { mode: "bearer", token: "shared-secret-token" },
    });
    expect(resB.ok).toBe(true);
    const idB = (resB.data as { connector: { id: string } }).connector.id;

    // Connector rows match in shape (different ids/slugs, but same
    // driver + environment + auth_type + base_url).
    const [connA] = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.id, idA)));
    const [connB] = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.id, idB)));
    expect(connA?.driver).toBe(connB?.driver);
    expect(connA?.environment).toBe(connB?.environment);
    expect(connA?.auth_type).toBe(connB?.auth_type);
    expect(connA?.base_url).toBe(connB?.base_url);

    // Credential rows match in shape.
    const [credA] = await ctx.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.tenant_id, tenant_id), eq(credentials.connector_id, idA)));
    const [credB] = await ctx.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.tenant_id, tenant_id), eq(credentials.connector_id, idB)));
    expect(credA?.mode).toBe("bearer");
    expect(credB?.mode).toBe("bearer");
    expect(credA?.environment).toBe(credB?.environment);
  });
});
