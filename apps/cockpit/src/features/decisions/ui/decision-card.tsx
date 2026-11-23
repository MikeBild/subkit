import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Badge } from "@ui/atoms/badge";
import { Button } from "@ui/atoms/button";
import { Textarea } from "@ui/atoms/textarea";
import { cn } from "@ui/lib/utils";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  dryRunPatchCandidate,
  getPatchCandidatePreview,
  getSkillCandidate,
  listSkillCandidateEvidence,
  type SkillCandidate,
} from "@/api/decisions";
import { absolute, runHref } from "@/app/links";
import { ActionMenu, type ActionMenuItem, DataState } from "@/components/cockpit/patterns";
import { diagnosisCauseKey } from "@/features/grants/model";
import {
  ChangeReview,
  ChangeReviewActions,
  ChangeSummary,
  candidateReviewOperations,
  DiffCard,
  stepReviewChanges,
  testCandidateChange,
  useChangeReview,
} from "@/features/workflows";
import { reportFailure } from "@/lib/action-failure";
import type { Translate } from "@/lib/i18n";
import { pluralKey, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import type { NameIndex } from "@/lib/name-index";
import { EMPTY_NAME_INDEX } from "@/lib/name-index";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { refusalReasonLabel } from "@/lib/refusal-reason";
import { changeFacts, changeRows } from "../model/decision-facts";
import { ageInDays } from "../model/decision-queue";
import type { ContextEntry, DecisionContext, PatchEvidence } from "../model/decisions-context";
import {
  classificationReasonKey,
  driftKindKey,
  fixerKey,
  patchContext,
  proposalKindKey,
  skillContext,
} from "../model/decisions-context";
import type { DecidableItem, DecidableKind, DecisionItem } from "../model/decisions-model";
import {
  approveBlockedReason,
  decisionActions,
  decisionKey,
  ORIGIN_LABEL,
} from "../model/decisions-model";
import { SkillProposalSheet } from "./skill-proposal-sheet";

const KIND_LABEL: Record<DecidableKind, TranslationKey> = {
  patch: "decisions.kind.patch",
  skill: "decisions.kind.skill",
};

const KIND_EFFECT: Record<DecidableKind, TranslationKey> = {
  patch: "decisions.effect.patch",
  skill: "decisions.effect.skill",
};

const CONFIDENCE_LABEL: Record<"low" | "medium" | "high", TranslationKey> = {
  low: "decisions.confidence.low",
  medium: "decisions.confidence.medium",
  high: "decisions.confidence.high",
};

function deadlineLabel(
  expiresAt: string | null,
  now: number,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
): { label: string; expired: boolean } | null {
  if (!expiresAt) return null;
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(expires)) return null;
  if (expires <= now) return { label: t("decisions.expired"), expired: true };
  const minutes = Math.round((expires - now) / 60_000);
  const time =
    minutes >= 60
      ? t("decisions.time.hours", { count: String(Math.round(minutes / 60)) })
      : t("decisions.time.minutes", { count: String(Math.max(1, minutes)) });
  return { label: t("decisions.expiresIn", { time }), expired: false };
}

function gateCause(evidence: PatchEvidence, t: Translate): string | null {
  const reason = refusalReasonLabel(evidence.gateReason, t);
  if (reason && !reason.machine) return reason.text;
  const key = evidence.gateCode ? diagnosisCauseKey(evidence.gateCode) : undefined;
  return key ? t(key) : null;
}

function stepName(step: unknown): string | null {
  if (!step || typeof step !== "object") return null;
  const { name, id } = step as { name?: unknown; id?: unknown };
  if (typeof name === "string" && name.trim()) return name;
  return typeof id === "string" && id ? id : null;
}

function detailHasContent(item: DecidableItem): boolean {
  const detail = item.detail;
  if (detail.kind === "patch") return true;
  return detail.body.trim().length > 0;
}

function decisionContext(
  item: DecidableItem,
  t: Translate,
  names: NameIndex,
  canReadRuns: boolean,
): DecisionContext {
  const labels = {
    cause: null as string | null,
    causeFallback: t("decisions.drift.unknown"),
    failedRun: t("decisions.context.failedRun"),
    endpoint: t("decisions.context.connector"),
    workflow: t("decisions.context.workflow"),
    conversation: t("decisions.openConversation"),
    allWorkflows: t("decisions.target.allWorkflows"),
    noTarget: t("decisions.target.none"),
    pattern: t(ORIGIN_LABEL[item.origin]),
    observedCases:
      item.evidenceCount !== null
        ? t(pluralKey("decisions.evidence", item.evidenceCount), { count: item.evidenceCount })
        : "",
  };
  const detail = item.detail;
  if (detail.kind === "patch") {
    const causeKey = driftKindKey(detail.evidence.driftKind);
    return patchContext(
      detail.evidence,
      { ...labels, cause: gateCause(detail.evidence, t) ?? (causeKey ? t(causeKey) : null) },
      names,
      canReadRuns,
    );
  }
  return skillContext(detail.evidence, labels, names);
}

