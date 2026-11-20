import { Check, ChevronRight, Save, X } from "lucide-react";
import { useId } from "react";
import { GRANT_LIMIT_MEANINGS, GrantLimitField } from "@/components/cockpit/grant-limit-field";
import { IconButton } from "@/components/cockpit/icon-button";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  REVIEW_DIALOG_FRAME,
  SectionHeading,
  SectionSubheading,
  Spinner,
} from "@/components/cockpit/patterns";
import type { GrantLimit } from "@/lib/core/authority-decision";
import { useI18n } from "@/lib/i18n-context";
import { formatWeeklyWorkflowReviewSchedule } from "@/lib/workflow-review-schedule";

export type WorkflowReviewState =
  | "preparing"
  | "ready"
  | "completing"
  | "completed"
  | "stale"
  | "expired"
  | "failed"
  | "uncertain"
  | "blocked";

export interface WorkflowReviewDisplay {
  workflow_name: string;
  workflow_slug: string | null;
  reviewed_version_label: string;
  description: string;
  checks: string[];
  environment: string;
  effects: Array<{
    step_id: string;
    connector_name: string;
    connector_slug: string;
    effect: string;
    target: string;
    details?: string[];
  }>;
  affected_triggers: Array<{
    id: string;
    kind: string;
    name: string;
    cron?: string;
    timezone?: string;
  }>;
  grant: { limit: GrantLimit } | null;
  schedule: { cron: string; timezone: string } | null;
}

