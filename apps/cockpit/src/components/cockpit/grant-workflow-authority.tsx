import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { useSession } from "@/app/session";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
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
  activation,
  onCompleted,
  onSingleRun,
  onAdjust,
  prepareVersion,
  onGrant,
  reviewContent,
  initialEnvironment = "dev",
  versionLabel,
  disabled = false,
  triggerLabel,
  triggerTestId = "authority-grant-open",
}: {
  workflowId: string;
  versionId: string;
  activation?: { expected_current_version_id: string | null };
  onCompleted?: () => void;
  onSingleRun?: () => void;
  onAdjust?: () => void;
  prepareVersion?: () => Promise<string>;
  onGrant?: (input: NonNullable<ReturnType<typeof authorityGrantInput>>) => Promise<unknown>;
  reviewContent?: ReactNode;
  initialEnvironment?: "dev" | "prod";
  versionLabel?: string;
  disabled?: boolean;
  triggerLabel?: string;
  triggerTestId?: string;
}) {
  const { t, dateTime } = useI18n();
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const session = useSession();
  const connectors = useQuery({
    queryKey: ["authority-connector-names"],
    enabled: open && session.permissions.includes("connector:read"),
    staleTime: 300_000,
    queryFn: () =>
      apiRequest<{ items: { id: string; name: string }[] }>("/v1/connectors?limit=200"),
  });
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
          body: JSON.stringify({ ...checked, ...(activation ? { activation } : {}) }),
        },
      );
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["workflow-authorities", workflowId] });
      await client.invalidateQueries({ queryKey: ["decisions"] });
      await client.invalidateQueries({ queryKey: ["operational-overview"] });
      await client.invalidateQueries({ queryKey: ["patch-candidate"] });
      await client.invalidateQueries({ queryKey: ["workflow-schedule-holds"] });
      await client.invalidateQueries({ queryKey: ["chat-automation-workflow", workflowId] });
      await client.invalidateQueries({ queryKey: ["conversation"] });
      await client.invalidateQueries({ queryKey: ["workflows"] });
      onCompleted?.();
      setOpen(false);
      toast.success(t(activation ? "chat.activation.saved" : "authority.grantSaved"));
    },
  });
  const activateOnly = useMutation({
    mutationFn: async () => {
      if (!review || !activation) throw new Error("activation_review_missing");
      return apiRequest(`/v1/workflows/${encodeURIComponent(workflowId)}/activate-draft`, {
        method: "POST",
        body: JSON.stringify({
          workflow_version_id: reviewVersionId,
          expected_current_version_id: activation.expected_current_version_id,
          expected_manifest_digest: review.digest,
          execution_environment: environment,
        }),
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["chat-automation-workflow", workflowId] });
      await client.invalidateQueries({ queryKey: ["conversation"] });
      setOpen(false);
      onSingleRun?.();
    },
  });
  const busy = prepare.isPending || grant.isPending || activateOnly.isPending;
  const unsupported = review && !review.eligible_for_repeated_runs;
  const incomplete = review?.execution_shape.requests.some(
    (request) => request.request_review_truncated || request.opaque_payload_omitted,
  );
  const invalidRuns = !Number.isInteger(Number(runs)) || Number(runs) < 1 || Number(runs) > 10000;
  const invalidHours = !Number.isInteger(Number(hours)) || Number(hours) < 1 || Number(hours) > 744;
  const boundsVisible = review && !unsupported && !incomplete;
  const adjustUrl = `/cockpit/chat/new?workflow_id=${encodeURIComponent(workflowId)}&prompt=${encodeURIComponent(t("authority.adjustPrompt"))}`;
  function openDialog(value: boolean) {
    if (busy) return;
    setOpen(value);
    setReview(null);
    prepare.reset();
    grant.reset();
    activateOnly.reset();
    if (value) {
      setEnvironment(initialEnvironment);
      prepare.mutate(initialEnvironment);
    }
  }
  return (
    <Dialog open={open} onOpenChange={openDialog}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} data-testid={triggerTestId}>
          {triggerLabel ?? t(onGrant ? "decisions.applyAndAuthorize" : "authority.grantOpen")}
        </Button>
      </DialogTrigger>
      <DialogContent
        closeLabel={t("common.close")}
        className="flex max-h-[85svh] flex-col overflow-hidden sm:max-w-2xl"
      >
        <DialogHeader className="-mx-4 -mt-4 shrink-0 bg-accent/10 px-4 py-4 pr-12">
          <DialogTitle>
            {t(
              unsupported
                ? onSingleRun
                  ? "chat.activation.singleTitle"
                  : "authority.adjustTitle"
                : activation
                  ? "chat.activation.title"
                  : onGrant
                    ? "decisions.applyAndAuthorize"
                    : "authority.grantOpen",
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              unsupported
                ? onSingleRun
                  ? "chat.activation.singleHelp"
                  : "authority.adjustDescription"
                : activation
                  ? "chat.activation.description"
                  : onGrant
                    ? "decisions.applyAndAuthorizeDescription"
                    : "authority.grantDescription",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          {reviewContent}
          {unsupported && !onSingleRun && (
            <Alert data-testid="authority-needs-adjustment">
              <AlertTitle>{t("schedules.held.status")}</AlertTitle>
              <AlertDescription>
                {t(onSingleRun ? "chat.activation.singleHelp" : "authority.unsupportedSteps", {
                  steps: review?.unavailable_steps.join(", ") || t("authority.effects"),
                })}
              </AlertDescription>
            </Alert>
          )}
          {incomplete && (
            <Alert data-testid="authority-incomplete">
              <AlertTitle>{t("authority.incompleteTitle")}</AlertTitle>
              <AlertDescription>{t("authority.incompleteDescription")}</AlertDescription>
            </Alert>
          )}
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
            {boundsVisible && (
              <>
                <Field data-invalid={invalidRuns}>
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
                    aria-invalid={invalidRuns}
                    onChange={(event) => setRuns(event.target.value)}
                  />
                  {invalidRuns && <FieldError>{t("authority.runsError")}</FieldError>}
                </Field>
                <Field data-invalid={invalidHours}>
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
                    aria-invalid={invalidHours}
                    onChange={(event) => setHours(event.target.value)}
                  />
                  {invalidHours && <FieldError>{t("authority.hoursError")}</FieldError>}
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
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">{versionLabel ?? t("authority.reviewedVersion")}</Badge>
                <Badge variant="secondary">
                  {t(environment === "prod" ? "authority.production" : "authority.development")}
                </Badge>
              </div>
              {input && (
                <p className="text-sm">
                  {t("authority.window")}
                  {": "}
                  {dateTime(input.valid_from)}
                  {" — "}
                  {dateTime(input.valid_until)}
                </p>
              )}
              <details open={!unsupported} data-testid="authority-effect-details">
                <summary className="cursor-pointer text-sm font-medium">
                  {t("authority.effects")}
                </summary>
                <div className="mt-3 flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">
                    {t("authority.runNotRequestDescription")}
                  </p>
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
                        {effect.connector_id
                          ? (connectors.data?.items.find(
                              (connector) => connector.id === effect.connector_id,
                            )?.name ?? t("authority.configuredConnector"))
                          : t("authority.directRequest")}
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
                    <p
                      key={`${iteration.step_id}:${iteration.kind}`}
                      className="break-words text-sm"
                    >
                      {t("authority.iteration", {
                        step: iteration.step_id,
                        children: iteration.body_step_ids.join(", "),
                      })}
                    </p>
                  ))}
                  <p className="text-sm text-muted-foreground">
                    {t("authority.maskedDescription")}
                  </p>
                </div>
              </details>
              {!input && boundsVisible && !invalidRuns && !invalidHours && (
                <Alert>
                  <AlertTitle>{t("authority.reviewExpired")}</AlertTitle>
                  <AlertDescription>{t("authority.reviewExpiredHint")}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
          {(grant.error || activateOnly.error) && (
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
          {(prepare.error ||
            grant.error ||
            incomplete ||
            (boundsVisible && !input && !invalidRuns && !invalidHours)) && (
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
          )}
          {unsupported ? (
            <>
              {onAdjust ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setOpen(false);
                    onAdjust();
                  }}
                  data-testid="authority-adjust"
                >
                  {t("authority.adjust")}
                </Button>
              ) : (
                <Button asChild>
                  <a href={adjustUrl} data-testid="authority-adjust">
                    {t("authority.adjust")}
                  </a>
                </Button>
              )}
              {onSingleRun && (
                <Button
                  disabled={busy || Boolean(activateOnly.error) || Boolean(incomplete)}
                  data-testid="authority-single-run"
                  onClick={() => {
                    if (activation) activateOnly.mutate();
                    else {
                      setOpen(false);
                      onSingleRun();
                    }
                  }}
                >
                  {t(
                    activation ? "chat.activation.singleConfirm" : "chat.activation.singlePrepare",
                  )}
                </Button>
              )}
            </>
          ) : (
            <Button
              disabled={busy || !input || Boolean(grant.error)}
              onClick={() => grant.mutate()}
              data-testid="authority-grant-confirm"
            >
              {t(
                grant.isPending
                  ? "authority.granting"
                  : activation
                    ? "chat.activation.confirm"
                    : onGrant
                      ? "decisions.applyAndAuthorize"
                      : Number(runs) === 1
                        ? "authority.grantConfirmOne"
                        : "authority.grantConfirm",
                { count: runs },
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
