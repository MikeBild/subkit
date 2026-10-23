import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog, discoveryArtifacts } from "../../db/schema/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let runId: string;

beforeAll(async () => {
  ctx = await createJourneyCtx("discovery-api");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey: discovery API lifecycle", () => {
  test("AC1: create discovery run via multipart", async () => {
    const form = new FormData();
    form.append(
      "files",
      new Blob(['{"openapi":"3.0.0","info":{"title":"Widgets API","version":"1.0"}}'], {
        type: "application/json",
      }),
      "spec.json",
    );
    form.append(
      "files",
      new Blob(["# Compliance Policy\n\nAll payments must include an Idempotency-Key header."], {
        type: "text/markdown",
      }),
      "compliance.md",
    );
    form.append("label", "Journey test");

    const res = await fetch(`${ctx.baseUrl}/v1/discovery/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      body: form,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; file_count: number; status: string };
    expect(body.file_count).toBe(2);
    expect(body.status).toBe("pending");
    runId = body.id;
  });

  test("AC2: get run shows status", async () => {
    const res = await journeyFetch(ctx, `/v1/discovery/runs/${runId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; label: string };
    expect(body.id).toBe(runId);
    expect(body.label).toBe("Journey test");
  });

  test("AC3: list runs includes this one", async () => {
    const res = await journeyFetch(ctx, "/v1/discovery/runs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.find((r) => r.id === runId)).toBeDefined();
  });

  test("AC4: seed + approve an artifact", async () => {
    const [artifact] = await ctx.db
      .insert(discoveryArtifacts)
      .values({
        tenant_id: ctx.tenantId,
        run_id: runId,
        kind: "connector",
        title: "Widgets API",
        description: "REST connector for Widgets",
        draft: { name: "Widgets", driver: "http", base_url: "https://api.widgets.test" },
        evidence: {
          file_ids: [],
          excerpts: [{ file_id: "", filename: "spec.json", text: "openapi 3.0" }],
        },
        confidence: 90,
      })
      .returning();

    const res = await journeyFetch(ctx, `/v1/discovery/artifacts/${artifact!.id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approved: boolean };
    expect(body.approved).toBe(true);

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.resource_id, artifact!.id));
    expect(audits.some((a) => a.action === "discovery.artifact_approved")).toBe(true);
  });

  test("AC5: seed + reject an artifact with reason", async () => {
    const [artifact] = await ctx.db
      .insert(discoveryArtifacts)
      .values({
        tenant_id: ctx.tenantId,
        run_id: runId,
        kind: "skill",
        title: "Idempotency Rule",
        draft: { scope: "global", title: "Idempotency", body: "Always include header" },
        evidence: { file_ids: [], excerpts: [] },
        confidence: 70,
      })
      .returning();

    const res = await journeyFetch(ctx, `/v1/discovery/artifacts/${artifact!.id}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason: "Already covered by existing skill" }),
    });
    expect(res.status).toBe(200);

    const getRes = await journeyFetch(ctx, `/v1/discovery/artifacts/${artifact!.id}`);
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { status: string; rejection_reason: string };
    expect(body.status).toBe("rejected");
    expect(body.rejection_reason).toBe("Already covered by existing skill");
  });

  test("AC6: list artifacts filters by kind and status", async () => {
    const res = await journeyFetch(
      ctx,
      `/v1/discovery/runs/${runId}/artifacts?kind=connector&status=approved`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ kind: string; status: string }> };
    for (const item of body.items) {
      expect(item.kind).toBe("connector");
      expect(item.status).toBe("approved");
    }
  });

  test("AC7: list capability gaps with state and resolve one", async () => {
    const [gap] = await ctx.db
      .insert(discoveryArtifacts)
      .values({
        tenant_id: ctx.tenantId,
        run_id: runId,
        kind: "capability_gap",
        title: "Switch authoring mode",
        draft: {
          requested: "Switch from connector to workflow authoring",
          missing_capability: "surface.authoring_mode_switch",
          suggested_kind: "unknown",
          fingerprint: "journey-gap",
          occurrences: 3,
          conversation_id: null,
        },
        evidence: { file_ids: [], excerpts: [] },
      })
      .returning();
    if (!gap) throw new Error("gap not seeded");

    const listRes = await journeyFetch(ctx, "/v1/discovery/capability-gaps?status=proposed");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      items: Array<{ id: string; state: string; occurrences: number }>;
    };
    const listed = list.items.find((item) => item.id === gap.id);
    expect(listed?.state).toBe("open");
    expect(listed?.occurrences).toBe(3);

    const empty = await journeyFetch(ctx, `/v1/discovery/capability-gaps/${gap.id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ note: "  " }),
    });
    expect(empty.status).toBe(400);

    const res = await journeyFetch(ctx, `/v1/discovery/capability-gaps/${gap.id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ note: "Mode switch shipped." }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      state: string;
      resolution: { note: string } | null;
    };
    expect(body.status).toBe("superseded");
    expect(body.state).toBe("resolved");
    expect(body.resolution?.note).toBe("Mode switch shipped.");

    const again = await journeyFetch(ctx, `/v1/discovery/capability-gaps/${gap.id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ note: "again" }),
    });
    expect(again.status).toBe(404);

    const audits = await ctx.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.resource_id, gap.id));
    expect(audits.map((a) => a.action)).toContain("discovery.artifact_superseded");
  });
});
