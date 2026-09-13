import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useState } from "react";

import { apiRequest } from "@/api/client";
import {
  dryRunPatchCandidate,
  getPatchCandidatePreview,
  listSkillCandidateEvidence,
} from "@/api/decisions";
import { DiffCard } from "@/components/cockpit/diff-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import type { NameIndex } from "@/lib/name-index";
import { EMPTY_NAME_INDEX } from "@/lib/name-index";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { cn } from "@/lib/utils";
import type { ContextEntry, DecisionContext } from "@/pages/decisions-context";
import {
  driftKindKey,
  patchContext,
  proposalKindKey,
  skillContext,
} from "@/pages/decisions-context";
import type {
  DecidableItem,
  DecidableKind,
  DecisionItem,
  DecisionOrigin,
} from "@/pages/decisions-model";
import { ageInDays, decisionKey } from "@/pages/decisions-model";

import { GrantWorkflowAuthority } from "./grant-workflow-authority";

/**
 * Only the two kinds this card can decide.
 *
 * A waiting conversation used to render here too, with no approve, no reject
 * and a link into the chat as its only action — a card in a decision queue that
 * could not decide anything. It is counted on the tile above the queue now and
 * answered where it was asked (§8.5b).
 */
const KIND_LABEL: Record<DecidableKind, TranslationKey> = {
  patch: "decisions.kind.patch",
  skill: "decisions.kind.skill",
};

const KIND_EFFECT: Record<DecidableKind, TranslationKey> = {
  patch: "decisions.effect.patch",
  skill: "decisions.effect.skill",
};

const ORIGIN_LABEL: Record<DecisionOrigin, TranslationKey> = {
  observedFailure: "decisions.origin.observedFailure",
  repairPattern: "decisions.origin.repairPattern",
  failurePattern: "decisions.origin.failurePattern",
  successPattern: "decisions.origin.successPattern",
  authoringPattern: "decisions.origin.authoringPattern",
  sessionPattern: "decisions.origin.sessionPattern",
  chainedPattern: "decisions.origin.chainedPattern",
  recurringPattern: "decisions.origin.recurringPattern",
  conversation: "decisions.origin.conversation",
};

const CONFIDENCE_LABEL: Record<"low" | "medium" | "high", TranslationKey> = {
  low: "decisions.confidence.low",
  medium: "decisions.confidence.medium",
  high: "decisions.confidence.high",
};

/** How much time is left, in the coarsest honest unit. */
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

type Translate = ReturnType<typeof useI18n>["t"];

/** True when expanding this card would actually show something. */
function detailHasContent(item: DecidableItem): boolean {
  const detail = item.detail;
  if (detail.kind === "patch") return true;
  return detail.body.trim().length > 0;
}

/** Translate one decision's raw evidence into the two context columns. */
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
        ? t("decisions.evidence", { count: String(item.evidenceCount) })
        : "",
  };
  const detail = item.detail;
  if (detail.kind === "patch") {
    const causeKey = driftKindKey(detail.evidence.driftKind);
    return patchContext(
      detail.evidence,
      { ...labels, cause: causeKey ? t(causeKey) : null },
      names,
      canReadRuns,
    );
  }
  return skillContext(detail.evidence, labels, names);
}

/** The two columns: what produced this, and what a decision would act on. */
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
            {/* An endpoint key is engine prose and routinely embeds an id. */}
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

/** A labelled block of raw evidence. Renders nothing when there is none — an
 *  empty heading claims the engine recorded something it did not. */
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

/** Free text from the engine, with ids taken out. Reasoning, drift output and
 *  skill bodies all quote real records; none of it may put an id on screen. */
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

/**
 * What the convention calls for when a row is expanded: the full reasoning and
 * the raw source data (§8.4). Every field below already arrived with the list —
 * a reviewer was being asked to approve a change whose justification, whose
 * observed cause and whose actual text were all one property away.
 */
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
        {evidence.classificationReasons.length > 0 && (
          <DetailBlock heading={t("decisions.detail.classification")}>
            <DetailList items={evidence.classificationReasons} />
          </DetailBlock>
        )}
        {/* Why earlier attempts were dropped is the most honest account of why a
            proposal is still rated unsafe. */}
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
          <DetailText className="max-w-prose text-sm break-words whitespace-pre-wrap">
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

