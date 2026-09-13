import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

import { apiRequest } from "@/api/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/lib/i18n-context";
import {
  AUTHORITY_EFFECT_KEYS,
  authorityGrantInput,
  type WorkflowAuthority,
  type WorkflowAuthorityPreview,
} from "@/lib/workflow-authorities";

export function GrantWorkflowAuthority({
  workflowId,
  versionId,
  prepareVersion,
  onGrant,
  reviewContent,
}: {
  workflowId: string;
  versionId: string;
  prepareVersion?: () => Promise<string>;
  onGrant?: (input: NonNullable<ReturnType<typeof authorityGrantInput>>) => Promise<unknown>;
  reviewContent?: ReactNode;
}) {
  const { t, dateTime } = useI18n();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [environment, setEnvironment] = useState<"dev" | "prod">("dev");
  const [runs, setRuns] = useState("");
  const [hours, setHours] = useState("");
  const [reviewVersionId, setReviewVersionId] = useState(versionId);
  const [review, setReview] = useState<WorkflowAuthorityPreview | null>(null);
  const prepare = useMutation({
    mutationFn: async (env: "dev" | "prod") => {
      const targetVersion = prepareVersion ? await prepareVersion() : versionId;
      setReviewVersionId(targetVersion);
      return apiRequest<WorkflowAuthorityPreview>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(targetVersion)}/authority-preview?environment=${env}`,
      );
    },
    onSuccess: (review) => {
      setRuns(String(review.suggested_bounds.max_runs));
      setHours(
        String(
          (Date.parse(review.suggested_bounds.valid_until) -
            Date.parse(review.suggested_bounds.valid_from)) /
            3_600_000,
        ),
      );
      setReview(review);
    },
  });
  const expected = { workflowId, versionId: reviewVersionId, environment };
  const input = review ? authorityGrantInput(review, expected, runs, hours, Date.now()) : null;
  const grant = useMutation({
    mutationFn: () => {
      const checked = review
        ? authorityGrantInput(review, expected, runs, hours, Date.now())
        : null;
      if (!checked) throw new Error("authority_review_incomplete");
      if (onGrant) return onGrant(checked);
      return apiRequest<WorkflowAuthority>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/execution-authorities`,
        {
          method: "POST",
          body: JSON.stringify(checked),
        },
      );
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["workflow-authorities", workflowId] });
      await client.invalidateQueries({ queryKey: ["decisions"] });
      await client.invalidateQueries({ queryKey: ["operational-overview"] });
      await client.invalidateQueries({ queryKey: ["patch-candidate"] });
      setOpen(false);
    },
  });
  const busy = prepare.isPending || grant.isPending;
  function openDialog(value: boolean) {
    if (busy) return;
    setOpen(value);
    setReview(null);
    prepare.reset();
    grant.reset();
    if (value) {
      setEnvironment("dev");
      prepare.mutate("dev");
    }
  }
  return (
    <Dialog open={open} onOpenChange={openDialog}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="authority-grant-open">
          {t(onGrant ? "decisions.applyAndAuthorize" : "authority.grantOpen")}
        </Button>
      </DialogTrigger>
      <DialogContent
        closeLabel={t("common.close")}
        className="flex max-h-[85svh] flex-col overflow-hidden sm:max-w-2xl"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {t(onGrant ? "decisions.applyAndAuthorize" : "authority.grantOpen")}
          </DialogTitle>
          <DialogDescription>
            {t(onGrant ? "decisions.applyAndAuthorizeDescription" : "authority.grantDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          {reviewContent}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="authority-environment">{t("authority.environment")}</FieldLabel>
              <Select
                value={environment}
                disabled={busy}
                onValueChange={(value) => {
                  if (value !== "dev" && value !== "prod") return;
                  setEnvironment(value);
                  setReview(null);
                  grant.reset();
                  prepare.reset();
                  prepare.mutate(value);
                }}
              >
                <SelectTrigger id="authority-environment" data-testid="authority-environment">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="dev" data-testid="authority-environment-dev">
                      {t("authority.development")}
                    </SelectItem>
                    <SelectItem value="prod" data-testid="authority-environment-prod">
                      {t("authority.production")}
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            {review && (
              <>
                <Field data-invalid={!input}>
                  <FieldLabel htmlFor="authority-runs">{t("authority.runs")}</FieldLabel>
                  <Input
                    id="authority-runs"
                    data-testid="authority-runs"
                    type="number"
                    min={1}
                    max={10000}
                    step={1}
                    value={runs}
                    disabled={busy}
                    aria-invalid={!input}
                    onChange={(event) => setRuns(event.target.value)}
                  />
                </Field>
                <Field data-invalid={!input}>
                  <FieldLabel htmlFor="authority-hours">{t("authority.hours")}</FieldLabel>
                  <Input
                    id="authority-hours"
                    data-testid="authority-hours"
                    type="number"
                    min={1}
                    max={744}
                    step={1}
                    value={hours}
                    disabled={busy}
                    aria-invalid={!input}
                    onChange={(event) => setHours(event.target.value)}
                  />
                </Field>
              </>
            )}
          </FieldGroup>
          {prepare.isPending && <p role="status">{t("common.loading")}</p>}
          {prepare.error && (
            <Alert variant="destructive">
              <AlertTitle>{t("authority.loadFailed")}</AlertTitle>
              <AlertDescription>{t("authority.retryDescription")}</AlertDescription>
            </Alert>
          )}
          {review && (
            <div className="flex min-w-0 flex-col gap-4" data-testid="authority-grant-review">
              <p className="break-all text-sm">
                {t("authority.version")}
                {": "}
                {review.manifest.workflow_version_id}
              </p>
              {input && (
                <p className="text-sm">
                  {t("authority.window")}
                  {": "}
                  {dateTime(input.valid_from)}
                  {" — "}
                  {dateTime(input.valid_until)}
                </p>
              )}
              <Alert>
                <AlertTitle>{t("authority.runNotRequest")}</AlertTitle>
                <AlertDescription>{t("authority.runNotRequestDescription")}</AlertDescription>
              </Alert>
              {review.manifest.effects.map((effect) => (
                <div key={effect.step_id} className="min-w-0 text-sm">
                  <p className="font-medium">
                    {effect.step_id}
                    {" · "}
                    {t(AUTHORITY_EFFECT_KEYS[effect.effect])}
                    {" · "}
                    {effect.operation}
                  </p>
                  <p className="break-all">
                    {t("authority.connector")}
                    {": "}
                    {effect.connector_id ?? t("authority.directRequest")}
                  </p>
                  <p className="break-all">{effect.target ?? t("authority.unboundTarget")}</p>
                </div>
              ))}
              {review.execution_shape.requests.map((request) => (
                <details key={request.step_id}>
                  <summary className="cursor-pointer text-sm font-medium">
                    {t("authority.requestReview", { step: request.step_id })}
                  </summary>
                  <p className="my-2 text-sm">
                    {t("authority.attempts", {
                      count: request.retry_policy_max_attempts ?? t("common.unknown"),
                    })}
                  </p>
                  <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap break-all">
                    {request.redacted_request_json}
                  </pre>
                </details>
              ))}
              {review.execution_shape.iterations.map((iteration) => (
                <p key={`${iteration.step_id}:${iteration.kind}`} className="break-words text-sm">
                  {t("authority.iteration", {
                    step: iteration.step_id,
                    children: iteration.body_step_ids.join(", "),
                  })}
                </p>
              ))}
              <p className="text-sm text-muted-foreground">{t("authority.maskedDescription")}</p>
              <p className="break-all font-mono text-xs">
                {t("authority.digest")}
                {": "}
                {review.digest}
              </p>
              {!input && (
                <Alert variant="destructive">
                  <AlertTitle>{t("authority.cannotGrant")}</AlertTitle>
                  <AlertDescription>{t("authority.cannotGrantDescription")}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
          {grant.error && (
            <Alert variant="destructive">
              <AlertTitle>{t("authority.grantFailed")}</AlertTitle>
              <AlertDescription>{t("authority.grantFailedDescription")}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter className="shrink-0">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => openDialog(false)}
            data-testid="authority-grant-cancel"
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              grant.reset();
              setReview(null);
              prepare.reset();
              prepare.mutate(environment);
            }}
            data-testid="authority-prepare"
          >
            {t("authority.prepare")}
          </Button>
          <Button
            disabled={busy || !input || Boolean(grant.error)}
            onClick={() => grant.mutate()}
            data-testid="authority-grant-confirm"
          >
            {t(
              grant.isPending
                ? "authority.granting"
                : onGrant
                  ? "decisions.applyAndAuthorize"
                  : Number(runs) === 1
                    ? "authority.grantConfirmOne"
                    : "authority.grantConfirm",
              { count: runs },
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
