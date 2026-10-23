import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import * as docsService from "../../docs-ingestion/service.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { createEmptyDraftDocument } from "../authoring-state.ts";
import type { DraftDocument } from "../types.ts";
import { fetchConnectorDocsTool } from "./fetch-connector-docs.ts";
import type { ToolContext } from "./index.ts";
import { normalizeToolResultPayload } from "./result-payload.ts";

const nextUuid = createDeterministicUuidFactory(0xd0c_5);

let db: TestDb;
let tenant_id: string;
let crmId: string;
let mailId: string;
let searchSpy: ReturnType<typeof spyOn<typeof docsService, "searchDocs">> | null = null;

beforeAll(async () => {
  db = await createTestDb("fetch_connector_docs");
  const [t] = await db.db
    .insert(tenants)
    .values({ slug: "t-fetch-docs", display_name: "T" })
    .returning();
  tenant_id = t!.id;
  const rows = await db.db
    .insert(connectors)
    .values([
      {
        tenant_id,
        slug: "docs-crm",
        display_name: "CRM",
        driver: "http",
        base_url: "https://crm.docs.test",
        auth_type: "none",
      },
      {
        tenant_id,
        slug: "docs-mail",
        display_name: "Mail",
        driver: "http",
        base_url: "https://mail.docs.test",
        auth_type: "none",
      },
    ])
    .returning();
  crmId = rows.find((r) => r.slug === "docs-crm")!.id;
  mailId = rows.find((r) => r.slug === "docs-mail")!.id;
});

afterEach(() => {
  searchSpy?.mockRestore();
  searchSpy = null;
});

afterAll(async () => {
  await db.cleanup();
});

function makeCtx(draft: DraftDocument | null): ToolContext {
  return {
    db: db.db,
    tenant_id,
    conversation_id: nextUuid(),
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: db.db }),
    getDraft: () => draft ?? createEmptyDraftDocument(),
    setDraft: async () => {},
  };
}

function stubSearch() {
  const searched: string[] = [];
  searchSpy = spyOn(docsService, "searchDocs").mockImplementation(async (p) => {
    searched.push(p.connector_id);
    return [
      {
        id: `chunk-${p.connector_id === crmId ? "crm" : "mail"}`,
        document_id: "doc",
        title: p.connector_id === crmId ? "Deals" : "Send message",
        path: null,
        snippet: "…",
        rank: p.connector_id === crmId ? 0.4 : 0.9,
        match_type: "operation",
        fetched_at: null,
      },
    ] as docsService.SearchHit[];
  });
  return searched;
}

describe("fetch_connector_docs connector scope", () => {
  test("without a connector argument it searches every connector the draft calls and tags each hit", async () => {
    const draft = createEmptyDraftDocument("workflow_authoring");
    draft.workflow = {
      name: "Deals to mail",
      slug: "deals-to-mail",
      steps: [
        { id: "deals", kind: "request", method: "GET", connector_id: crmId, path: "/deals" },
        { id: "send", kind: "request", method: "POST", connector_id: mailId, path: "/send" },
      ],
    };
    const searched = stubSearch();
    const result = await fetchConnectorDocsTool.execute(makeCtx(draft), { query: "send" });
    expect(result.ok).toBe(true);
    expect(searched.sort()).toEqual([crmId, mailId].sort());
    const data = result.data as {
      hits: Array<{ connector_slug: string; title: string }>;
      connectors_searched: string[];
    };
    expect(data.hits.map((h) => h.connector_slug)).toEqual(["docs-mail", "docs-crm"]);
    expect(data.connectors_searched.sort()).toEqual(["docs-crm", "docs-mail"]);
  });

  test("an explicit slug narrows the search to that connector", async () => {
    const searched = stubSearch();
    const result = await fetchConnectorDocsTool.execute(makeCtx(null), {
      query: "deals",
      connector: "docs-crm",
    });
    expect(result.ok).toBe(true);
    expect(searched).toEqual([crmId]);
  });

  test("nothing in scope returns connector_scope_required with the resolvable slugs", async () => {
    const searched = stubSearch();
    const result = await fetchConnectorDocsTool.execute(makeCtx(null), { query: "deals" });
    expect(result.ok).toBe(false);
    const data = result.data as {
      error_code: string;
      resolvable_connectors: string[];
      next_best_actions: string[];
    };
    expect(data.error_code).toBe("connector_scope_required");
    expect(data.resolvable_connectors).toEqual(["docs-crm", "docs-mail"]);
    expect(data.next_best_actions).toContain("find_connector");
    expect(normalizeToolResultPayload(result)).toMatchObject({
      error_code: "connector_scope_required",
      message: expect.stringContaining("no connector in scope"),
      next_best_actions: ["list_connectors", "find_connector", "fetch_connector_docs"],
    });
    expect(searched).toEqual([]);
  });
});
