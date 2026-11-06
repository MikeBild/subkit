import { describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { AuditAction } from "../audit/types.ts";
import { auditLog } from "../db/schema/audit.ts";
import { executions, workflows, workflowVersions } from "../db/schema/index.ts";
import { EngineClient } from "../engine-client/index.ts";
import { getMockProvider } from "../llm/mock-provider.ts";
import {
  loadSnapshotCoverage,
  loadTenantSummary,
  renderTenantSummaryBlock,
} from "../llm/runtime/tenant-summary.ts";
import { matchCategoryListIntent, matchListIntent, tryFastPath } from "./fast-path.ts";
import {
  conversationId,
  makeParams,
  makePrincipal,
  remote,
  seedMinimalWorkflow,
  tdb,
  tenantId,
  useFastPathSetup,
} from "./fast-path-fixtures.ts";
import { loadEnumerationCoverage } from "./loop/enumeration-coverage.ts";
import { listWorkflowsTool } from "./tools/engine-api/workflows.ts";
import type { ToolContext } from "./tools/index.ts";
import type { TurnEvent } from "./types.ts";

useFastPathSetup();

function findToolResultOutput(events: TurnEvent[] | undefined): Record<string, unknown> {
  const tr = events?.find((e) => e.type === "tool_result") as
    | { output?: Record<string, unknown> }
    | undefined;
  return tr?.output ?? {};
}

describe("tryFastPath — ground-truth cardinality on list surfaces", () => {
  test("25 workflows: fast path enumerates completely and names the exact total", async () => {
    const slugs: string[] = [];
    for (let i = 0; i < 25; i++) {
      const slug = `bulk-wf-${String(i).padStart(2, "0")}`;
      slugs.push(slug);
      await seedMinimalWorkflow(slug);
    }
    const result = await tryFastPath(makeParams("list my workflows"));
    expect(result).not.toBeNull();
    expect(result?.fast_path_tool).toBe("list_workflows");
    expect(result?.assistant_text?.startsWith("25 workflows:")).toBe(true);
    for (const slug of slugs) {
      expect(result?.assistant_text).toContain(slug);
    }
    const output = findToolResultOutput(result?.events);
    expect(output.total).toBe(25);
    expect(output.returned).toBe(25);
    expect(output.has_more).toBe(false);
    expect(Array.isArray(output.items)).toBe(true);
    expect((output.items as unknown[]).length).toBe(25);
    expect(getMockProvider().calls.length).toBe(0);
  });

  test("list_workflows conversation tool returns the complete set + exact total for 25 workflows", async () => {
    for (let i = 0; i < 25; i++) {
      await seedMinimalWorkflow(`tool-wf-${String(i).padStart(2, "0")}`);
    }
    const engineClient = new EngineClient({ tenant_id: tenantId, actor_id: null, db: tdb.db });
    const ctx = { engineClient, db: tdb.db, tenant_id: tenantId } as unknown as ToolContext;
    const result = await listWorkflowsTool.execute(ctx, {});
    expect(result.ok).toBe(true);
    const data = result.data as {
      items: Array<{ slug: string }>;
      total: number;
      returned: number;
      offset: number;
      has_more: boolean;
    };
    expect(data.total).toBe(25);
    expect(data.returned).toBe(25);
    expect(data.offset).toBe(0);
    expect(data.has_more).toBe(false);
    expect(data.items).toHaveLength(25);

    const page = await listWorkflowsTool.execute(ctx, { limit: 10 });
    const pageData = page.data as { items: unknown[]; total: number; has_more: boolean };
    expect(pageData.items).toHaveLength(10);
    expect(pageData.total).toBe(25);
    expect(pageData.has_more).toBe(true);
  });

  test("executions list pages but renders the true total ('Showing latest 10 of 12')", async () => {
    await tdb.db.insert(executions).values(
      Array.from({ length: 12 }, () => ({
        tenant_id: tenantId,
        status: "succeeded" as const,
        request_source: "api",
        execution_mode: "dev" as const,
        source_kind: "saved",
      })),
    );
    try {
      const result = await tryFastPath(makeParams("list executions"));
      expect(result).not.toBeNull();
      expect(result?.assistant_text?.startsWith("Showing latest 10 of 12 executions")).toBe(true);
      const output = findToolResultOutput(result?.events);
      expect(output.total).toBe(12);
      expect(output.returned).toBe(10);
      expect(output.has_more).toBe(true);
    } finally {
      await tdb.db.delete(executions).where(eq(executions.tenant_id, tenantId));
    }
  });

  test("fewer executions than the page size render the exact total without a paging hint", async () => {
    await tdb.db.insert(executions).values([
      {
        tenant_id: tenantId,
        status: "succeeded" as const,
        request_source: "api",
        execution_mode: "dev" as const,
        source_kind: "saved",
      },
    ]);
    try {
      const result = await tryFastPath(makeParams("list executions"));
      expect(result?.assistant_text?.startsWith("1 execution:")).toBe(true);
      const output = findToolResultOutput(result?.events);
      expect(output.total).toBe(1);
      expect(output.has_more).toBe(false);
    } finally {
      await tdb.db.delete(executions).where(eq(executions.tenant_id, tenantId));
    }
  });
});

describe("matchCategoryListIntent", () => {
  test.each([
    ["Zeig mir die notion-Workflows und was sie tun", "notion"],
    ["zeige mir alle notion workflows", "notion"],
    ["Zeig mir die Workflows in @kategorie/notion", "notion"],
    ["Workflows in @kategorie/notion", "notion"],
    ["die workflows in notion?", "notion"],
    ["show me the notion workflows", "notion"],
    ["show the notion workflows and what they do", "notion"],
    ["workflows in @category/notion", "notion"],
    ["list workflows in the category radar", "radar"],
    ["Zeig mir die mission-control-Workflows", "mission-control"],
  ])("%s → %s", (text, category) => {
    expect(matchCategoryListIntent(text)).toBe(category);
  });

  test.each([
    "was machen die notion workflows mit meinen Daten?",
    "run notion-sync",
    "show me the notion workflows that failed yesterday",
  ])("%s → no category intent", (text) => {
    expect(matchCategoryListIntent(text)).toBeNull();
  });
});

async function workflowIdBySlug(slug: string): Promise<string> {
  const [row] = await tdb.db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, tenantId), eq(workflows.slug, slug)));
  if (!row) throw new Error(`no workflow ${slug}`);
  return row.id;
}

