import type {
  PackageAppliedAction,
  PackageApplyResult,
  PackageKind,
  PackagePlan,
  PackagePlanAction,
  PackagePlanItem,
  PackageRequirement,
} from "@/api/packages";
import { connectorsHref, workflowsHref } from "@/app/links";
import type { BadgeTone } from "@/components/cockpit/patterns";
import type { PluralKey, TranslationKey } from "@/lib/i18n";

export type PackagePermissions = { canExport: boolean; canImport: boolean };

export function packagePermissions(permissions: readonly string[]): PackagePermissions {
  return {
    canExport: permissions.includes("package:export"),
    canImport: permissions.includes("package:import"),
  };
}

export const KIND_LABEL: Record<PackageKind, TranslationKey> = {
  connector_template: "settings.packages.kind.connector_template",
  connector: "settings.packages.kind.connector",
  file: "settings.packages.kind.file",
  skill: "settings.packages.kind.skill",
  workflow: "settings.packages.kind.workflow",
  schedule: "settings.packages.kind.schedule",
  knowledge: "settings.packages.kind.knowledge",
};

export const KINDS_LABEL: Record<PackageKind, TranslationKey> = {
  connector_template: "settings.packages.kinds.connector_template",
  connector: "settings.packages.kinds.connector",
  file: "settings.packages.kinds.file",
  skill: "settings.packages.kinds.skill",
  workflow: "settings.packages.kinds.workflow",
  schedule: "settings.packages.kinds.schedule",
  knowledge: "settings.packages.kinds.knowledge",
};

export const ACTION_ORDER: readonly PackageAppliedAction[] = [
  "create",
  "update",
  "unchanged",
  "conflict",
  "failed",
];

export const ACTION_LABEL: Record<PackageAppliedAction, TranslationKey> = {
  create: "settings.packages.action.create",
  update: "settings.packages.action.update",
  unchanged: "settings.packages.action.unchanged",
  conflict: "settings.packages.action.conflict",
  failed: "settings.packages.action.failed",
};

const ACTION_TONE: Record<PackageAppliedAction, BadgeTone> = {
  create: "ok",
  update: "warn",
  unchanged: "neutral",
  conflict: "error",
  failed: "error",
};

export function actionTone(action: PackageAppliedAction): BadgeTone {
  return ACTION_TONE[action];
}

const LANDING: Partial<Record<PackageKind, TranslationKey>> = {
  workflow: "settings.packages.landing.workflow",
  schedule: "settings.packages.landing.schedule",
  skill: "settings.packages.landing.skill",
  knowledge: "settings.packages.landing.knowledge",
  connector: "settings.packages.landing.connector",
};

export interface PlanHint {
  key: TranslationKey;
  values?: Record<string, string>;
}

export function planHint(item: PackagePlanItem): PlanHint | null {
  if (item.action === "conflict") {
    switch (item.reason) {
      case "missing_dependency":
        return {
          key: "settings.packages.reason.missing_dependency",
          values: { missing: (item.missing ?? []).join(", ") },
        };
      case "exists_unmanaged":
        return { key: "settings.packages.reason.exists_unmanaged" };
      case "local_changes":
        return { key: "settings.packages.reason.local_changes" };
      case "reserved":
        return { key: "settings.packages.reason.reserved" };
      case "manual_update_required":
        return { key: "settings.packages.reason.manual_update_required" };
      case "knowledge_changed":
        return { key: "settings.packages.reason.knowledge_changed" };
      default:
        return null;
    }
  }
  if (item.action === "unchanged") return { key: "settings.packages.landing.unchanged" };
  const landing = LANDING[item.kind];
  return landing ? { key: landing } : null;
}

export function summaryEntries<A extends PackageAppliedAction>(
  summary: Partial<Record<A, unknown>>,
): { action: A; count: number }[] {
  return (ACTION_ORDER as readonly A[]).flatMap((action) => {
    const value = summary[action];
    return typeof value === "number" && value > 0 ? [{ action, count: value }] : [];
  });
}

export function canApplyPlan(plan: PackagePlan): boolean {
  return plan.summary.create + plan.summary.update > 0;
}