/** The runs a proposed skill was distilled from. The count was always on the
 *  card; the cases themselves were recorded, indexed, and read by nothing. */
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
        <p className="text-sm text-destructive">{t("decisions.detail.evidenceFailed")}</p>
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
              {/* A run the person cannot open is not linked — the permission is
                  evaluated per object, so the link would lead to a refusal. */}
              {entry.execution_id && canReadRuns && (
                <Link
                  to="/runs"
                  className="underline underline-offset-2"
                  data-testid={`${testId}-evidence-run-${index}`}
                >
                  {t("decisions.context.failedRun")}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </DetailBlock>
  );
}

export interface DecisionCardProps {
  item: DecidableItem;
  index: number;
  canDecide: boolean;
  busy: boolean;
  compact?: boolean;
  onApprove: (item: DecisionItem, reviewDigest?: string) => void;
  onReject: (item: DecisionItem, reason: string) => void;
  testIdPrefix?: string;
  /** Resolves the ids on this decision to names. Without it the context columns
   *  still render — they just say "Workflow" where they could say which one. */
  names?: NameIndex;
  /** Whether this person may open a run. The permission is evaluated per
   *  object, so a link for someone without it leads to a refusal. */
  canReadRuns?: boolean;
  priority: "urgent" | "normal";
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

  const preview = useQuery({
    queryKey: ["patch-candidate", "preview", item.id],
    enabled: showDiff,
    queryFn: () => getPatchCandidatePreview(item.id),
  });
  // Replaying needs a recorded response; without one the call only 409s.
  const dryRun = useQuery({
    queryKey: ["patch-candidate", "dry-run", item.id],
    enabled: showDiff && preview.data?.fixture_available === true,
    retry: false,
    queryFn: () => dryRunPatchCandidate(item.id),
  });