export function WorkflowReviewDialog({
  open,
  onOpenChange,
  review,
  state,
  message,
  grantSelected,
  scheduleSelected,
  remember,
  policyBusy,
  policyAvailable = true,
  onGrantChange,
  onLimitChange,
  onScheduleChange,
  onRememberChange,
  onComplete,
  onRefresh,
  onCheckResult,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  review: WorkflowReviewDisplay | null;
  state: WorkflowReviewState;
  message?: string;
  grantSelected: boolean;
  scheduleSelected: boolean;
  remember: boolean;
  policyBusy: boolean;
  policyAvailable?: boolean;
  onGrantChange: (checked: boolean) => void;
  onLimitChange: (limit: GrantLimit) => void;
  onScheduleChange: (checked: boolean) => void;
  onRememberChange: (checked: boolean) => void;
  onComplete: (saveOnly: boolean) => void;
  onRefresh: () => void;
  onCheckResult: () => void;
}) {
  const { t, locale } = useI18n();
  const id = useId();
  const scheduleLabel = review?.schedule
    ? (formatWeeklyWorkflowReviewSchedule(review.schedule.cron, locale) ?? review.schedule.cron)
    : null;
  const busy = state === "preparing" || state === "completing";
  const ready = state === "ready";
  const terminal = state === "completed" || state === "uncertain";
  const editable = ready && !policyBusy;
  const canComplete = ready && !policyBusy && (!scheduleSelected || grantSelected);
  const stateLabel = state === "blocked" ? message : t(`reviewWorkflow.${state}`);
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        className={REVIEW_DIALOG_FRAME}
        closeLabel={t("common.close")}
        showCloseButton={false}
        overlayClassName="bg-black/60 supports-backdrop-filter:backdrop-blur-none"
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
        onInteractOutside={(event) => busy && event.preventDefault()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border p-6">
          <div>
            <DialogTitle className="text-base font-semibold">
              {t("reviewWorkflow.title")}
            </DialogTitle>
            <DialogDescription className="mt-1">
              {review
                ? `${review.workflow_slug ? `@${review.workflow_slug}` : review.workflow_name} · ${review.reviewed_version_label}`
                : t("reviewWorkflow.preparing")}
            </DialogDescription>
          </div>
          <IconButton
            label={t("common.close")}
            size="icon"
            disabled={busy}
            data-testid="workflow-review-close"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" aria-hidden="true" />
          </IconButton>
        </header>
        <div className="min-h-0 space-y-5 overflow-auto p-4 md:p-6">
          <div
            role="status"
            aria-live="polite"
            className={
              ready || state === "completed"
                ? "flex items-center gap-2 text-xs text-success"
                : "flex items-center gap-2 text-xs text-muted-foreground"
            }
          >
            {busy ? (
              <Spinner aria-hidden="true" aria-label={undefined} />
            ) : ready || state === "completed" ? (
              <Check className="size-4" aria-hidden="true" />
            ) : null}
            {stateLabel}
          </div>
          {message && state !== "blocked" && (
            <p role="alert" className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
              {message}
            </p>
          )}
          {state === "completed" && (
            <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
              {t(grantSelected ? "reviewWorkflow.completedGrant" : "reviewWorkflow.savedOnly")}
            </p>
          )}
          {review && (
            <>
              <section className="space-y-2">
                <SectionHeading className="text-sm font-medium">
                  {t("reviewWorkflow.changes")}
                </SectionHeading>
                <p className="text-sm text-muted-foreground">
                  {review.description || review.workflow_name}
                </p>
                {review.checks.length > 0 && (
                  <details className="group text-sm">
                    <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
                      <ChevronRight
                        className="size-4 transition-transform group-open:rotate-90"
                        aria-hidden="true"
                      />
                      {t("reviewWorkflow.details")}
                    </summary>
                    <ul className="mt-2 space-y-2 rounded-md border border-border p-3 text-muted-foreground">
                      {review.checks.map((check) => (
                        <li key={check}>{check}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </section>
              <section className="space-y-3 border-t border-border pt-4">
                <SectionHeading className="text-sm font-medium">
                  {t("reviewWorkflow.onCompletion")}
                </SectionHeading>
                <div className="flex gap-3 text-sm">
                  <Save className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
                  <span>{t("reviewWorkflow.saveDraft")}</span>
                </div>
                <Field orientation="horizontal" className="gap-3">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 accent-blue-400 [color-scheme:light]"
                    id={`${id}-grant`}
                    checked={grantSelected}
                    disabled={!editable || !review.grant}
                    onChange={(event) => onGrantChange(event.target.checked)}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor={`${id}-grant`}>{t("reviewWorkflow.grant")}</FieldLabel>
                    <FieldDescription className="text-xs">
                      {t("reviewWorkflow.grantHint")}
                    </FieldDescription>
                  </FieldContent>
                </Field>
                {grantSelected && review.grant && (
                  <div className="space-y-4 rounded-lg border border-border p-4">
                    <div className="flex items-center justify-between gap-3">
                      <SectionSubheading>{t("reviewWorkflow.environment")}</SectionSubheading>
                      <span className="text-sm">{review.environment}</span>
                    </div>
                    <ul
                      aria-label={t("reviewWorkflow.effects")}
                      className="space-y-3 border-t border-border pt-3 text-sm"
                    >
                      {review.effects.map((effect) => (
                        <li key={effect.step_id} className="space-y-1">
                          <div className="flex flex-wrap justify-between gap-2">
                            <span>
                              {effect.connector_slug
                                ? `@${effect.connector_slug}`
                                : effect.connector_name}
                            </span>
                            <span className="break-all text-muted-foreground">
                              {effect.effect} · {effect.target}
                            </span>
                          </div>
                          {effect.details?.map((detail) => (
                            <p key={detail} className="break-words text-xs text-muted-foreground">
                              {detail}
                            </p>
                          ))}
                        </li>
                      ))}
                    </ul>
                    <Field className="border-t border-border pt-3">
                      <GrantLimitField
                        limit={review.grant.limit}
                        disabled={!editable}
                        readOnly={state === "completed"}
                        onChange={onLimitChange}
                        testId="workflow-review-limit"
                      />
                      <FieldDescription
                        className="text-xs"
                        data-testid="workflow-review-limit-meaning"
                      >
                        {t(GRANT_LIMIT_MEANINGS[review.grant.limit])}
                      </FieldDescription>
                    </Field>
                    <div className="border-t border-border pt-3">
                      <SectionSubheading>{t("reviewWorkflow.triggers")}</SectionSubheading>
                      {review.affected_triggers.length ? (
                        <>
                          <ul className="mt-2 space-y-2 text-sm text-muted-foreground">
                            {review.affected_triggers.map((trigger) => (
                              <li key={trigger.id}>
                                {t(
                                  trigger.kind === "webhook"
                                    ? "reviewWorkflow.webhookType"
                                    : "reviewWorkflow.scheduleType",
                                )}
                                : {trigger.name}
                                {trigger.cron
                                  ? ` · ${formatWeeklyWorkflowReviewSchedule(trigger.cron, locale) ?? trigger.cron}`
                                  : ""}
                                {trigger.timezone ? ` · ${trigger.timezone}` : ""}
                              </li>
                            ))}
                          </ul>
                          <p className="mt-2 text-xs text-warning">
                            {t("reviewWorkflow.triggersHint")}
                          </p>
                        </>
                      ) : (
                        <p className="mt-2 text-sm text-muted-foreground">
                          {t("reviewWorkflow.noTriggers")}
                        </p>
                      )}
                    </div>
                  </div>
                )}
                {review.schedule && (
                  <Field orientation="horizontal" className="gap-3">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 shrink-0 accent-blue-400 [color-scheme:light]"
                      id={`${id}-schedule`}
                      checked={scheduleSelected}
                      disabled={!editable}
                      onChange={(event) => onScheduleChange(event.target.checked)}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor={`${id}-schedule`}>
                        {t("reviewWorkflow.scheduleAt", {
                          when: scheduleLabel ?? review.schedule.cron,
                        })}
                      </FieldLabel>
                      <FieldDescription className="text-xs">
                        {review.schedule.timezone}
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                )}
                {scheduleSelected && !grantSelected && (
                  <p className="text-xs text-warning">{t("reviewWorkflow.scheduleHint")}</p>
                )}
              </section>
              <details className="group border-t border-border pt-4">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-sm [&::-webkit-details-marker]:hidden">
                  <ChevronRight
                    className="size-4 transition-transform group-open:rotate-90"
                    aria-hidden="true"
                  />
                  {t("reviewWorkflow.rememberTitle")}
                </summary>
                <div className="mt-3 space-y-2">
                  <Field orientation="horizontal" className="gap-3">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 shrink-0 accent-blue-400 [color-scheme:light]"
                      id={`${id}-remember`}
                      checked={remember}
                      disabled={!editable || !policyAvailable}
                      onChange={(event) => onRememberChange(event.target.checked)}
                    />
                    <FieldLabel htmlFor={`${id}-remember`} className="font-normal">
                      {t("reviewWorkflow.remember")}
                    </FieldLabel>
                  </Field>
                  <p className="text-xs text-muted-foreground">
                    {t("reviewWorkflow.rememberHint")}
                  </p>
                  <Button
                    variant="link"
                    size="sm"
                    data-testid="workflow-review-ask-again"
                    disabled={!editable || !policyAvailable || !remember}
                    onClick={() => onRememberChange(false)}
                    className="h-auto p-0 text-xs"
                  >
                    {t("reviewWorkflow.askAgain")}
                  </Button>
                </div>
              </details>
            </>
          )}
        </div>
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border p-4 [&>button]:h-auto [&>button]:rounded-lg [&>button]:py-2 [&>button]:max-md:flex-1">
          {state === "uncertain" ? (
            <Button data-testid="workflow-review-check-result" onClick={onCheckResult}>
              {t("reviewWorkflow.checkResult")}
            </Button>
          ) : state === "stale" ||
            state === "expired" ||
            state === "failed" ||
            state === "blocked" ? (
            <Button data-testid="workflow-review-refresh" onClick={onRefresh}>
              {t("reviewWorkflow.refresh")}
            </Button>
          ) : terminal ? (
            <Button
              data-testid="workflow-review-complete-close"
              onClick={() => onOpenChange(false)}
            >
              {t("common.close")}
            </Button>
          ) : (
            <>
              {(grantSelected || scheduleSelected) && (
                <Button
                  variant="outline"
                  data-testid="workflow-review-save-only"
                  disabled={!ready || policyBusy}
                  onClick={() => onComplete(true)}
                >
                  {t("reviewWorkflow.saveOnly")}
                </Button>
              )}
              <Button
                data-testid="workflow-review-confirm"
                disabled={!canComplete}
                onClick={() => onComplete(false)}
              >
                {t(
                  state === "completing"
                    ? "reviewWorkflow.completing"
                    : scheduleSelected
                      ? "reviewWorkflow.confirmSchedule"
                      : grantSelected
                        ? "reviewWorkflow.confirmGrant"
                        : "reviewWorkflow.confirmSave",
                )}
              </Button>
            </>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
