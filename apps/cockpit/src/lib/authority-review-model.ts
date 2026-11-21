import type { TranslationKey } from "@/lib/i18n";
import { currentHost, type ServiceIdentity, serviceIdentity } from "@/lib/service-icons";
import type { WorkflowAuthorityPreview } from "@/lib/workflow-authorities";

export type AuthorityReviewPreview = Pick<
  WorkflowAuthorityPreview,
  "manifest" | "approval_carries_over" | "schedules"
> &
  Partial<
    Pick<
      WorkflowAuthorityPreview,
      | "boundary_growth"
      | "effect_changes"
      | "effect_changes_base"
      | "request_refusals"
      | "storage_refusals"
      | "unavailable_connectors"
      | "boundary_contradictions"
    >
  >;

type Effect = AuthorityReviewPreview["manifest"]["effects"][number];
type EffectChange = NonNullable<AuthorityReviewPreview["effect_changes"]>[number];
export type ReviewRisk = "risky" | "write" | "read";

export type ReviewPlaceholder =
  | { name: string; kind: "enum"; values: string[] }
  | { name: string; kind: "class"; rule: string }
  | { name: string; kind: "caller" };

export interface ReviewRow {
  key: string;
  step_id: string;
  callStep: string | null;
  effect: Effect["effect"];
  risk: ReviewRisk;
  change: EffectChange["change"] | null;
  subject: string | null;
  ceiling: number | null;
  previousCeiling: number | null;
  placeholders: ReviewPlaceholder[];
  unbound: string[];
  open: boolean;
  source: Effect;
}

export interface ReviewGroup {
  key: string;
  name: string;
  service: ServiceIdentity;
  scope: string;
  counts: { read: number; write: number; risky: number };
  rows: ReviewRow[];
  open: boolean;
}

export type ReviewSentence =
  | { kind: "readOnly"; scope: string; service: string }
  | { kind: "writes"; service: string }
  | { kind: "growth" }
  | { kind: "none" };

export interface AuthorityReviewModel {
  tiles: { read: number; write: number; services: number; risky: number };
  sentence: ReviewSentence;
  comparison: {
    version: number | null;
    approved: boolean;
    added: number;
    widened: number;
    unchanged: number;
    removed: number;
  } | null;
  groups: ReviewGroup[];
  requiresWriteCheck: boolean;
  blocked: boolean;
  buttons: { primary: "approve" | "adopt"; activateOnly: "footer" | "menu" | null };
  messages: {
    activated: TranslationKey;
    activateOnlyHelp: TranslationKey;
    approve: TranslationKey;
  };
}

const COLLAPSE_GROUPS_ABOVE = 12;

const RISK_ORDER: Record<ReviewRisk, number> = { risky: 0, write: 1, read: 2 };
const CHANGE_ORDER = { added: 0, widened: 1, unchanged: 2, removed: 3 } as const;

const riskOf = (effect: Effect["effect"]): ReviewRisk =>
  effect === "read" ? "read" : effect === "write" ? "write" : "risky";

const keyOf = (stepId: string, callPath: readonly string[] | undefined) =>
  JSON.stringify([stepId, callPath ?? []]);

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function staticParts(effect: Effect): string[] {
  const parts: Array<string | null | { var: string }> = effect.boundary
    ? effect.boundary.segments
    : effect.read_path
      ? effect.read_path.segments
      : effect.target
        ? (() => {
            try {
              return new URL(effect.target).pathname.split("/");
            } catch {
              return [];
            }
          })()
        : [];
  const leading: string[] = [];
  for (const part of parts) {
    if (part === "") continue;
    if (typeof part !== "string") break;
    leading.push(part);
  }
  return leading;
}

function commonPrefix(lists: string[][]): string[] {
  const [first, ...rest] = lists;
  if (!first) return [];
  const shared: string[] = [];
  for (const [index, part] of first.entries()) {
    if (!rest.every((list) => list[index] === part)) break;
    shared.push(part);
  }
  return shared;
}