export function sortedPlanItems(plan: PackagePlan): PackagePlanItem[] {
  const rank: Record<PackagePlanAction, number> = {
    conflict: 0,
    create: 1,
    update: 2,
    unchanged: 3,
  };
  return [...plan.items].sort((a, b) => rank[a.action] - rank[b.action]);
}

export type RequirementKind = PackageRequirement["kind"];

export const REQUIREMENT_ORDER: readonly RequirementKind[] = [
  "credential",
  "approval",
  "schedule_resume",
  "knowledge_review",
];

export const REQUIREMENT_LABEL: Record<RequirementKind, PluralKey> = {
  credential: "settings.packages.requires.credential",
  approval: "settings.packages.requires.approval",
  schedule_resume: "settings.packages.requires.schedule",
  knowledge_review: "settings.packages.requires.knowledge",
};

export function requirementCounts(
  requires: readonly PackageRequirement[],
): { kind: RequirementKind; count: number }[] {
  const counts: Record<RequirementKind, number> = {
    credential: 0,
    approval: 0,
    schedule_resume: 0,
    knowledge_review: 0,
  };
  for (const requirement of requires) counts[requirement.kind] += 1;
  return REQUIREMENT_ORDER.filter((kind) => counts[kind] > 0).map((kind) => ({
    kind,
    count: counts[kind],
  }));
}

export interface NextStep {
  id: "credentials" | "knowledge" | "skills" | "workflows" | "schedules";
  label: PluralKey;
  count: number;
  open: TranslationKey;
  href: string;
  reviews?: { key: string; path: string }[];
}

function landed(result: PackageApplyResult, kind: PackageKind): number {
  return result.items.filter(
    (item) => item.kind === kind && (item.action === "create" || item.action === "update"),
  ).length;
}

export function nextSteps(result: PackageApplyResult): NextStep[] {
  const credentials = new Set(
    result.requires.flatMap((requirement) =>
      requirement.kind === "credential" ? [requirement.connector] : [],
    ),
  );
  const created = new Set(
    result.items
      .filter((item) => item.kind === "connector" && item.action === "create")
      .map((item) => item.key),
  );
  const credentialCount = [...credentials].filter((key) => created.has(key)).length;
  const reviews = result.items.flatMap((item) =>
    item.review ? [{ key: item.key, path: item.review.path }] : [],
  );
  const steps: NextStep[] = [
    {
      id: "credentials",
      label: "settings.packages.next.credentials",
      count: credentialCount,
      open: "settings.packages.next.openConnectors",
      href: connectorsHref(),
    },
    {
      id: "knowledge",
      label: "settings.packages.next.knowledge",
      count: reviews.length,
      open: "settings.packages.next.openIntake",
      href: reviews[0]?.path ?? "/intake",
      reviews,
    },
    {
      id: "skills",
      label: "settings.packages.next.skills",
      count: landed(result, "skill"),
      open: "settings.packages.next.openSkills",
      href: "/skills",
    },
    {
      id: "workflows",
      label: "settings.packages.next.workflows",
      count: landed(result, "workflow"),
      open: "settings.packages.next.openWorkflows",
      href: workflowsHref(),
    },
    {
      id: "schedules",
      label: "settings.packages.next.schedules",
      count: landed(result, "schedule"),
      open: "settings.packages.next.openWorkflows",
      href: workflowsHref(),
    },
  ];
  return steps.filter((step) => step.count > 0);
}

export function failedItems(result: PackageApplyResult): string[] {
  return result.items.filter((item) => item.action === "failed").map((item) => item.key);
}

export function planFromConflict(details: Record<string, unknown> | null): PackagePlan | null {
  const plan = details?.plan;
  if (typeof plan !== "object" || plan === null) return null;
  const candidate = plan as Partial<PackagePlan>;
  return typeof candidate.plan_digest === "string" && Array.isArray(candidate.items)
    ? (candidate as PackagePlan)
    : null;
}

export function installSource(source: Record<string, unknown>): string | null {
  const instance = source.instance;
  if (typeof instance === "string" && instance) return instance.replace(/^https?:\/\//, "");
  const slug = source.tenant_slug;
  return typeof slug === "string" && slug ? slug : null;
}
