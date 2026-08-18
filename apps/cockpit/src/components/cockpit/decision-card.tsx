import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { dryRunPatchCandidate, getPatchCandidatePreview } from "@/api/decisions";
import { DiffCard } from "@/components/cockpit/diff-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import type { DecisionItem, DecisionKind, DecisionOrigin } from "@/pages/decisions-model";
import { ageInDays } from "@/pages/decisions-model";

const KIND_LABEL: Record<DecisionKind, TranslationKey> = {
  patch: "decisions.kind.patch",
  skill: "decisions.kind.skill",
  conversation: "decisions.kind.conversation",
};

const KIND_EFFECT: Record<DecisionKind, TranslationKey> = {
  patch: "decisions.effect.patch",
  skill: "decisions.effect.skill",
  conversation: "decisions.effect.conversation",
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

export interface DecisionCardProps {
  item: DecisionItem;
  index: number;
  canDecide: boolean;
  busy: boolean;
  compact?: boolean;
  onApprove: (item: DecisionItem) => void;
  onReject: (item: DecisionItem, reason: string) => void;
  testIdPrefix?: string;
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
}: DecisionCardProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const testId = `${testIdPrefix}-${index}`;
  const now = Date.now();
  const age = ageInDays(item.waitingSince, now);
  const deadline = deadlineLabel(item.expiresAt, now, t);
  const showDiff = expanded && item.kind === "patch";

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
    <article className="rounded-lg border p-4" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
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
        {item.target ? (
          // `truncate` sets `white-space: nowrap`, so a flex item without a
          // width bound takes its intrinsic width and pushes the whole column
          // sideways instead of ellipsing. The bound is what makes it truncate.
          <span className="min-w-0 max-w-[22ch] truncate" data-testid={`${testId}-target`}>
            {hideTechnicalIdentifiers(item.target, t("tool.referenceHiddenInline"))}
          </span>
        ) : (
          <span data-testid={`${testId}-target`}>
            {t(
              item.kind === "conversation"
                ? "decisions.target.none"
                : "decisions.target.allWorkflows",
            )}
          </span>
        )}
        <span data-testid={`${testId}-age`}>
          {age === 0
            ? t("decisions.age.today")
            : age === 1
              ? t("decisions.age.day")
              : t("decisions.age.days", { days: String(age) })}
        </span>
        {deadline && (
          <span
            className={deadline.expired ? "text-destructive" : "text-warning"}
            data-testid={`${testId}-deadline`}
          >
            {deadline.label}
          </span>
        )}
      </div>

      {/* Where this came from, before what it is: a position nobody can explain
          is a demand without a reason, and that is what "where do the 118 come
          from" was asking. */}
      <p className="mt-2 text-xs text-muted-foreground" data-testid={`${testId}-origin`}>
        {t(ORIGIN_LABEL[item.origin])}
      </p>

      <p
        className="mt-2 line-clamp-2 text-sm font-medium break-words"
        data-testid={`${testId}-title`}
      >
        {hideTechnicalIdentifiers(item.title, t("tool.referenceHiddenInline"))}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{t(KIND_EFFECT[item.kind])}</p>
      {item.confidence && (
        // A model's confidence is a claim, not a measurement: a word with its
        // scale named and the count it rests on, never a bar and never the
        // success colour.
        <p className="mt-1 text-xs text-muted-foreground" data-testid={`${testId}-confidence`}>
          {t("decisions.confidence", { level: t(CONFIDENCE_LABEL[item.confidence]) })}
          {item.evidenceCount !== null
            ? ` · ${t("decisions.evidence", { count: String(item.evidenceCount) })}`
            : ""}
        </p>
      )}

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

      {rejecting && (
        <div className="mt-3">
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

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {item.kind === "patch" && !compact && (
            <Button
              variant="ghost"
              size="sm"
              data-testid={`${testId}-toggle`}
              onClick={() => setExpanded((value) => !value)}
            >
              {t(expanded ? "decisions.showLess" : "decisions.showMore")}
            </Button>
          )}
          {item.kind === "conversation" && (
            <Button variant="ghost" size="sm" asChild>
              <Link
                to="/chat/$conversationId"
                params={{ conversationId: item.id }}
                data-testid={`${testId}-source`}
              >
                {t("decisions.openSource")}
              </Link>
            </Button>
          )}
        </div>

        {canDecide && item.kind !== "conversation" && (
          <div className="flex flex-wrap items-center gap-2">
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
              disabled={busy || rejecting}
              data-testid={`${testId}-approve`}
              onClick={() => onApprove(item)}
            >
              {t("decisions.approve")}
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}