  return (
    // The collapsed row follows the family anatomy: context, decision,
    // consequence, then disclosure and actions. The detailed evidence remains
    // one click away, but every product now gives the same amount of space to
    // the decision a person has to scan.
    <article
      className={cn(
        "@container flex min-h-[162px] flex-col gap-1.5 rounded-2xl border border-l-2 p-3",
        priority === "urgent" ? "border-l-warning" : "border-l-border",
      )}
      data-testid={testId}
      data-decision-key={key}
      data-state="open"
      data-family-slot="decision-row"
      data-family-decision-kind={item.kind}
      data-family-decision-priority={priority}
    >
      <div
        className="flex min-w-0 flex-col gap-2 @sm:flex-row @sm:items-start @sm:justify-between"
        data-family-slot="decision-meta"
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
          <span data-family-slot="decision-source">{t(ORIGIN_LABEL[item.origin])}</span>
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
        title={item.title}
        data-testid={`${testId}-title`}
        data-family-slot="decision-title"
      >
        {hideTechnicalIdentifiers(item.title, t("tool.referenceHiddenInline"))}
      </h3>

      <p className="truncate text-sm text-muted-foreground" data-family-slot="decision-effect">
        {t(KIND_EFFECT[item.kind])}
      </p>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
        <span data-family-slot="decision-details">
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
        <div
          className="flex min-w-0 flex-wrap items-center justify-end gap-2"
          data-family-slot="decision-actions"
        >
          {canDecide ? (
            <>
              {rejecting ? (
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
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  data-testid={`${testId}-reject`}
                  onClick={() => setRejecting(true)}
                >
                  {t("decisions.reject")}
                </Button>
              )}
              <Button
                size="sm"
                disabled={
                  busy ||
                  rejecting ||
                  !expanded ||
                  (item.kind === "skill" && !item.reviewDigest) ||
                  (item.kind === "patch" &&
                    (!preview.data?.reviewable || !preview.data?.review_digest))
                }
                data-testid={`${testId}-approve`}
                onClick={() => onApprove(item, preview.data?.review_digest ?? undefined)}
              >
                {t(item.kind === "skill" ? "decisions.activateSkill" : "decisions.approve")}
              </Button>
              {item.kind === "patch" &&
                expanded &&
                preview.data?.reviewable &&
                preview.data.base_version_id && (
                  <GrantWorkflowAuthority
                    workflowId={preview.data.workflow_id}
                    versionId={preview.data.base_version_id}
                    reviewContent={
                      <pre className="overflow-auto text-xs">
                        {JSON.stringify(
                          { before: preview.data.before_step, after: preview.data.after_step },
                          null,
                          2,
                        )}
                      </pre>
                    }
                    prepareVersion={async () => {
                      const prepared = await apiRequest<{ workflow_version_id: string }>(
                        `/v1/patch-candidates/${encodeURIComponent(item.id)}/prepare`,
                        {
                          method: "POST",
                          body: JSON.stringify({
                            expected_review_digest: preview.data?.review_digest,
                          }),
                        },
                      );
                      return prepared.workflow_version_id;
                    }}
                    onGrant={(input) =>
                      apiRequest(`/v1/patch-candidates/${encodeURIComponent(item.id)}/approve`, {
                        method: "POST",
                        body: JSON.stringify({
                          expected_review_digest: preview.data?.review_digest,
                          execution_authority: input,
                        }),
                      })
                    }
                  />
                )}
            </>
          ) : null}
        </div>
      </div>

      {rejecting && (
        <div className="border-t pt-3">
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("decisions.notePlaceholder")}
            data-testid={`${testId}-note`}
            aria-label={t("decisions.note")}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t("decisions.noteScope")}</p>
        </div>
      )}

      {expanded && (
        <div className="border-t pt-3">
          {/* Where this came from, before what it is: a position nobody can
              explain is a demand without a reason. */}
          <p className="text-xs text-muted-foreground" data-testid={`${testId}-origin`}>
            {t(ORIGIN_LABEL[item.origin])}
          </p>
          <p className="mt-1 max-w-prose text-sm font-medium break-words">
            {hideTechnicalIdentifiers(item.title, t("tool.referenceHiddenInline"))}
          </p>
          {/* What this position concretely is — the proposed change, the
              opening of the skill text. `title` is a name; this is the thing a
              person needs in order to choose. */}
          {item.summary && item.summary !== item.title && (
            <p
              className="mt-1 max-w-prose text-sm text-muted-foreground break-words"
              data-testid={`${testId}-summary`}
            >
              {hideTechnicalIdentifiers(item.summary, t("tool.referenceHiddenInline"))}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">{t(KIND_EFFECT[item.kind])}</p>
          {item.target ? (
            <p className="mt-1 text-xs text-muted-foreground" data-testid={`${testId}-target`}>
              {hideTechnicalIdentifiers(item.target, t("tool.referenceHiddenInline"))}
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground" data-testid={`${testId}-target`}>
              {t("decisions.target.allWorkflows")}
            </p>
          )}
          {item.confidence && (
            // A model's confidence is a claim, not a measurement: a word with
            // its scale named and the count it rests on, never a bar and never
            // the success colour.
            <p className="mt-1 text-xs text-muted-foreground" data-testid={`${testId}-confidence`}>
              {t("decisions.confidence", {
                level: t(CONFIDENCE_LABEL[item.confidence]),
              })}
              {item.evidenceCount !== null
                ? ` · ${t("decisions.evidence", { count: String(item.evidenceCount) })}`
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
                <p className="text-sm text-destructive" data-testid={`${testId}-diff-error`}>
                  {t("decisions.diffFailed")}
                </p>
              ) : (
                <DiffCard
                  testId={`${testId}-diff`}
                  embedded
                  targetLabel={item.target ?? t("decisions.kind.patch")}
                  before={preview.data.before_step}
                  after={preview.data.after_step}
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
    </article>
  );
}
