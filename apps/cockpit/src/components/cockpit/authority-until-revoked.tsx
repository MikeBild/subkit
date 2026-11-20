import { useState } from "react";
import { apiCall } from "@/api/call";
import { ActionButton, ConfirmDialog } from "@/components/cockpit/patterns";
import type { AuthorityReviewModel } from "@/lib/authority-review-model";
import { automationQueryKeys } from "@/lib/automation-queries";
import { formatDateTime } from "@/lib/i18n";
import { type I18nValue, useI18n } from "@/lib/i18n-context";
import { type AuthorityPages, withAuthorityUntilRevoked } from "@/lib/optimistic-authorities";
import { useOptimisticAction } from "@/lib/use-optimistic-action";
import type { WorkflowAuthority } from "@/lib/workflow-authorities";

type Tiles = AuthorityReviewModel["tiles"];
type Plural = ReturnType<typeof useI18n>["tn"];

export function untilRevokedCounts(tiles: Tiles, tn: Plural): string {
  return [
    tiles.read > 0 ? tn("workflowApprovals.untilRevoked.count.read", tiles.read) : null,
    tiles.write > 0 ? tn("workflowApprovals.untilRevoked.count.write", tiles.write) : null,
    tiles.risky > 0 ? tn("workflowApprovals.untilRevoked.count.risky", tiles.risky) : null,
    tn("workflowApprovals.untilRevoked.count.services", tiles.services),
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
}

export function authorityValidity(
  authority: WorkflowAuthority,
  i18n: Pick<I18nValue, "t" | "tn" | "dateTime">,
): string {
  if (authority.valid_until !== null)
    return i18n.t("workflowApprovals.validity.until", {
      until: i18n.dateTime(authority.valid_until),
    });
  if (authority.open_ended || authority.remaining_runs === null)
    return i18n.t("workflowApprovals.validity.untilRevoked");
  return i18n.tn("workflowApprovals.validity.runs", authority.remaining_runs);
}

export function UntilRevokedHint({
  days,
  remainingRuns,
}: {
  days: number | null;
  remainingRuns: number | null;
}) {
  const { tn } = useI18n();
  return (
    <p
      className="text-sm text-amber-700 dark:text-amber-400"
      data-testid="authority-until-revoked-hint"
    >
      {days === null
        ? tn("workflowApprovals.untilRevoked.hintRuns", remainingRuns ?? 0)
        : tn("workflowApprovals.untilRevoked.hint", days)}
    </p>
  );
}

export function UntilRevokedDone() {
  const { t } = useI18n();
  return (
    <p
      role="status"
      className="text-sm text-emerald-700 dark:text-emerald-400"
      data-testid="authority-until-revoked-done"
    >
      {t("workflowApprovals.untilRevoked.done")}
    </p>
  );
}

export function MakeUntilRevoked({
  authority,
  subject,
  tiles,
  onDone,
}: {
  authority: WorkflowAuthority;
  subject: string;
  tiles: Tiles | null;
  onDone(): void;
}) {
  const { t, tn, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const change = useOptimisticAction({
    queryKey: ["workflow-authorities", authority.workflow_id],
    mutationFn: () =>
      apiCall("post", "/v1/workflows/{id}/execution-authorities/{authority_id}/until-revoked", {
        path: { id: authority.workflow_id, authority_id: authority.id },
        body: { expected_manifest_digest: authority.effect_manifest_digest },
      }),

    apply: (current: AuthorityPages | undefined) =>
      withAuthorityUntilRevoked(current, authority.id),
    invalidate: [
      ...automationQueryKeys(authority.workflow_id).filter(
        (key) => key[0] !== "workflow-authorities" || key.length > 2,
      ),
      ["attention"],
    ],
    errorMessage: () => t("workflowApprovals.untilRevoked.failed"),
    onSuccess: () => {
      setOpen(false);
      onDone();
    },
  });
  const onlyRunLimit = authority.valid_until === null && authority.max_runs !== null;
  const action = t(
    onlyRunLimit
      ? "workflowApprovals.untilRevoked.actionRuns"
      : "workflowApprovals.untilRevoked.action",
  );
  return (
    <>
      <ActionButton
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        testId="authority-until-revoked"
      >
        {action}
      </ActionButton>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => !change.isPending && setOpen(next)}
        object={t(
          onlyRunLimit
            ? "workflowApprovals.untilRevoked.objectRuns"
            : "workflowApprovals.untilRevoked.object",
        )}
        verb={onlyRunLimit ? t("workflowApprovals.untilRevoked.verbRuns") : action}
        consequence={
          authority.valid_until === null
            ? t("workflowApprovals.untilRevoked.consequenceRuns", { subject })
            : t("workflowApprovals.untilRevoked.consequence", {
                subject,
                until: formatDateTime(locale, authority.valid_until),
              })
        }
        points={[
          ...(tiles
            ? [
                t("workflowApprovals.untilRevoked.same", {
                  counts: untilRevokedCounts(tiles, tn),
                }),
              ]
            : []),
          ...(authority.valid_until !== null && authority.max_runs !== null
            ? [t("workflowApprovals.untilRevoked.limitLifted")]
            : []),
          t("workflowApprovals.untilRevoked.runs"),
          t("workflowApprovals.untilRevoked.revocable"),
        ]}
        pending={change.isPending}
        onConfirm={async () => {
          await change.mutateAsync(undefined).catch(() => undefined);
        }}
        testId="authority-until-revoked-confirm"
      />
    </>
  );
}