async function seedCategoryCatalog(): Promise<{ notion: string[] }> {
  for (let i = 0; i < 41; i++)
    await seedMinimalWorkflow(`aa-filler-${String(i).padStart(2, "0")}`, "aa-filler");
  const notion = ["notion-archive", "notion-digest", "notion-search", "notion-sync"];
  for (const slug of notion) await seedMinimalWorkflow(slug, "notion");
  await tdb.db
    .update(workflows)
    .set({ description: "Copies new Notion pages\ninto the archive." })
    .where(eq(workflows.id, await workflowIdBySlug("notion-archive")));
  await tdb.db
    .update(workflows)
    .set({ description: "Mails a weekly digest of edited pages." })
    .where(eq(workflows.id, await workflowIdBySlug("notion-digest")));
  await tdb.db
    .update(workflowVersions)
    .set({
      dag: {
        name: "notion-sync",
        slug: "notion-sync",
        description: "Stale text a definition once carried.",
        steps: [{ id: "s1", kind: "request", method: "GET", url: remote.baseUrl }],
      },
    })
    .where(eq(workflowVersions.workflow_id, await workflowIdBySlug("notion-sync")));
  const gone = await seedMinimalWorkflow("notion-retired", "notion");
  await tdb.db
    .update(workflows)
    .set({ deleted_at: new Date(0) })
    .where(eq(workflows.id, gone.id));
  return { notion };
}