function localSubject(effect: Effect): string | null {
  if (
    effect.driver === "graphql" ||
    ["query", "mutation", "subscription"].includes(effect.operation)
  )
    return null;
  const parts: Array<string | null | { var: string }> = effect.boundary
    ? effect.boundary.segments
    : effect.read_path
      ? effect.read_path.segments
      : effect.storage
        ? effect.storage.key_prefix.split("/")
        : [];
  return (
    [...parts].reverse().find((part): part is string => typeof part === "string" && part !== "") ??
    null
  );
}

function placeholdersOf(effect: Effect): ReviewPlaceholder[] {
  return Object.entries(effect.boundary?.variables ?? {}).map(([expression, rule]) => {
    const name = expression.split(".").at(-1) ?? expression;
    if ("enum" in rule) return { name, kind: "enum", values: rule.enum };
    if ("caller_bound" in rule) return { name, kind: "caller" };
    return { name, kind: "class", rule: rule.class };
  });
}

const rowRank = (row: ReviewRow) =>
  row.risk === "read"
    ? 2 + (row.change === "added" ? 0 : row.change === "widened" ? 1 : 2)
    : RISK_ORDER[row.risk];

function compareRows(left: ReviewRow, right: ReviewRow): number {
  return (
    rowRank(left) - rowRank(right) ||
    CHANGE_ORDER[left.change ?? "unchanged"] - CHANGE_ORDER[right.change ?? "unchanged"] ||
    (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  );
}

export function authorityReviewModel(input: {
  preview: AuthorityReviewPreview;
  connectorNames: ReadonlyMap<string, string>;
  connectorServices?: ReadonlyMap<string, ServiceIdentity>;
  automation: { schedule: boolean; webhook: boolean };
  activation: boolean;
  carryOver: boolean;
}): AuthorityReviewModel {
  const { preview, connectorNames } = input;
  const effects = preview.manifest.effects;
  const changes = preview.effect_changes;
  const changeFor = new Map(
    (changes ?? []).map((entry) => [keyOf(entry.step_id, entry.call_path), entry]),
  );
  const rows = effects.map((effect): ReviewRow => {
    const key = keyOf(effect.step_id, effect.call_path);
    const change = changeFor.get(key) ?? null;
    const risk = riskOf(effect.effect);
    const ceiling = effect.boundary
      ? (effect.boundary.pagination?.max_requests ?? effect.boundary.max_calls)
      : null;
    const previous = change?.previous
      ? (change.previous.max_requests ?? change.previous.max_calls)
      : null;
    const placeholders = placeholdersOf(effect);
    return {
      key,
      step_id: effect.step_id,
      callStep: effect.call_path?.[0] ?? null,
      effect: effect.effect,
      risk,
      change: change?.change ?? null,
      subject: change ? change.subject : localSubject(effect),
      ceiling,
      previousCeiling: previous !== null && previous !== ceiling ? previous : null,
      placeholders,
      unbound:
        risk === "read"
          ? []
          : placeholders.flatMap((entry) => (entry.kind === "class" ? [entry.name] : [])),
      open: risk !== "read",
      source: effect,
    };
  });
  const grouped = new Map<string, ReviewRow[]>();
  const groupKey = (effect: Effect) =>
    effect.connector_id ?? hostOf(effect.boundary?.origin ?? effect.target) ?? "direct";
  for (const row of rows) {
    const key = groupKey(row.source);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  const collapsed = effects.length > COLLAPSE_GROUPS_ABOVE;
  const groups = [...grouped.entries()]
    .map(([key, members]): ReviewGroup => {
      const first = members[0]?.source;
      const host = hostOf(first?.boundary?.origin ?? first?.target) ?? "";
      const prefix = commonPrefix(members.map((row) => staticParts(row.source)));
      return {
        key,
        name: (first?.connector_id && connectorNames.get(first.connector_id)) || host || key,
        service:
          (first?.connector_id && input.connectorServices?.get(first.connector_id)) ||
          serviceIdentity(
            { base_url: first?.boundary?.origin ?? first?.target ?? null },
            currentHost(),
          ),
        scope: [host, ...prefix].filter(Boolean).join("/"),
        counts: {
          read: members.filter((row) => row.risk === "read").length,
          write: members.filter((row) => row.risk === "write").length,
          risky: members.filter((row) => row.risk === "risky").length,
        },
        rows: [...members].sort(compareRows),
        open: !collapsed,
      };
    })
    .sort(
      (left, right) =>
        compareRows(left.rows[0] as ReviewRow, right.rows[0] as ReviewRow) ||
        left.name.localeCompare(right.name),
    );
  const services = groups.map((group) => group.name).join(", ");
  const grows = preview.boundary_growth === undefined || preview.boundary_growth.length > 0;
  const approvedBase =
    preview.boundary_growth !== undefined && preview.effect_changes_base?.approved !== false;
  const requiresWriteCheck = rows.some(
    (row) =>
      row.risk !== "read" &&
      (!approvedBase ||
        changes === undefined ||
        row.change === "added" ||
        row.change === "widened"),
  );
  const sentence: ReviewSentence =
    effects.length === 0
      ? { kind: "none" }
      : (preview.boundary_growth?.length ?? 0) > 0
        ? { kind: "growth" }
        : rows.every((row) => row.risk === "read")
          ? {
              kind: "readOnly",
              scope:
                commonPrefix(rows.map((row) => staticParts(row.source)))
                  .slice(-2)
                  .join("/") || groups.map((group) => group.scope).join(", "),
              service: services,
            }
          : { kind: "writes", service: services };
  const count = (kind: EffectChange["change"]) =>
    (changes ?? []).filter((entry) => entry.change === kind).length;
  return {
    tiles: {
      read: rows.filter((row) => row.risk === "read").length,
      write: rows.filter((row) => row.risk === "write").length,
      services: groups.length,
      risky: rows.filter((row) => row.risk === "risky").length,
    },
    sentence,
    comparison: changes
      ? {
          version: preview.effect_changes_base?.version ?? null,
          approved: approvedBase,
          added: count("added"),
          widened: count("widened"),
          unchanged: count("unchanged"),
          removed: count("removed"),
        }
      : null,
    groups,
    requiresWriteCheck,
    blocked:
      (preview.request_refusals?.length ?? 0) +
        (preview.storage_refusals?.length ?? 0) +
        (preview.unavailable_connectors?.length ?? 0) +
        (preview.boundary_contradictions?.length ?? 0) >
      0,
    buttons: input.carryOver
      ? { primary: "adopt", activateOnly: null }
      : {
          primary: "approve",
          activateOnly: input.activation
            ? (input.automation.schedule || input.automation.webhook) && grows
              ? "menu"
              : "footer"
            : null,
        },
    messages: {
      activated: input.carryOver ? "authority.adopted" : "authority.activatedOnly",
      activateOnlyHelp:
        input.automation.schedule || input.automation.webhook
          ? "authority.review.help.activateOnlyHeld"
          : "authority.review.help.activateOnly",
      approve: requiresWriteCheck ? "authority.review.approveWrites" : "authority.review.approve",
    },
  };
}

export function replacedVersion(versions: {
  running: number | null;
  reviewed: number | null;
}): number | null {
  return versions.running !== null &&
    versions.reviewed !== null &&
    versions.running !== versions.reviewed
    ? versions.running
    : null;
}

export function reviewTitle(facts: { name: string; version: number } | null): {
  key: TranslationKey;
  values: Record<string, string>;
} {
  return facts
    ? { key: "authority.namedTitle", values: { name: facts.name, version: `v${facts.version}` } }
    : { key: "authority.grantOpen", values: {} };
}
