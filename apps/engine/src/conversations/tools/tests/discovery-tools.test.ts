// Discovery tool tests. Seeds a run + artifact(s) directly via drizzle,
// then drives the three conversation tools and asserts their output
// shape and status transitions.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { discoveryArtifacts, discoveryRuns, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import {
  approveDiscoveryArtifactTool,
  getDiscoveryArtifactTool,
  listDiscoveryArtifactsTool,
} from "../generated/discovery.ts";
import type { ToolContext } from "../index.ts";

const TEST_NOW_MS = getTestNow();

let ctx: TestDb;
let tenant_id: string;
let run_id: string;

beforeAll(async () => {
  ctx = await createTestDb("discovery_tools");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-disc-tools", display_name: "T" })
    .returning();
  tenant_id = t!.id;
  const [r] = await ctx.db
    .insert(discoveryRuns)
    .values({
      tenant_id,
      status: "completed",
      started_at: new Date(TEST_NOW_MS),
      completed_at: new Date(TEST_NOW_MS),
    })
    .returning();
  run_id = r!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedArtifact(
  kind: "connector" | "skill" | "knowledge_source",
  status: "proposed" | "approved" = "proposed",
): Promise<string> {
  const [a] = await ctx.db
    .insert(discoveryArtifacts)
    .values({
      tenant_id,
      run_id,
      kind,
      status,
      title: `${kind}-${Math.random().toString(36).slice(2, 6)}`, // allow-random: legacy; review before changing
      confidence: 85,
      draft: { slug: "draft-slug" },
      evidence: { file_ids: [], excerpts: [] },
    })
    .returning();
  return a!.id;
}

function makeCtx(): ToolContext {
  return {
    db: ctx.db,
    tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: legacy; review before changing
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

describe("list_discovery_artifacts", () => {
  test("returns artifacts for a given run, filtered by status", async () => {
    const a = await seedArtifact("connector", "proposed");
    const b = await seedArtifact("skill", "proposed");
    const c = await seedArtifact("knowledge_source", "approved");
    const toolCtx = makeCtx();
    const r = await listDiscoveryArtifactsTool.execute(toolCtx, {
      run_id,
      status: "proposed",
      limit: 50,
      offset: 0,
    });
    expect(r.ok).toBe(true);
    const ids = (r.data as { artifacts: Array<{ id: string; status: string }> }).artifacts.map(
      (x) => x.id,
    );
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    expect(ids).not.toContain(c);
  });

  test("respects the kind filter", async () => {
    const toolCtx = makeCtx();
    const r = await listDiscoveryArtifactsTool.execute(toolCtx, {
      run_id,
      kind: "connector",
      limit: 50,
      offset: 0,
    });
    expect(r.ok).toBe(true);
    const kinds = (r.data as { artifacts: Array<{ kind: string }> }).artifacts.map((x) => x.kind);
    for (const k of kinds) expect(k).toBe("connector");
  });
});

describe("get_discovery_artifact", () => {
  test("returns the full artifact row for a valid id", async () => {
    const id = await seedArtifact("connector");
    const r = await getDiscoveryArtifactTool.execute(makeCtx(), { id });
    expect(r.ok).toBe(true);
    const artifact = (r.data as { artifact: { id: string; draft: unknown } }).artifact;
    expect(artifact.id).toBe(id);
    expect(artifact.draft).toEqual({ slug: "draft-slug" });
  });

  test("unknown id → artifact_not_found", async () => {
    const r = await getDiscoveryArtifactTool.execute(makeCtx(), {
      id: "00000000-0000-0000-0000-000000000000",
    });
    expect(r.ok).toBe(false);
    expect((r.data as { error: { code: string } }).error.code).toBe("artifact_not_found");
  });
});

describe("approve_discovery_artifact", () => {
  test("flips status from proposed → approved and returns persistence:saved", async () => {
    const id = await seedArtifact("connector", "proposed");
    const r = await approveDiscoveryArtifactTool.execute(makeCtx(), { id });
    expect(r.ok).toBe(true);
    const data = r.data as { persistence: string; resource_id: string };
    expect(data.persistence).toBe("saved");
    expect(data.resource_id).toBe(id);
    // Row now in approved status
    const [row] = await ctx.db
      .select()
      .from(discoveryArtifacts)
      .where(eq(discoveryArtifacts.id, id))
      .limit(1);
    expect(row!.status).toBe("approved");
  });

  test("approving an already-approved artifact → already_materialized", async () => {
    const id = await seedArtifact("connector", "approved");
    const r = await approveDiscoveryArtifactTool.execute(makeCtx(), { id });
    expect(r.ok).toBe(false);
    expect((r.data as { error: { code: string } }).error.code).toBe("already_materialized");
  });

  test("tenant isolation: approving another tenant's artifact fails", async () => {
    const [otherT] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-disc-other", display_name: "T2" })
      .returning();
    const [otherRun] = await ctx.db
      .insert(discoveryRuns)
      .values({ tenant_id: otherT!.id, status: "completed" })
      .returning();
    const [otherArt] = await ctx.db
      .insert(discoveryArtifacts)
      .values({
        tenant_id: otherT!.id,
        run_id: otherRun!.id,
        kind: "connector",
        title: "leak",
        draft: {},
        evidence: { file_ids: [], excerpts: [] },
      })
      .returning();
    // Our tenant tries to approve their artifact
    const r = await approveDiscoveryArtifactTool.execute(makeCtx(), {
      id: otherArt!.id,
    });
    expect(r.ok).toBe(false);
    expect((r.data as { error: { code: string } }).error.code).toBe("already_materialized");
    // Other tenant's row is untouched.
    const [preserved] = await ctx.db
      .select()
      .from(discoveryArtifacts)
      .where(
        and(eq(discoveryArtifacts.tenant_id, otherT!.id), eq(discoveryArtifacts.id, otherArt!.id)),
      )
      .limit(1);
    expect(preserved!.status).toBe("proposed");
  });
});