function ContextColumns({ context, testId }: { context: DecisionContext; testId: string }) {
  const { t } = useI18n();
  if (context.sources.length === 0 && context.targets.length === 0) return null;
  return (
    <div
      className="mt-3 grid gap-3 rounded-md bg-muted/40 p-3 sm:grid-cols-2"
      data-testid={`${testId}-context`}
    >
      <ContextColumn
        heading={t("decisions.context.sources")}
        entries={context.sources}
        testId={`${testId}-sources`}
      />
      <ContextColumn
        heading={t("decisions.context.targets")}
        entries={context.targets}
        testId={`${testId}-targets`}
      />
    </div>
  );
}

function ContextColumn({
  heading,
  entries,
  testId,
}: {
  heading: string;
  entries: ContextEntry[];
  testId: string;
}) {
  const { t } = useI18n();
  const safe = (text: string) => hideTechnicalIdentifiers(text, t("tool.referenceHiddenInline"));
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{heading}</p>
      <ul className="mt-1 grid gap-1">
        {entries.map((entry, index) => (
          <li
            key={`${entry.label}-${index}`}
            className="flex min-w-0 flex-wrap items-baseline gap-2 text-sm"
          >
            {entry.href ? (
              <Link
                to={entry.href}
                className="min-w-0 truncate underline underline-offset-2"
                data-testid={`${testId}-link-${index}`}
              >
                {safe(entry.label)}
              </Link>
            ) : (
              <span className="min-w-0 truncate" data-testid={`${testId}-item-${index}`}>
                {safe(entry.label)}
              </span>
            )}
            {entry.note && (
              <span className="min-w-0 truncate font-mono text-muted-foreground text-xs">
                {safe(entry.note)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DetailBlock({
  heading,
  children,
  testId,
}: {
  heading: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="grid gap-1" {...(testId ? { "data-testid": testId } : {})}>
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{heading}</p>
      {children}
    </div>
  );
}

function DetailList({ items }: { items: string[] }) {
  const { t } = useI18n();
  return (
    <ul className="grid list-disc gap-1 pl-5 text-sm">
      {items.map((entry, index) => (
        <li key={`${entry}-${index}`} className="max-w-prose break-words">
          {hideTechnicalIdentifiers(entry, t("tool.referenceHiddenInline"))}
        </li>
      ))}
    </ul>
  );
}

function DetailText({
  children,
  className,
  ...rest
}: { children: string; className?: string } & Record<`data-${string}`, string>) {
  const { t } = useI18n();
  return (
    <p className={className} {...rest}>
      {hideTechnicalIdentifiers(children, t("tool.referenceHiddenInline"))}
    </p>
  );
}

function DecisionDetailPanel({
  item,
  testId,
  canReadRuns,
}: {
  item: DecidableItem;
  testId: string;
  canReadRuns: boolean;
}) {
  const { t } = useI18n();
  const detail = item.detail;

  if (detail.kind === "patch") {
    const { evidence } = detail;
    const changeKey = proposalKindKey(evidence.proposalKind);
    const fixKey = fixerKey(evidence.fixer);
    const cause = gateCause(evidence, t);
    const reasons = evidence.classificationReasons.map((reason) => {
      const key = classificationReasonKey(reason);
      return key ? t(key) : reason;
    });
    if (fixKey)
      return (
        <div className="mt-3 grid gap-4 border-t pt-3" data-testid={`${testId}-detail`}>
          <DetailBlock heading={t("decisions.detail.reasoning")}>
            <p className="max-w-prose text-sm" data-testid={`${testId}-reasoning`}>
              {cause && evidence.gateStepId
                ? t("decisions.gate.refused", { step: evidence.gateStepId, reason: cause })
                : t(fixKey)}
            </p>
          </DetailBlock>
          {reasons.length > 0 && (
            <DetailBlock heading={t("decisions.detail.classification")}>
              <DetailList items={reasons} />
            </DetailBlock>
          )}
        </div>
      );
    return (
      <div className="mt-3 grid gap-4 border-t pt-3" data-testid={`${testId}-detail`}>
        {changeKey && (
          <DetailBlock heading={t("decisions.detail.reasoning")}>
            <p className="max-w-prose text-sm">{t(changeKey)}</p>
            {evidence.reasoning && (
              <DetailText
                className="max-w-prose text-sm text-muted-foreground break-words"
                data-testid={`${testId}-reasoning`}
              >
                {evidence.reasoning}
              </DetailText>
            )}
          </DetailBlock>
        )}
        {!changeKey && evidence.reasoning && (
          <DetailBlock heading={t("decisions.detail.reasoning")}>
            <DetailText
              className="max-w-prose text-sm text-muted-foreground break-words"
              data-testid={`${testId}-reasoning`}
            >
              {evidence.reasoning}
            </DetailText>
          </DetailBlock>
        )}
        {evidence.driftSummary && (
          <DetailBlock heading={t("decisions.detail.rawDrift")}>
            <DetailText
              className="max-h-52 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap"
              data-testid={`${testId}-drift`}
            >
              {evidence.driftSummary}
            </DetailText>
          </DetailBlock>
        )}
        {reasons.length > 0 && (
          <DetailBlock heading={t("decisions.detail.classification")}>
            <DetailList items={reasons} />
          </DetailBlock>
        )}
        {evidence.rejections.length > 0 && (
          <DetailBlock heading={t("decisions.detail.rejected")} testId={`${testId}-rejections`}>
            <DetailList items={evidence.rejections} />
          </DetailBlock>
        )}
      </div>
    );
  }

  {
    const { sections } = detail;
    return (
      <div className="mt-3 grid gap-4 border-t pt-3" data-testid={`${testId}-detail`}>
        <DetailBlock heading={t("decisions.detail.skillBody")} testId={`${testId}-body`}>
          <DetailText className="max-w-prose text-sm wrap-anywhere whitespace-pre-wrap">
            {detail.body}
          </DetailText>
        </DetailBlock>
        {sections.examples.length > 0 && (
          <DetailBlock heading={t("decisions.detail.examples")}>
            <DetailList items={sections.examples} />
          </DetailBlock>
        )}
        {sections.bestPractices.length > 0 && (
          <DetailBlock heading={t("decisions.detail.bestPractices")}>
            <DetailList items={sections.bestPractices} />
          </DetailBlock>
        )}
        {sections.pitfalls.length > 0 && (
          <DetailBlock heading={t("decisions.detail.pitfalls")}>
            <DetailList items={sections.pitfalls} />
          </DetailBlock>
        )}
        {sections.docRefs.length > 0 && (
          <DetailBlock heading={t("decisions.detail.docRefs")}>
            <DetailList items={sections.docRefs} />
          </DetailBlock>
        )}
        {sections.tags.length > 0 && (
          <DetailBlock heading={t("decisions.detail.tags")}>
            <div className="flex flex-wrap gap-1">
              {sections.tags.map((tag) => (
                <Badge key={tag} variant="outline">
                  {hideTechnicalIdentifiers(tag, t("tool.referenceHiddenInline"))}
                </Badge>
              ))}
            </div>
          </DetailBlock>
        )}
        <SkillEvidenceList id={item.id} testId={testId} canReadRuns={canReadRuns} />
      </div>
    );
  }
}

function SkillEvidenceList({
  id,
  testId,
  canReadRuns,
}: {
  id: string;
  testId: string;
  canReadRuns: boolean;
}) {
  const { t, dateTime } = useI18n();
  const evidence = useQuery({
    queryKey: ["skill-candidate", "evidence", id],
    queryFn: () => listSkillCandidateEvidence(id),
  });

  return (
    <DetailBlock heading={t("decisions.detail.evidence")} testId={`${testId}-evidence`}>
      {evidence.isPending ? (
        <p className="text-sm text-muted-foreground">{t("decisions.detail.evidenceLoading")}</p>
      ) : evidence.error ? (
        <DataState
          state="error"
          line={t("decisions.detail.evidenceFailed")}
          error={evidence.error}
          onRetry={() => void evidence.refetch()}
          testId={`${testId}-evidence-failed`}
        />
      ) : (evidence.data?.items.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">{t("decisions.detail.evidenceEmpty")}</p>
      ) : (
        <ul className="grid gap-1 text-sm">
          {(evidence.data?.items ?? []).map((entry, index) => (
            <li key={entry.id} className="flex flex-wrap items-baseline gap-2">
              <span className="text-muted-foreground text-xs">{dateTime(entry.captured_at)}</span>
              <span className="min-w-0 max-w-prose break-words">
                {hideTechnicalIdentifiers(entry.summary, t("tool.referenceHiddenInline"))}
              </span>
              {entry.execution_id && canReadRuns && (
                <a
                  href={absolute(runHref(entry.execution_id))}
                  className="underline underline-offset-2"
                  data-testid={`${testId}-evidence-run-${index}`}
                >
                  {t("decisions.context.failedRun")}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </DetailBlock>
  );
}

interface DecisionCardProps {
  item: DecidableItem;
  index: number;
  canDecide: boolean;
  busy: boolean;
  compact?: boolean;
  onApprove: (item: DecisionItem, reviewDigest?: string, acceptedOperations?: number[]) => void;
  onReject: (item: DecisionItem, reason: string) => void;
  testIdPrefix?: string;
  names?: NameIndex;
  canReadRuns?: boolean;
  priority: "urgent" | "normal";
  actionsSlot?: HTMLElement | null;
  permissions?: readonly string[];
  onDecided?: (item: DecisionItem) => void;
}

export function DecisionCard({
  item,
  index,
  canDecide,
  busy,
  compact = false,
  onApprove,
  onReject,
  testIdPrefix = "decision",
  names = EMPTY_NAME_INDEX,
  canReadRuns = false,
  priority,
  actionsSlot = null,
  permissions = [],
  onDecided,
}: DecisionCardProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const testId = `${testIdPrefix}-${index}`;
  const key = decisionKey(item);
  const now = Date.now();
  const age = ageInDays(item.waitingSince, now);
  const deadline = deadlineLabel(item.expiresAt, now, t);
  const showDiff = expanded && item.kind === "patch";
  const context = decisionContext(item, t, names, canReadRuns);
  const hasDetail = detailHasContent(item);

  const inSheet = actionsSlot !== null;
  const preview = useQuery({
    queryKey: ["patch-candidate", "preview", item.id],
    enabled: showDiff || (inSheet && item.kind === "patch"),
    queryFn: () => getPatchCandidatePreview(item.id),
  });
  const changeShown = inSheet && item.kind === "patch" && preview.data !== undefined;
  const blockedReason = approveBlockedReason({
    canDecide,
    expanded: expanded || !hasDetail || changeShown,
    kind: item.kind,
    reviewDigest: item.reviewDigest,
    preview: item.kind === "patch" ? preview.data : undefined,
  });
  const dryRun = useQuery({
    queryKey: ["patch-candidate", "dry-run", item.id],
    enabled: showDiff && preview.data?.fixture_available === true,
    retry: false,
    queryFn: () => dryRunPatchCandidate(item.id),
  });

  const blocked =
    blockedReason && item.kind === "patch" && !busy && !rejecting ? (
      <span
        className={cn("text-xs text-muted-foreground", inSheet ? "" : "basis-full text-right")}
        data-testid={`${testId}-approve-blocked`}
      >
        {t(blockedReason)}
      </span>
    ) : null;
  const evidence = item.detail.kind === "patch" ? item.detail.evidence : null;
  const facts =
    item.kind === "patch" && preview.data
      ? changeFacts(preview.data.before_step, preview.data.after_step, preview.data.changed_paths)
      : [];
  const step =
    stepName(preview.data?.after_step) ??
    stepName(preview.data?.before_step) ??
    evidence?.workflowStepId ??
    null;
  const cause = evidence ? gateCause(evidence, t) : null;
  const operations = useMemo(
    () => (item.kind === "patch" && preview.data ? candidateReviewOperations(preview.data) : []),
    [item.kind, preview.data],
  );
  const reviewing = inSheet && item.kind === "patch" && operations.length > 0;
  const candidate = preview.data;
  const changeReview = useChangeReview({
    total: operations.length,
    digestRequired: true,
    fullDigest: candidate?.review_digest,
    onTest:
      reviewing && candidate
        ? (accepted) =>
            testCandidateChange({
              candidateId: item.id,
              workflowId: candidate.workflow_id,
              baseVersionId: candidate.base_version_id,
              stepId: candidate.before_step?.id || candidate.after_step?.id || null,
              before: candidate.before_step,
              operations,
              accepted,
              partial: accepted.length < operations.length,
              fixtureAvailable: candidate.fixture_available === true,
            })
        : undefined,
  });
  const changeKey = evidence
    ? (fixerKey(evidence.fixer) ??
      proposalKindKey(evidence.proposalKind) ??
      driftKindKey(evidence.driftKind))
    : null;
  const heading = inSheet && changeKey ? t(changeKey) : item.title;
  const approvable =
    !busy &&
    !rejecting &&
    blockedReason === null &&
    (item.kind !== "patch" || (preview.data?.reviewable === true && !!preview.data.review_digest));
  const [primaryAction, secondaryAction] = decisionActions(item.kind);
  const primaryLabel = t(primaryAction?.labelKey ?? "decisions.applyFix");
  const [proposal, setProposal] = useState<SkillCandidate | null>(null);
  const opening = useMutation({
    mutationFn: () => getSkillCandidate(item.id),
    onSuccess: setProposal,
    onError: (failure) => reportFailure(t("common.actionFailed"), failure),
  });
  const rejectItem: ActionMenuItem = {
    label: t(secondaryAction?.labelKey ?? "decisions.reject"),
    onSelect: () => setRejecting(true),
    disabled: busy,
    testId: `${testId}-reject`,
  };
  const actions = !canDecide ? null : rejecting ? (
    <>
      <Button
        variant="ghost"
        size="sm"
        data-testid={`${testId}-reject-cancel`}
        onClick={() => {
          setRejecting(false);
          setReason("");
        }}
      >
        {t("common.cancel")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        data-testid={`${testId}-reject-confirm`}
        onClick={() => onReject(item, reason.trim())}
      >
        {t("decisions.reject")}
      </Button>
    </>
  ) : item.kind === "skill" ? (
    <Button
      size="sm"
      disabled={busy || opening.isPending}
      aria-busy={opening.isPending || undefined}
      data-testid={`${testId}-open`}
      onClick={() => opening.mutate()}
    >
      {primaryLabel}
    </Button>
  ) : reviewing ? (
    <>
      <ActionMenu size="sm" testId={`${testId}-more`} items={[rejectItem]} />
      <ChangeReviewActions
        review={changeReview}
        busy={busy}
        blocked={!approvable}
        onAcceptAndSave={() =>
          onApprove(
            item,
            changeReview.digest ?? undefined,
            changeReview.partial ? changeReview.accepted : undefined,
          )
        }
        testId={testId}
      />
    </>
  ) : (
    <>
      <ActionMenu size="sm" testId={`${testId}-more`} items={[rejectItem]} />
      <Button
        size="sm"
        disabled={!approvable}
        title={blockedReason ? t(blockedReason) : undefined}
        data-testid={`${testId}-approve`}
        onClick={() => onApprove(item, preview.data?.review_digest ?? undefined)}
      >
        {primaryLabel}
      </Button>
    </>
  );

  return (
    <article
      className={cn(
        "@container flex flex-col",
        inSheet ? "gap-3" : "min-h-[162px] gap-1.5 rounded-2xl border border-l-2 p-3",
        !inSheet && (priority === "urgent" ? "border-l-warning" : "border-l-border"),
      )}
      data-testid={testId}
      data-decision-key={key}
      data-state="open"
      data-sk-slot="decision-row"
      data-sk-decision-kind={item.kind}
      data-sk-decision-priority={priority}
    >
      <div
        className="flex min-w-0 flex-col gap-2 @sm:flex-row @sm:items-start @sm:justify-between"
        data-sk-slot="decision-meta"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant="outline" data-testid={`${testId}-kind`}>
            {t(KIND_LABEL[item.kind])}
          </Badge>
          {item.classification && (
            <Badge variant={item.classification === "safe" ? "secondary" : "destructive"}>
              {t(
                item.classification === "safe"
                  ? "overview.classification.safe"
                  : "overview.classification.unsafe",
              )}
            </Badge>
          )}
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-xs text-muted-foreground @sm:justify-end">
          <span data-sk-slot="decision-source">{t(ORIGIN_LABEL[item.origin])}</span>
          <span data-testid={`${testId}-age`}>
            {age === 0
              ? t("decisions.age.today")
              : age === 1
                ? t("decisions.age.day")
                : t("decisions.age.days", { days: String(age) })}
          </span>
          {deadline && (
            <span
              className={cn(deadline.expired ? "text-destructive" : "text-warning")}
              data-testid={`${testId}-deadline`}
            >
              {deadline.label}
            </span>
          )}
        </div>
      </div>

      <h3
        className="line-clamp-2 text-sm font-medium"
        title={heading}
        data-testid={`${testId}-title`}
        data-sk-slot="decision-title"
      >
        {hideTechnicalIdentifiers(heading, t("tool.referenceHiddenInline"))}
      </h3>

      <p className="truncate text-sm text-muted-foreground" data-sk-slot="decision-effect">
        {t(KIND_EFFECT[item.kind])}
      </p>

      {reviewing ? (
        <>
          <ChangeSummary facts={[]} step={step} cause={cause} testId={`${testId}-change`} />
          <ChangeReview
            changes={stepReviewChanges(operations, t)}
            review={changeReview}
            disabled={busy || !canDecide}
            testId={`${testId}-review`}
          />
        </>
      ) : inSheet && facts.length > 0 ? (
        <ChangeSummary facts={facts} step={step} cause={cause} testId={`${testId}-change`} />
      ) : null}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
        <span data-sk-slot="decision-details">
          {hasDetail && !compact ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid={`${testId}-toggle`}
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {t(expanded ? "decisions.showLess" : "decisions.showMore")}
            </Button>
          ) : null}
        </span>
        {inSheet ? null : (
          <div
            className="flex min-w-0 flex-wrap items-center justify-end gap-2"
            data-sk-slot="decision-actions"
          >
            {actions}
            {blocked}
          </div>
        )}
      </div>
      {inSheet
        ? (blocked ??
          (reviewing && changeReview.blockedKey && !busy && !rejecting ? (
            <span
              className="text-xs text-muted-foreground"
              data-testid={`${testId}-accept-blocked`}
            >
              {t(changeReview.blockedKey)}
            </span>
          ) : null))
        : null}
      {inSheet && actionsSlot
        ? createPortal(
            <span className="flex flex-wrap items-center gap-2" data-testid={`${testId}-actions`}>
              {actions}
            </span>,
            actionsSlot,
          )
        : null}

      {rejecting && (
        <div className="border-t pt-3">
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("decisions.notePlaceholder")}
            data-testid={`${testId}-note`}
            aria-label={t("decisions.note")}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {t(item.kind === "skill" ? "decisions.noteScopeFinal" : "decisions.noteScope")}
          </p>
        </div>
      )}

      {expanded && (
        <div className="border-t pt-3">
          {item.summary && item.summary !== item.title && (
            <p
              className="mt-1 max-w-prose text-sm text-muted-foreground break-words"
              data-testid={`${testId}-summary`}
            >
              {hideTechnicalIdentifiers(item.summary, t("tool.referenceHiddenInline"))}
            </p>
          )}
          {item.confidence && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid={`${testId}-confidence`}>
              {t("decisions.confidence", {
                level: t(CONFIDENCE_LABEL[item.confidence]),
              })}
              {item.evidenceCount !== null
                ? ` · ${t(pluralKey("decisions.evidence", item.evidenceCount), { count: item.evidenceCount })}`
                : ""}
            </p>
          )}

          <ContextColumns context={context} testId={testId} />

          <DecisionDetailPanel item={item} testId={testId} canReadRuns={canReadRuns} />

          {showDiff && (
            <div className="mt-3">
              {preview.isPending ? (
                <p className="text-sm text-muted-foreground" data-testid={`${testId}-diff-loading`}>
                  {t("decisions.diffLoading")}
                </p>
              ) : preview.error || !preview.data ? (
                <DataState
                  state="error"
                  line={t("decisions.diffFailed")}
                  error={preview.error ?? undefined}
                  onRetry={() => void preview.refetch()}
                  testId={`${testId}-diff-error`}
                />
              ) : (
                <DiffCard
                  testId={`${testId}-diff`}
                  embedded
                  targetLabel={item.target ?? t("decisions.kind.patch")}
                  before={preview.data.before_step}
                  after={preview.data.after_step}
                  rows={changeRows(facts)}
                  changeShownAbove={inSheet && facts.length > 0}
                  changedPaths={preview.data.changed_paths}
                  driftSummary={preview.data.drift_summary}
                  patch={preview.data.proposal?.patch}
                  fixtureAvailable={preview.data.fixture_available}
                  dryRun={dryRun.data ?? null}
                  dryRunPending={preview.data.fixture_available === true && dryRun.isPending}
                />
              )}
            </div>
          )}
        </div>
      )}
      {item.kind === "skill" ? (
        <SkillProposalSheet
          candidate={proposal}
          permissions={permissions}
          onClose={() => setProposal(null)}
          onDecided={() => onDecided?.(item)}
        />
      ) : null}
    </article>
  );
}
