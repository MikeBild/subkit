import { refusalSentenceKey } from "@/lib/authority-issues";
import { presentRequestBoundary, type RequestBoundaryView } from "@/lib/authority-request";
import { presentStorageScope } from "@/lib/authority-storage";
import { humanize } from "@/lib/effect-label";
import { pluralKey, type TranslationKey } from "@/lib/i18n";

interface StorageScopeView {
  operation: string;
  key_prefix: string;
  max_bytes: number;
  max_keys: number;
  max_deletes?: number;
}

interface Widening {
  field: "key_prefix" | "max_bytes";
  from: string | number;
  to: string | number;
}

interface BoundaryProposal {
  step_id: string;
  request?: RequestBoundaryView;
  storage?: StorageScopeView;
  path_rewrite?: unknown;
  widens?: Widening[];
  evidence: { observations: number; sample: string; newest_at: string; kind: "sent" | "trial" };
}

interface UnproposableStep {
  step_id: string;
  reason: string;
  refusal?: string;
}

export interface BoundaryProposalsView {
  proposals: BoundaryProposal[];
  unproposable: UnproposableStep[];
  digest: string;
  base_version_id: string | null;
}

interface ProposalLine {
  key: TranslationKey;
  values: Record<string, string | number>;
}

interface ProposalRow {
  step_id: string;
  label: string;
  title: TranslationKey;
  destructive: boolean;
  lines: ProposalLine[];
  technical: string;
}

interface RemainingStep {
  step_id: string;
  label: string;
  reason: TranslationKey;
  code: string;
}

export interface ProposalsModel {
  rows: ProposalRow[];
  listsValues: boolean;
  untried: RemainingStep[];
  remaining: RemainingStep[];
}

const TRIAL_REASONS = new Set(["no_history", "body_size_unknown"]);

const REASON_KEYS: Record<string, TranslationKey> = {
  no_history: "authorityProposals.reason.no_history",
  body_size_unknown: "authorityProposals.reason.body_size_unknown",
  path_not_comparable: "authorityProposals.reason.path_not_comparable",
  values_not_describable: "authorityProposals.reason.values_not_describable",
  not_supported: "authorityProposals.reason.not_supported",
  sensitive_value: "authorityProposals.reason.sensitive_value",
  still_refused: "authorityProposals.reason.still_refused",
};

export function readBoundaryProposals(body: unknown): BoundaryProposalsView {
  const view = (body ?? {}) as Partial<BoundaryProposalsView>;
  return {
    proposals: Array.isArray(view.proposals) ? view.proposals : [],
    unproposable: Array.isArray(view.unproposable) ? view.unproposable : [],
    digest: typeof view.digest === "string" ? view.digest : "",
    base_version_id: typeof view.base_version_id === "string" ? view.base_version_id : null,
  };
}

function plainName(expression: string): string {
  return humanize(expression.split(".").at(-1) ?? expression) || expression;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function closingLines(
  proposal: BoundaryProposal,
  formatNumber: (value: number) => string,
): ProposalLine[] {
  const shown = (value: string | number) =>
    typeof value === "number" ? formatNumber(value) : value;
  const { observations, kind } = proposal.evidence;
  return [
    ...(proposal.widens ?? []).map(
      (entry): ProposalLine => ({
        key: `authorityProposals.widens.${entry.field}`,
        values: { from: shown(entry.from), to: shown(entry.to) },
      }),
    ),
    ...(proposal.path_rewrite ? [{ key: "authorityProposals.rewrite" as const, values: {} }] : []),
    {
      key: pluralKey(
        kind === "trial" ? "authorityProposals.evidence.trial" : "authorityProposals.evidence",
        observations,
      ),
      values: { count: observations },
    },
  ];
}

function requestRow(
  proposal: BoundaryProposal,
  boundary: RequestBoundaryView,
  formatNumber: (value: number) => string,
): ProposalRow {
  const shown = presentRequestBoundary(boundary, formatNumber);
  return {
    step_id: proposal.step_id,
    label: humanize(proposal.step_id),
    title: shown.title,
    destructive: shown.destructive,
    lines: [
      { key: "authorityProposals.host", values: { host: hostOf(boundary.origin) } },
      ...shown.variables.map((line) => ({
        key: line.key,
        values: { ...line.values, name: plainName(line.values.name ?? "") },
      })),
      shown.body,
      {
        key: pluralKey("authority.boundary.calls", shown.calls),
        values: { count: formatNumber(shown.calls) },
      },
      ...(shown.paging ? [shown.paging] : []),
      ...closingLines(proposal, formatNumber),
    ],
    technical: `${boundary.method} ${shown.target}`,
  };
}

function storageRow(
  proposal: BoundaryProposal,
  scope: StorageScopeView,
  formatNumber: (value: number) => string,
): ProposalRow {
  const shown = presentStorageScope(scope, formatNumber);
  return {
    step_id: proposal.step_id,
    label: humanize(proposal.step_id),
    title: shown.title,
    destructive: shown.destructive,
    lines: [
      { key: "authority.storage.folder", values: { folder: scope.key_prefix } },
      { key: shown.detail, values: shown.values },
      ...closingLines(proposal, formatNumber),
    ],
    technical: `${scope.operation} ${proposal.evidence.sample}`,
  };
}

function remainingStep(entry: UnproposableStep): RemainingStep {
  const refusal = entry.refusal ? refusalSentenceKey(entry.refusal) : undefined;
  return {
    step_id: entry.step_id,
    label: humanize(entry.step_id),
    reason: refusal ?? REASON_KEYS[entry.reason] ?? "authorityProposals.reason.not_supported",
    code: entry.refusal ? `${entry.reason}:${entry.refusal}` : entry.reason,
  };
}

export function proposalsModel(
  view: BoundaryProposalsView,
  formatNumber: (value: number) => string,
): ProposalsModel {
  const rows = view.proposals.flatMap((proposal) => {
    if (proposal.request) return [requestRow(proposal, proposal.request, formatNumber)];
    if (proposal.storage) return [storageRow(proposal, proposal.storage, formatNumber)];
    return [];
  });
  const untried = view.unproposable.filter((entry) => TRIAL_REASONS.has(entry.reason));
  const remaining = view.unproposable.filter((entry) => !TRIAL_REASONS.has(entry.reason));
  return {
    rows,
    listsValues: view.proposals.some((proposal) =>
      Object.values(proposal.request?.variables ?? {}).some((rule) => "enum" in rule),
    ),
    untried: untried.map(remainingStep),
    remaining: remaining.map(remainingStep),
  };
}

export function proposalStepIds(model: ProposalsModel): string[] {
  return model.rows.map((row) => row.step_id);
}