describe("tryFastPath — one catalog block", () => {
  test("the chip phrasing lists every member with what it does, without the LLM", async () => {
    const { notion } = await seedCategoryCatalog();
    const result = await tryFastPath(makeParams("Zeig mir die notion-Workflows und was sie tun"));
    expect(result).not.toBeNull();
    expect(result?.fast_path_tool).toBe("list_workflows");
    const text = result?.assistant_text ?? "";
    expect(text.startsWith("4 Workflows in **notion**:")).toBe(true);
    for (const slug of notion) expect(text).toContain(`- ${slug} (aktiv)`);
    expect(text).not.toContain("(active)");
    expect(text).not.toContain("notion-retired");
    expect(text).not.toContain("aa-filler");
    expect(text).toContain("- notion-archive (aktiv) — Copies new Notion pages into the archive.");
    expect(text).toContain("- notion-digest (aktiv) — Mails a weekly digest of edited pages.");
    expect(text).toContain("- notion-search (aktiv)\n");
    expect(text).not.toContain("Stale text a definition once carried.");
    const output = findToolResultOutput(result?.events);
    expect(output.category).toBe("notion");
    expect(output.total).toBe(4);
    expect(getMockProvider().calls.length).toBe(0);
  });

  test("asked in English, answered in English; a name that differs from the slug is shown", async () => {
    await seedCategoryCatalog();
    await tdb.db
      .update(workflows)
      .set({ name: "Notion full-text search", description: null })
      .where(eq(workflows.id, await workflowIdBySlug("notion-search")));
    const text =
      (await tryFastPath(makeParams("show me the notion workflows")))?.assistant_text ?? "";
    expect(text.startsWith("4 workflows in **notion**:")).toBe(true);
    expect(text).toContain("- notion-archive (active) — Copies new Notion pages into the archive.");
    expect(text).toContain("- notion-search (active) — Notion full-text search");
    expect(text).not.toContain("(aktiv)");
  });

  test("the count equals the category size list_workflows reports, on every phrasing", async () => {
    await seedCategoryCatalog();
    const engineClient = new EngineClient({ tenant_id: tenantId, actor_id: null, db: tdb.db });
    const ctx = { engineClient, db: tdb.db, tenant_id: tenantId } as unknown as ToolContext;
    const listed = await listWorkflowsTool.execute(ctx, { category: "notion" });
    const listedSlugs = (listed.data as { items: Array<{ slug: string }> }).items
      .map((i) => i.slug)
      .sort();
    expect(listedSlugs).toHaveLength(4);
    for (const phrase of [
      "Zeig mir die Workflows in @kategorie/notion",
      "show me the notion workflows",
      "workflows in @category/notion",
    ]) {
      const result = await tryFastPath(makeParams(phrase));
      const items = findToolResultOutput(result?.events).items as Array<{ slug: string }>;
      expect(items.map((i) => i.slug).sort()).toEqual(listedSlugs);
    }
  });

  test("every category the chip row shows answers with exactly its members", async () => {
    await seedCategoryCatalog();
    for (const slug of ["radar-collect", "radar-normalize", "radar-publish"])
      await seedMinimalWorkflow(slug, "radar");
    const rows = await tdb.db
      .select({ slug: workflows.slug, category: workflows.category })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenantId), isNull(workflows.deleted_at)));
    const members = new Map<string, string[]>();
    for (const { slug, category } of rows)
      members.set(category, [...(members.get(category) ?? []), slug]);
    const categories = [...members.keys()];
    expect(categories.length).toBeGreaterThanOrEqual(3);
    for (const category of categories) {
      const result = await tryFastPath(
        makeParams(`Zeig mir die Workflows in @kategorie/${category}`),
      );
      expect(result, `no answer for ${category}`).not.toBeNull();
      const output = findToolResultOutput(result?.events);
      const items = (output.items as Array<{ slug: string }>).map((i) => i.slug).sort();
      expect(items, category).toEqual((members.get(category) ?? []).sort());
      expect(output.total, category).toBe(members.get(category)?.length);
    }
  });

  test("the LLM path's snapshot names the block past the row cap and admits it is partial", async () => {
    await seedCategoryCatalog();
    const summary = await loadTenantSummary(makePrincipal(), tdb.db);
    expect(summary.workflows.some((w) => w.slug.startsWith("notion-"))).toBe(false);
    const text = renderTenantSummaryBlock(summary, new Set()) ?? "";
    expect(text).toContain("notion (4)");
    expect(text).toContain("PARTIAL LIVE LIST");
    expect(text).not.toContain("DO NOT call list_workflows");
    expect(await loadSnapshotCoverage(makePrincipal(), tdb.db)).toEqual({
      workflows_complete: false,
      connectors_complete: true,
    });
  });

  test("an unknown category falls through to the LLM", async () => {
    await seedCategoryCatalog();
    expect(await tryFastPath(makeParams("Zeig mir die jira-Workflows"))).toBeNull();
    expect(await tryFastPath(makeParams("workflows in @kategorie/jira"))).toBeNull();
  });

  test("the plain list phrasing still lists the whole catalog", async () => {
    await seedCategoryCatalog();
    const result = await tryFastPath(makeParams("zeige alle workflows"));
    expect(result?.assistant_text?.startsWith("45 workflows:")).toBe(true);
    expect(findToolResultOutput(result?.events).category).toBeUndefined();
  });

  test("a word that is no category falls through without a denial or an audit row", async () => {
    await seedCategoryCatalog();
    const restricted = makePrincipal({
      provider: "portal_token",
      roles: ["portal_token_user"],
      allowed_workflows: ["00000000-0000-0000-0000-000000000099"],
    });
    const deniedListReads = async () =>
      (
        await tdb.db
          .select()
          .from(auditLog)
          .where(
            and(eq(auditLog.action, AuditAction.POLICY_DENIED), eq(auditLog.tenant_id, tenantId)),
          )
      ).filter((row) => (row.metadata as Record<string, unknown>)?.tool === "list_workflows")
        .length;
    const before = await deniedListReads();
    for (const [text, word] of [
      ["show me the failed workflows", "failed"],
      ["zeig mir die aktiven workflows", "aktiven"],
    ] as const) {
      expect(matchListIntent(text), text).toBeNull();
      expect(matchCategoryListIntent(text), text).toBe(word);
      expect(await tryFastPath({ ...makeParams(text), principal: restricted }), text).toBeNull();
    }
    expect(await deniedListReads()).toBe(before);
  });

  test("the enumeration steering sees a named workflow and a trimmed catalog", async () => {
    await seedCategoryCatalog();
    expect(
      await loadEnumerationCoverage(makePrincipal(), "wie viele Schritte hat notion-sync?", tdb.db),
    ).toEqual({
      workflows_complete: false,
      connectors_complete: true,
      names_existing_workflow: true,
    });
    expect(
      (await loadEnumerationCoverage(makePrincipal(), "Zeig mir die notion-Workflows", tdb.db))
        .names_existing_workflow,
    ).toBe(false);
    expect(
      (await loadEnumerationCoverage(makePrincipal(), "workflow notion-retired", tdb.db))
        .names_existing_workflow,
    ).toBe(false);
  });

  test("a principal without workflow:read is denied and audited", async () => {
    await seedCategoryCatalog();
    const restricted = makePrincipal({
      provider: "portal_token",
      kind: "system_account",
      roles: ["portal_token_user"],
      allowed_workflows: ["00000000-0000-0000-0000-000000000099"],
    });
    const result = await tryFastPath({
      ...makeParams("Zeig mir die notion-Workflows"),
      principal: restricted,
    });
    expect(result?.assistant_text).toBe("Permission denied: workflow:read.");
    const audit = await tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, AuditAction.POLICY_DENIED), eq(auditLog.tenant_id, tenantId)));
    const denied = audit.find(
      (row) =>
        row.resource_id === conversationId &&
        row.actor_id === restricted.id &&
        (row.metadata as Record<string, unknown>)?.permission === "workflow:read" &&
        (row.metadata as Record<string, unknown>)?.tool === "list_workflows",
    );
    expect(denied).toMatchObject({ actor_type: "system_account", actor_id: restricted.id });
  });
});
