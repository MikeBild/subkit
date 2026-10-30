import { describe, expect, test } from "bun:test";
import type { PackageApplyResult, PackagePlan, PackagePlanItem } from "@/api/packages";
import {
  actionTone,
  canApplyPlan,
  failedItems,
  installSource,
  nextSteps,
  type PackageExportPrefill,
  packageCategories,
  packageMenuItems,
  packagePermissions,
  planFromConflict,
  planHint,
  requirementCounts,
  sortedPlanItems,
  summaryEntries,
} from "@/pages/settings-packages-model";

const item = (overrides: Partial<PackagePlanItem>): PackagePlanItem => ({
  kind: "workflow",
  key: "daily-report",
  action: "create",
  local_id: null,
  ...overrides,
});

const plan = (items: PackagePlanItem[]): PackagePlan => {
  const summary = { create: 0, update: 0, unchanged: 0, conflict: 0 };
  for (const entry of items) summary[entry.action] += 1;
  return {
    package_id: "tenant-export:acme",
    package_version: "3f2a9c1b7d40e8a2",
    content_digest: "a".repeat(64),
    plan_digest: "b".repeat(64),
    items,
    requires: [],
    summary,
  };
};

describe("package permissions", () => {
  test("reads export and import separately", () => {
    expect(packagePermissions(["package:export"])).toEqual({ canExport: true, canImport: false });
    expect(packagePermissions(["package:import"])).toEqual({ canExport: false, canImport: true });
    expect(packagePermissions(["settings:read"])).toEqual({ canExport: false, canImport: false });
  });
});

describe("plan hints", () => {
  test("names the conflict reason before the landing state", () => {
    for (const reason of [
      "exists_unmanaged",
      "local_changes",
      "reserved",
      "manual_update_required",
      "knowledge_changed",
    ] as const) {
      expect(planHint(item({ action: "conflict", reason }))).toEqual({
        key: `settings.packages.reason.${reason}`,
      });
    }
  });

  test("lists missing dependencies", () => {
    expect(
      planHint(
        item({
          action: "conflict",
          reason: "missing_dependency",
          missing: ["connector:github@prod", "workflow:helper"],
        }),
      ),
    ).toEqual({
      key: "settings.packages.reason.missing_dependency",
      values: { missing: "connector:github@prod, workflow:helper" },
    });
  });

  test("tells where new entries land", () => {
    expect(planHint(item({ kind: "workflow" }))?.key).toBe("settings.packages.landing.workflow");
    expect(planHint(item({ kind: "schedule" }))?.key).toBe("settings.packages.landing.schedule");
    expect(planHint(item({ kind: "skill", action: "update" }))?.key).toBe(
      "settings.packages.landing.skill",
    );
    expect(planHint(item({ kind: "knowledge" }))?.key).toBe("settings.packages.landing.knowledge");
    expect(planHint(item({ kind: "connector" }))?.key).toBe("settings.packages.landing.connector");
    expect(planHint(item({ kind: "file", action: "unchanged" }))?.key).toBe(
      "settings.packages.landing.unchanged",
    );
    expect(planHint(item({ kind: "connector_template" }))).toBeNull();
  });
});

describe("plan summary", () => {
  test("orders conflicts first and keeps only non-empty summary entries", () => {
    const value = plan([
      item({ key: "a", action: "unchanged" }),
      item({ key: "b", action: "conflict", reason: "local_changes" }),
      item({ key: "c", action: "create" }),
    ]);
    expect(sortedPlanItems(value).map((entry) => entry.key)).toEqual(["b", "c", "a"]);
    expect(summaryEntries(value.summary)).toEqual([
      { action: "create", count: 1 },
      { action: "unchanged", count: 1 },
      { action: "conflict", count: 1 },
    ]);
    expect(actionTone("create")).toBe("ok");
    expect(actionTone("conflict")).toBe("error");
  });

  test("applies only when something is created or updated", () => {
    expect(canApplyPlan(plan([item({ action: "create" })]))).toBe(true);
    expect(
      canApplyPlan(
        plan([item({ action: "unchanged" }), item({ action: "conflict", reason: "reserved" })]),
      ),
    ).toBe(false);
  });

  test("counts what the target still needs", () => {
    expect(
      requirementCounts([
        { kind: "credential", connector: "github@prod", fields: ["token"] },
        { kind: "credential", connector: "notion@prod", fields: ["token"] },
        { kind: "approval", workflow: "daily-report" },
        { kind: "knowledge_review", knowledge: "runbook" },
      ]),
    ).toEqual([
      { kind: "credential", count: 2 },
      { kind: "approval", count: 1 },
      { kind: "knowledge_review", count: 1 },
    ]);
  });

  test("takes the current plan from a changed-plan conflict", () => {
    const current = plan([item({})]);
    expect(planFromConflict({ plan: current })).toBe(current);
    expect(planFromConflict({ plan: { items: [] } })).toBeNull();
    expect(planFromConflict(null)).toBeNull();
  });
});

