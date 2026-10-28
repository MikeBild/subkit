import { describe, expect, test } from "bun:test";
import { EngineError } from "@cli-core/errors.ts";
import {
  parseKinds,
  planChangedPlan,
  renderApplyResult,
  renderPackagePlan,
} from "../../commands/packages.ts";
import { EngineClient, type PackageApplyResult, type PackagePlan } from "../../engine-client.ts";

const DIGEST = "a".repeat(64);

function plan(overrides: Partial<PackagePlan> = {}): PackagePlan {
  return {
    package_id: "tenant-export:acme",
    package_version: "0123456789abcdef",
    content_digest: DIGEST,
    plan_digest: "b".repeat(64),
    items: [
      { kind: "workflow", key: "daily-report", action: "create", local_id: null },
      {
        kind: "skill",
        key: "tone",
        action: "conflict",
        reason: "local_changes",
        local_id: "00000000-0000-0000-0000-000000000001",
      },
      {
        kind: "schedule",
        key: "daily-report",
        action: "conflict",
        reason: "missing_dependency",
        missing: ["workflow:daily-report"],
        local_id: null,
      },
    ],
    requires: [
      { kind: "credential", connector: "crm@prod", fields: ["api_key"] },
      { kind: "approval", workflow: "daily-report" },
      { kind: "schedule_resume", workflow: "daily-report" },
      { kind: "knowledge_review", knowledge: "handbook" },
    ],
    summary: { create: 1, update: 0, unchanged: 0, conflict: 2 },
    ...overrides,
  };
}

describe("parseKinds", () => {
  test("accepts comma-separated kinds and hyphenated spellings", () => {
    expect(parseKinds("workflow, connector-template,workflow")).toEqual([
      "workflow",
      "connector_template",
    ]);
  });

  test("returns undefined without a filter", () => {
    expect(parseKinds(undefined)).toBeUndefined();
  });

  test("rejects unknown kinds", () => {
    expect(() => parseKinds("workflow,credential")).toThrow("unknown kind: credential");
  });
});

describe("renderPackagePlan", () => {
  test("lists every item with its action, reasons, summary and follow-up steps", () => {
    const out = renderPackagePlan(plan());
    expect(out).toContain("Package tenant-export:acme 0123456789abcdef");
    expect(out).toContain("create\tworkflow\tdaily-report\t");
    expect(out).toContain("conflict\tskill\ttone\tlocal_changes");
    expect(out).toContain("missing_dependency; missing workflow:daily-report");
    expect(out).toContain("create 1 · update 0 · unchanged 0 · conflict 2");
    expect(out).toContain("Conflicting items are skipped");
    expect(out).toContain("enter credentials for connector crm@prod (api_key)");
    expect(out).toContain("review and approve workflow daily-report");
    expect(out).toContain("resume the schedule of workflow daily-report");
    expect(out).toContain("confirm knowledge handbook in the Cockpit review");
  });

  test("shows an empty package without a table", () => {
    const out = renderPackagePlan(
      plan({
        items: [],
        requires: [],
        summary: { create: 0, update: 0, unchanged: 0, conflict: 0 },
      }),
    );
    expect(out).toContain("(no items)");
    expect(out).not.toContain("Afterwards");
  });
});

describe("renderApplyResult", () => {
  test("names the install, failures and absolute review links", () => {
    const result: PackageApplyResult = {
      install_id: "00000000-0000-0000-0000-0000000000aa",
      plan_digest: "b".repeat(64),
      items: [
        { kind: "workflow", key: "daily-report", action: "create", local_id: "x" },
        {
          kind: "connector",
          key: "crm@prod",
          action: "failed",
          local_id: null,
          errors: ["template missing"],
        },
        {
          kind: "knowledge",
          key: "handbook",
          action: "create",
          local_id: null,
          review: {
            intake_item_id: "i1",
            proposal_id: "p1",
            path: "/cockpit/intake/i1?tab=review",
          },
        },
      ],
      requires: [],
      summary: { create: 2, update: 0, unchanged: 0, conflict: 0, failed: 1 },
    };
    const out = renderApplyResult(result, "https://engine.example/");
    expect(out).toContain("Imported as install 00000000-0000-0000-0000-0000000000aa");
    expect(out).toContain("connector crm@prod: template missing");
    expect(out).toContain("handbook: https://engine.example/cockpit/intake/i1?tab=review");
  });
});

describe("planChangedPlan", () => {
  test("extracts the current plan from a 409 package_plan_changed envelope", () => {
    const current = plan();
    const err = new EngineError(409, {
      code: "package_plan_changed",
      message: "the import plan changed since preview",
      details: { plan: current },
    });
    expect(planChangedPlan(err)).toEqual(current);
  });

  test("ignores other errors", () => {
    expect(planChangedPlan(new EngineError(409, { code: "conflict", message: "x" }))).toBeNull();
    expect(planChangedPlan(new Error("boom"))).toBeNull();
  });
});

describe("package client", () => {
  test("downloads the archive with auth and returns the checksum header", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      tenant: "t1",
      fetchImpl: async (input, init) => {
        seen.push({ url: String(input), headers: init?.headers as Record<string, string> });
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/zip", "x-subkit-sha256": DIGEST },
        });
      },
    });
    const out = await client.downloadPackageArchive("fid_00000000-0000-0000-0000-000000000001");
    expect([...out.bytes]).toEqual([1, 2, 3]);
    expect(out.sha256).toBe(DIGEST);
    expect(seen[0]?.url).toBe(
      "http://engine.local/v1/packages/archives/fid_00000000-0000-0000-0000-000000000001",
    );
    expect(seen[0]?.headers.authorization).toBe("Bearer wf_live_test");
    expect(seen[0]?.headers["x-subkit-tenant"]).toBe("t1");
  });

  test("uploads the archive as multipart field archive", async () => {
    let body: FormData | null = null;
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      fetchImpl: async (_input, init) => {
        body = init?.body as FormData;
        return new Response(
          JSON.stringify({
            archive_file_id: "fid_00000000-0000-0000-0000-000000000002",
            plan: plan(),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const res = await client.previewPackageUpload({
      name: "acme.zip",
      bytes: new Uint8Array([9]),
    });
    expect(res.archive_file_id).toBe("fid_00000000-0000-0000-0000-000000000002");
    const archive = (body as FormData | null)?.get("archive");
    expect(archive instanceof File && archive.name).toBe("acme.zip");
  });
});