describe("import result", () => {
  const result: PackageApplyResult = {
    install_id: "11111111-1111-4111-8111-111111111111",
    plan_digest: "b".repeat(64),
    items: [
      { kind: "connector", key: "github@prod", action: "create", local_id: "c1" },
      { kind: "connector", key: "notion@prod", action: "unchanged", local_id: "c2" },
      {
        kind: "knowledge",
        key: "runbook",
        action: "create",
        local_id: null,
        review: {
          intake_item_id: "i1",
          proposal_id: "p1",
          path: "/cockpit/intake/i1?tab=review&proposal=p1",
        },
      },
      { kind: "skill", key: "release-checklist", action: "update", local_id: "s1" },
      { kind: "workflow", key: "daily-report", action: "create", local_id: "w1" },
      { kind: "workflow", key: "broken", action: "failed", local_id: null, errors: ["invalid"] },
      { kind: "schedule", key: "daily-report", action: "conflict", local_id: "x1" },
    ],
    requires: [
      { kind: "credential", connector: "github@prod", fields: ["token"] },
      { kind: "credential", connector: "notion@prod", fields: ["token"] },
    ],
    summary: { create: 3, update: 1, unchanged: 1, conflict: 1, failed: 1 },
  };

  test("lists next steps only for what landed", () => {
    const steps = nextSteps(result);
    expect(steps.map((step) => [step.id, step.count])).toEqual([
      ["credentials", 1],
      ["knowledge", 1],
      ["skills", 1],
      ["workflows", 1],
    ]);
    expect(steps.find((step) => step.id === "knowledge")?.href).toBe(
      "/cockpit/intake/i1?tab=review&proposal=p1",
    );
    expect(steps.find((step) => step.id === "credentials")?.href).toBe("/connectors");
  });

  test("names failed entries", () => {
    expect(failedItems(result)).toEqual(["broken"]);
  });

  test("shows the source instance without scheme", () => {
    expect(installSource({ instance: "https://subkit.example.test" })).toBe("subkit.example.test");
    expect(installSource({ instance: null, tenant_slug: "acme" })).toBe("acme");
    expect(installSource({})).toBeNull();
  });
});

describe("package menu entries", () => {
  const t = (key: string) => key;
  const build = (permissions: string[], category: string | undefined) => {
    const exported: PackageExportPrefill[] = [];
    let imported = 0;
    const items = packageMenuItems({
      permissions,
      kind: "skill",
      category,
      t,
      onExport: (prefill) => exported.push(prefill),
      onImport: () => {
        imported += 1;
      },
    });
    return { items, exported, imported: () => imported };
  };

  test("offers export and import only with the matching permission", () => {
    expect(build([], undefined).items).toEqual([]);
    expect(build(["package:export"], undefined).items.map((item) => item.testId)).toEqual([
      "skill-package-export",
    ]);
    expect(build(["package:import"], undefined).items.map((item) => item.testId)).toEqual([
      "skill-package-import",
    ]);
    const both = build(["package:export", "package:import"], undefined).items;
    expect(both.map((item) => item.label)).toEqual([
      "packages.menu.export",
      "packages.menu.import",
    ]);
    expect(new Set(both.map((item) => item.label)).size).toBe(both.length);
  });

  test("prefills the kind and the active category", () => {
    const menu = build(["package:export", "package:import"], "crm");
    menu.items[0]?.onSelect?.();
    menu.items[1]?.onSelect?.();
    expect(menu.exported).toEqual([{ kinds: ["skill"], categories: ["crm"] }]);
    expect(menu.imported()).toBe(1);
  });

  test("exports every category without an active filter", () => {
    const menu = build(["package:export"], undefined);
    menu.items[0]?.onSelect?.();
    expect(menu.exported).toEqual([{ kinds: ["skill"], categories: [] }]);
  });

  test("does not narrow the export to other or platform", () => {
    expect(packageCategories(["other", "platform", "crm", "crm", ""])).toEqual(["crm"]);
    const menu = build(["package:export"], "other");
    menu.items[0]?.onSelect?.();
    expect(menu.exported).toEqual([{ kinds: ["skill"], categories: [] }]);
  });
});
