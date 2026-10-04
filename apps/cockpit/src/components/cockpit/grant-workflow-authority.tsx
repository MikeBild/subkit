import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { absolute, chatNewHref } from "@/app/links";
import { useSession } from "@/app/session";
import { useConnectorNames } from "@/components/cockpit/connector-names";
import { BoundaryPanels } from "@/components/cockpit/grant-boundary-panels";
import {
  GrantRemedyAction,
  GrantScopeWarnings,
  GrantSuggestionNote,
  useGrantContext,
  useGrantRemedy,
} from "@/components/cockpit/grant-notices";
import { OPENS_APPROVAL } from "@/components/cockpit/opens-approval";
import {
  Button,
  CodeBlock,
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FormDialog,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@/components/cockpit/patterns";
import { effectKey, groupByCall } from "@/lib/authority-calls";
import { growthLine } from "@/lib/authority-growth";
import { authorityIssues } from "@/lib/authority-issues";
import { automationQueryKeys, invalidateWorkflowAutomation } from "@/lib/automation-queries";
import { existingGrant, grantScopeWarnings } from "@/lib/grant-context";
import { useI18n } from "@/lib/i18n-context";
import { type AuthorityPages, withProvisionalAuthority } from "@/lib/optimistic-authorities";
import { environmentToCorrectTo } from "@/lib/resolved-environment";
import { useOptimisticAction } from "@/lib/use-optimistic-action";
import {
  AUTHORITY_EFFECT_KEYS,
  acceptReview,
  authorityGrantInput,
  DEFAULT_GRANT_LIMIT,
  type GrantLimit,
  grantConfirmKey,
  grantLimitBounds,
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
  triggerVariant = "outline",
  triggerTestId = "authority-grant-open",
  openRequest,
  withTrigger = false,
  triggerSize = "sm",
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
  triggerVariant?: "default" | "outline";
  triggerTestId?: string;
  openRequest?: number;
  withTrigger?: boolean;
  triggerSize?: "sm" | "default";
}) {
  const { t, dateTime, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const session = useSession();
  const connectorNames = useConnectorNames(open);
  const [environment, setEnvironment] = useState<"dev" | "prod">("dev");
  const [runs, setRuns] = useState("");
  const [hours, setHours] = useState("");
  const [limit, setLimit] = useState<GrantLimit>(DEFAULT_GRANT_LIMIT);
  const limited = limit === "limited";
  const [reviewVersionId, setReviewVersionId] = useState(versionId);
  const [trialStartedAt, setTrialStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [trialElsewhere, setTrialElsewhere] = useState(false);
  useEffect(() => {
    if (trialStartedAt === null) {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const tick = setInterval(
      () => setElapsed(Math.floor((Date.now() - trialStartedAt) / 1000)),
      1000,
    );
    return () => clearInterval(tick);
  }, [trialStartedAt]);
  const [review, setReview] = useState<WorkflowAuthorityPreview | null>(null);
  const corrected = useRef(false);
  const latestReview = useRef(0);
  const isLatest = (token: number) => token === latestReview.current;
  const [sample, setSample] = useState<{ slug: string; versionId: string } | null>(null);
  const [sampleText, setSampleText] = useState("");
  const [sampleInvalid, setSampleInvalid] = useState(false);
  async function sampleCall(): Promise<string> {
    if (session.permissions.includes("execution:read")) {
      try {
        const newest = await apiRequest<{ items: { input?: unknown }[] }>(
          `/v1/executions?workflow_id=${encodeURIComponent(workflowId)}&request_source=webhook&limit=1`,
        );
        const received = newest.items[0]?.input;
        if (received !== undefined && received !== null) return JSON.stringify(received, null, 2);
      } catch {}
    }
    return JSON.stringify(
      { id: "sample", timestamp: Math.floor(Date.now() / 1000), type: "", headers: {}, body: {} },
      null,
      2,
    );
  }
  const prepare = useMutation({
    mutationFn: async ({
      env,
      token,
      version,
      input,
    }: {
      env: "dev" | "prod";
      token: number;
      version?: string;
      input?: unknown;
    }): Promise<{
      review: WorkflowAuthorityPreview | null;
      versionId: string;
      environment: "dev" | "prod";
      token: number;
      sample?: { slug: string; text: string };
    }> => {
      const superseded = () => new Error("authority_review_superseded");
      const targetVersion = version ?? (prepareVersion ? await prepareVersion() : versionId);
      const preview = (forEnvironment: "dev" | "prod") =>
        apiRequest<WorkflowAuthorityPreview>(
          `/v1/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(targetVersion)}/authority-preview?environment=${forEnvironment}`,
        );
      let asked = env;
      let result = await preview(asked);
      if (!isLatest(token)) throw superseded();
      if (!corrected.current) {
        const belongs = environmentToCorrectTo(result, asked);
        if (belongs) {
          corrected.current = true;
          asked = belongs;
          setEnvironment(belongs);
          result = await preview(asked);
          if (!isLatest(token)) throw superseded();
        }
      }
      if (
        !result.eligible_for_repeated_runs &&
        result.preparation_required &&
        session.permissions.includes("workflow:run")
      ) {
        setTrialStartedAt(Date.now());
        let outcome: { prepared: boolean; reason?: string; trigger?: { slug: string } };
        try {
          outcome = await apiRequest(
            `/v1/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(targetVersion)}/prepare-authority`,
            {
              method: "POST",
              body: JSON.stringify({
                environment: asked,
                ...(input !== undefined ? { input } : {}),
              }),
            },
          );
          if (isLatest(token)) setTrialElsewhere(outcome.reason === "preparation_in_flight");
        } finally {
          if (isLatest(token)) setTrialStartedAt(null);
        }
        if (!isLatest(token)) throw superseded();
        if (outcome.reason === "input_required" && outcome.trigger)
          return {
            review: null,
            versionId: targetVersion,
            environment: asked,
            token,
            sample: { slug: outcome.trigger.slug, text: await sampleCall() },
          };
        result = await preview(asked);
      }
      if (
        acceptReview(
          latestReview.current,
          token,
          { workflowId, versionId: targetVersion, environment: asked },
          result,
        ) === "stale"
      )
        throw superseded();
      return { review: result, versionId: targetVersion, environment: asked, token };
    },
  });
  function startReview(env: "dev" | "prod", version?: string, input?: unknown) {
    const token = latestReview.current + 1;
    latestReview.current = token;
    setReview(null);
    setTrialElsewhere(false);
    setTrialStartedAt(null);
    prepare.reset();
    prepare.mutate(
      { env, token, version, input },
      {
        onSuccess: (answer) => {
          if (!isLatest(answer.token)) return;
          setReviewVersionId(answer.versionId);
          setEnvironment(answer.environment);
          if (answer.sample) {
            setSample({ slug: answer.sample.slug, versionId: answer.versionId });
            setSampleText(answer.sample.text);
            return;
          }
          setSample(null);
          if (!answer.review) return;
          setRuns(String(answer.review.suggested_bounds.max_runs));
          setHours(
            String(
              (Date.parse(answer.review.suggested_bounds.valid_until) -
                Date.parse(answer.review.suggested_bounds.valid_from)) /
                3_600_000,
            ),
          );
          setReview(answer.review);
        },
      },
    );
  }
  const expected = { workflowId, versionId: reviewVersionId, environment };
  const { runs: grantRuns, hours: grantHours } = grantLimitBounds(limit, runs, hours);
  const input = review
    ? authorityGrantInput(review, expected, grantRuns, grantHours, Date.now())
    : null;
  const grant = useOptimisticAction({
    queryKey: ["workflow-authorities", workflowId],
    apply: (current: AuthorityPages | undefined) =>
      review && input
        ? withProvisionalAuthority(current, review, input, new Date().toISOString())
        : current,
    invalidate: [
      ...automationQueryKeys(workflowId).filter(
        (key) => key[0] !== "workflow-authorities" || key.length > 2,
      ),
      ["decisions"],
      ["attention"],
      ["patch-candidate"],
      ["workflow-schedule-holds"],
      ["conversation"],
      ["workflows"],
    ],
    errorMessage: () => t("authority.grantFailed"),
    mutationFn: () => {
      const checked = review
        ? authorityGrantInput(review, expected, grantRuns, grantHours, Date.now())
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
    onSuccess: () => {
      onCompleted?.();
      setOpen(false);
      toast.success(t(activation ? "chat.activation.saved" : "authority.grantSaved"));
    },
  });
  const activateOnly = useMutation({
    mutationFn: async (_then: "nothing" | "single_run") => {
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
    onSuccess: async (_result, then) => {
      await invalidateWorkflowAutomation(client, workflowId);
      await client.invalidateQueries({ queryKey: ["conversation"] });
      await client.invalidateQueries({ queryKey: ["attention"] });
      await client.invalidateQueries({ queryKey: ["workflows"] });
      await client.invalidateQueries({ queryKey: ["workflow-schedule-holds"] });
      setOpen(false);
      if (then === "single_run") onSingleRun?.();
      else {
        onCompleted?.();
        toast.success(t("authority.activatedOnly"));
      }
    },
  });
  const repairable = useQuery({
    queryKey: ["boundary-proposals", workflowId],
    enabled: open && Boolean(review) && !review?.eligible_for_repeated_runs,
    queryFn: async () => {
      const body = await apiRequest<{
        proposals?: Array<{ step_id: string }>;
        unproposable?: Array<{ step_id: string; reason: string }>;
      }>(`/v1/workflows/${encodeURIComponent(workflowId)}/boundary-proposals`);
      return {
        proposals: Array.isArray(body?.proposals) ? body.proposals : [],
        unproposable: Array.isArray(body?.unproposable) ? body.unproposable : [],
      };
    },
  });
  const repair = useMutation({
    mutationFn: async () => {
      const opening = latestReview.current;
      const current = await apiRequest<{ draft_version_id: string | null }>(
        `/v1/workflows/${encodeURIComponent(workflowId)}`,
      );
      const result = await apiRequest<{
        draft: { version_id: string };
        applied_step_ids: string[];
      }>(`/v1/workflows/${encodeURIComponent(workflowId)}/boundary-proposals/apply`, {
        method: "POST",
        body: JSON.stringify({ expected_draft_version_id: current.draft_version_id ?? null }),
      });
      return { ...result, opening };
    },
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ["catalog-detail", "workflows", workflowId] });
      await client.invalidateQueries({ queryKey: ["workflow-draft-version", workflowId] });
      await client.invalidateQueries({ queryKey: ["boundary-proposals", workflowId] });
      if (latestReview.current !== result.opening) return;
      startReview(environment, result.draft.version_id);
    },
  });
  const actionError = grant.error ?? activateOnly.error;
  const sessionExpired =
    actionError instanceof ApiError &&
    (actionError.status === 401 ||
      actionError.code === "human_session_expired" ||
      actionError.code === "human_session_required");
  const submitting = grant.isPending || activateOnly.isPending;
  const busy = prepare.isPending || repair.isPending || submitting;
  const sampleRefused =
    sample && prepare.error instanceof ApiError && prepare.error.code === "input_schema_violation"
      ? prepare.error.message
      : null;
  const unsupported = review && !review.eligible_for_repeated_runs;
  const deliveries =
    review?.manifest.effects.flatMap((effect) =>
      effect.report_delivery ? [effect.report_delivery] : [],
    ) ?? [];
  const recurringReport = deliveries.length > 0 && !unsupported;
  const publications =
    review?.manifest.effects.flatMap((effect) =>
      effect.content_publication?.kind === "content_release" ? [effect.content_publication] : [],
    ) ?? [];
  const recurringContent = publications.length > 0 && !unsupported;
  const callGroups = groupByCall(review?.manifest, review?.execution_shape);
  const issues = authorityIssues(review);
  const incomplete = review?.execution_shape.requests.some(
    (request) => request.request_review_truncated || request.opaque_payload_omitted,
  );
  const invalidRuns =
    limited && (!Number.isInteger(Number(runs)) || Number(runs) < 1 || Number(runs) > 10000);
  const invalidHours =
    limited && (!Number.isInteger(Number(hours)) || Number(hours) < 1 || Number(hours) > 744);
  const carriesOver = Boolean(
    activation && review?.approval_carries_over && !unsupported && !incomplete,
  );
  const boundsVisible = review && !unsupported && !incomplete && !carriesOver;
  const context = useGrantContext(workflowId, open);
  const existing =
    review && !unsupported && !activation
      ? existingGrant(context.authorities, reviewVersionId, environment, Date.now())
      : null;
  const scopeWarnings = grantScopeWarnings({
    environment,
    startedIn: context.startedIn,
    savedChange: Boolean(activation) && Boolean(review) && !unsupported,
    activeVersion: context.activeVersion,
  });
  const hasEffectDetails =
    review !== null &&
    review.manifest.effects.length +
      review.execution_shape.requests.length +
      review.execution_shape.iterations.length >
      0;
  const remedy = useGrantRemedy(
    workflowId,
    environment,
    open && Boolean(unsupported) && (repairable.data?.proposals.length ?? 0) === 0,
  );
  const adjustUrl = absolute(chatNewHref({ workflowId, prompt: t("authority.adjustPrompt") }));
  function openDialog(value: boolean) {
    if (submitting) return;
    setOpen(value);
    grant.reset();
    activateOnly.reset();
    setSample(null);
    if (value) {
      corrected.current = false;
      setLimit(DEFAULT_GRANT_LIMIT);
      setEnvironment(initialEnvironment);
      startReview(initialEnvironment);
    } else {
      latestReview.current += 1;
      setReview(null);
      setTrialStartedAt(null);
      prepare.reset();
    }
  }
  const requested = useRef(openRequest);
  useEffect(() => {
    if (openRequest === undefined || openRequest === requested.current) return;
    requested.current = openRequest;
    if (!disabled) openDialog(true);
  }, [openRequest]);
  const failure = actionError
    ? `${t(sessionExpired ? "authority.sessionExpired" : "authority.grantFailed")} ${t(
        sessionExpired ? "authority.sessionExpiredHint" : "authority.grantFailedDescription",
      )}`
    : null;
  const confirmable = !unsupported && !carriesOver;
  return (
    <FormDialog
      open={open}
      onOpenChange={openDialog}
      size="wide"
      testId="authority-grant-dialog"
      titleTestId="authority-dialog-title"
      cancelTestId="authority-grant-cancel"
      title={
        existing
          ? existing.open_ended
            ? t("authority.existing.titleUntilRevoked")
            : t(
                existing.remaining_runs === 1
                  ? "authority.existing.titleOne"
                  : "authority.existing.title",
                {
                  until:
                    existing.valid_until === null
                      ? t("authority.headline.untilRevoked")
                      : dateTime(existing.valid_until),
                  runs: existing.remaining_runs ?? t("authority.headline.runs.unlimited"),
                },
              )
          : t(
              recurringContent
                ? "authority.content.title"
                : recurringReport
                  ? "authority.report.title"
                  : unsupported
                    ? "authority.adjustTitle"
                    : activation
                      ? "chat.activation.title"
                      : onGrant
                        ? "decisions.applyAndAuthorize"
                        : "authority.grantOpen",
            )
      }
      description={
        existing
          ? t("authority.existing.description")
          : t(
              recurringContent
                ? "authority.content.description"
                : recurringReport
                  ? "authority.report.description"
                  : unsupported
                    ? "authority.adjustDescription"
                    : activation
                      ? "chat.activation.description"
                      : onGrant
                        ? "decisions.applyAndAuthorizeDescription"
                        : "authority.grantDescription",
            )
      }
      error={failure}
      trigger={
        openRequest === undefined || withTrigger ? (
          <Button
            type="button"
            variant={triggerVariant}
            size={triggerSize}
            disabled={disabled}
            data-testid={triggerTestId}
            {...OPENS_APPROVAL}
          >
            {triggerLabel ?? t(onGrant ? "decisions.applyAndAuthorize" : "authority.grantOpen")}
          </Button>
        ) : undefined
      }
      {...(confirmable
        ? {
            submit: {
              label: t(
                grant.isPending
                  ? "authority.granting"
                  : existing
                    ? "authority.existing.confirm"
                    : recurringContent
                      ? "authority.content.confirm"
                      : recurringReport
                        ? "authority.report.confirm"
                        : activation
                          ? "chat.activation.confirm"
                          : onGrant
                            ? "decisions.applyAndAuthorize"
                            : grantConfirmKey(limit, runs),
                { count: runs },
              ),
              pending: grant.isPending,
              disabled: busy || !input || Boolean(grant.error),
              testId: "authority-grant-confirm",
            },
            onSubmit: () => grant.mutate(undefined),
          }
        : {})}
      actions={
        <>
          {sessionExpired && (
            <Button asChild>
              <a
                data-testid="authority-sign-in"
                href={`/v1/identity/cockpit-login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`}
              >
                {t("authority.signIn")}
              </a>
            </Button>
          )}
          {!sessionExpired &&
            ((prepare.error && sampleRefused === null) ||
              grant.error ||
              (incomplete && !unsupported) ||
              (boundsVisible && !input && !invalidRuns && !invalidHours)) && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  grant.reset();
                  startReview(environment);
                }}
                data-testid="authority-prepare"
              >
                {t("authority.prepare")}
              </Button>
            )}
          {activation && review && !incomplete && !sessionExpired && !actionError && (
            <Button
              type="button"
              variant={carriesOver ? "default" : "outline"}
              disabled={busy}
              onClick={() => activateOnly.mutate("nothing")}
              data-testid="authority-activate-only"
            >
              {t(carriesOver ? "authority.carryOver.confirm" : "authority.activateOnly")}
            </Button>
          )}
          {unsupported ? (
            <>
              {onAdjust ? (
                <Button
                  type="button"
                  variant={remedy ? "outline" : "default"}
                  onClick={() => {
                    setOpen(false);
                    onAdjust();
                  }}
                  data-testid="authority-adjust"
                >
                  {t("authority.adjust")}
                </Button>
              ) : (
                <Button asChild variant={remedy ? "outline" : "default"}>
                  <a href={adjustUrl} data-testid="authority-adjust">
                    {t("authority.adjust")}
                  </a>
                </Button>
              )}
              {remedy && (
                <GrantRemedyAction
                  remedy={remedy}
                  environment={environment}
                  busy={busy}
                  onRecheck={() => startReview(environment)}
                />
              )}
              {onSingleRun && !incomplete && (
                <Button
                  type="button"
                  disabled={busy || Boolean(activateOnly.error) || Boolean(incomplete)}
                  data-testid="authority-single-run"
                  onClick={() => {
                    if (activation) activateOnly.mutate("single_run");
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
          ) : null}
        </>
      }
    >
      {reviewContent}
      <GrantScopeWarnings warnings={scopeWarnings} />
      {recurringContent &&
        publications.map((publication, index) => (
          <Notice key={index} testId="authority-content-boundary">
            <NoticeTitle>
              {t("authority.content.members", {
                count: publication.sources.reduce((n, source) => n + source.item_ids.length, 0),
              })}
            </NoticeTitle>
            <div className="flex flex-col gap-1">
              <p>{publication.origin}</p>
              <ul>
                {publication.sources.flatMap((source) =>
                  source.item_ids.flatMap((id) => {
                    const label = review?.content_items?.find((item) => item.id === id)?.label;
                    return label ? [<li key={id}>{label}</li>] : [];
                  }),
                )}
              </ul>
              <p>{t("authority.content.scope")}</p>
              <details>
                <summary>{t("authority.content.targets")}</summary>
                <ul>
                  {publication.sources.flatMap((source) =>
                    source.item_ids.map((id) => (
                      <li
                        key={id}
                        className="break-all"
                      >{`${publication.origin}/v1/content/${id}`}</li>
                    )),
                  )}
                </ul>
                <p className="break-all">{`${publication.origin}/v1/sites/${publication.site_id}`}</p>
              </details>
              {review?.schedules?.map((schedule, scheduleIndex) => (
                <p key={scheduleIndex}>
                  {t("authority.report.next", {
                    time: schedule.next_run_at
                      ? new Intl.DateTimeFormat(locale, {
                          dateStyle: "medium",
                          timeStyle: "short",
                          timeZone: schedule.timezone,
                        }).format(new Date(schedule.next_run_at))
                      : t("common.unknown"),
                    zone: schedule.timezone,
                  })}
                </p>
              ))}
            </div>
          </Notice>
        ))}
      {callGroups.map((group) =>
        group.step_id === null ? (
          <BoundaryPanels key="own" effects={group.effects} />
        ) : (
          <section
            key={effectKey([group.step_id], "$call")}
            className="flex flex-col gap-4 rounded-md border border-border/60 p-3"
            data-testid="authority-call-section"
          >
            <p className="font-medium">
              {t("authority.call.title", {
                step: group.step_id,
                name: group.workflow_name ?? t("common.unknown"),
                version: group.version ?? t("common.unknown"),
              })}
            </p>
            <p className="text-muted-foreground text-sm">{t("authority.call.scope")}</p>
            <BoundaryPanels effects={group.effects} />
          </section>
        ),
      )}
      {recurringReport && (
        <Notice testId="authority-report-boundary">
          <NoticeTitle>{t("authority.report.recipients")}</NoticeTitle>
          <div className="flex flex-col gap-1">
            {deliveries.map((delivery, index) => (
              <p key={`${delivery.to}:${index}`}>
                {t("authority.report.delivery", { from: delivery.from, to: delivery.to })}
              </p>
            ))}
            <p>{t("authority.report.variable")}</p>
            {review?.schedules?.map((schedule, index) => (
              <p key={index}>
                {t("authority.report.next", {
                  time: schedule.next_run_at
                    ? new Intl.DateTimeFormat(locale, {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: schedule.timezone,
                      }).format(new Date(schedule.next_run_at))
                    : t("common.unknown"),
                  zone: schedule.timezone,
                })}
              </p>
            ))}
          </div>
        </Notice>
      )}
      {unsupported && issues.length > 0 && (
        <Notice testId="authority-issues">
          <NoticeTitle>{t("authority.issuesTitle")}</NoticeTitle>
          <div className="flex flex-col gap-1">
            <ul className="flex flex-col gap-2">
              {issues.map((issue) => (
                <li key={issue.key}>
                  <span className="font-medium">
                    {issue.call_step_id
                      ? t("authority.issueInCall", {
                          step: issue.step_id,
                          call: issue.call_step_id,
                        })
                      : t("authority.issueStep", { step: issue.step_id })}
                  </span>
                  <br />
                  {t(issue.reasonKey ?? issue.messageKey)}
                  {issue.evidence && (
                    <>
                      <br />
                      <span className="break-all font-mono text-xs">
                        {t("authority.issueEvidence", {
                          declared: issue.evidence.declared_prefix,
                          observed: issue.evidence.observed_key,
                        })}
                      </span>
                    </>
                  )}
                </li>
              ))}
              {(review?.unavailable_steps ?? []).map((step) => (
                <li key={`unavailable:${step}`}>{t("authority.issueUnavailable", { step })}</li>
              ))}
            </ul>
          </div>
        </Notice>
      )}
      {unsupported && issues.length === 0 && !onSingleRun && (
        <Notice testId="authority-needs-adjustment">
          <NoticeTitle>{t("schedules.held.status")}</NoticeTitle>
          <div className="flex flex-col gap-1">
            {t("authority.unsupportedSteps", {
              steps: review?.unavailable_steps.join(", ") || t("authority.effects"),
            })}
          </div>
        </Notice>
      )}
      {unsupported && (repairable.data?.proposals?.length ?? 0) > 0 && (
        <Notice testId="authority-repair">
          <NoticeTitle>{t("authority.repairTitle")}</NoticeTitle>
          <div className="flex flex-col items-start gap-3">
            <p>
              {t("authority.repairDescription", {
                count: String(repairable.data?.proposals?.length ?? 0),
              })}
            </p>
            {(repairable.data?.unproposable?.length ?? 0) > 0 && (
              <p data-testid="authority-repair-remaining">
                {t("authority.repairNone", {
                  steps: (repairable.data?.unproposable ?? [])
                    .map((entry) => entry.step_id)
                    .join(", "),
                })}
              </p>
            )}
            {repair.error && (
              <p data-testid="authority-repair-failed">{t("authority.repairFailed")}</p>
            )}
            {repair.isSuccess && (
              <p data-testid="authority-repair-done">
                {t("authority.repairDone", {
                  count: String(repair.data?.applied_step_ids?.length ?? 0),
                })}
              </p>
            )}
            <Button
              type="button"
              size="sm"
              disabled={busy || repair.isPending}
              onClick={() => repair.mutate()}
              data-testid="authority-repair-apply"
            >
              {t(repair.isPending ? "authority.repairWorking" : "authority.repairAction")}
            </Button>
          </div>
        </Notice>
      )}
      {incomplete && !unsupported && (
        <Notice testId="authority-incomplete">
          <NoticeTitle>{t("authority.incompleteTitle")}</NoticeTitle>
          <div className="flex flex-col gap-1">{t("authority.incompleteDescription")}</div>
        </Notice>
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
              grant.reset();
              startReview(value);
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
          <Field>
            <FieldLabel>{t("authority.limit.label")}</FieldLabel>
            <SegmentedControl
              label={t("authority.limit.label")}
              value={limit}
              onValueChange={(next) => {
                if (!busy && (next === "until_revoked" || next === "limited")) setLimit(next);
              }}
              testId="authority-limit"
              options={[
                {
                  value: "until_revoked",
                  label: t("authority.limit.untilRevoked"),
                  testId: "authority-limit-until-revoked",
                },
                {
                  value: "limited",
                  label: t("authority.limit.limited"),
                  testId: "authority-limit-limited",
                },
              ]}
            />
            <p className="text-sm text-muted-foreground" data-testid="authority-limit-hint">
              {t(limited ? "authority.limit.limitedHint" : "authority.limit.untilRevokedHint")}
            </p>
          </Field>
        )}
        {boundsVisible && limited && (
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
            {review && <GrantSuggestionNote review={review} />}
          </>
        )}
      </FieldGroup>
      {prepare.isPending &&
        (trialStartedAt === null ? (
          <p role="status">{t("common.loading")}</p>
        ) : (
          <Notice testId="authority-trial-running">
            <NoticeTitle>{t("authority.trial.title")}</NoticeTitle>
            <div className="flex flex-col gap-1">
              <p>{t("authority.trial.what")}</p>
              <p role="status">{t("authority.trial.elapsed", { seconds: elapsed })}</p>
            </div>
          </Notice>
        ))}
      {trialElsewhere && !prepare.isPending && (
        <Notice testId="authority-trial-elsewhere">
          <NoticeTitle>{t("authority.trial.title")}</NoticeTitle>
          <div className="flex flex-col gap-1">{t("authority.trial.alreadyRunning")}</div>
        </Notice>
      )}
      {sample && !prepare.isPending && (
        <Notice testId="authority-sample">
          <NoticeTitle>{t("authority.sample.title", { slug: sample.slug })}</NoticeTitle>
          <div className="flex flex-col gap-3">
            <p>{t("authority.sample.what", { slug: sample.slug })}</p>
            <Field>
              <FieldLabel htmlFor="authority-sample-input">
                {t("authority.sample.label")}
              </FieldLabel>
              <Textarea
                id="authority-sample-input"
                data-testid="authority-sample-input"
                className="min-h-40 font-mono text-xs"
                value={sampleText}
                disabled={busy}
                aria-invalid={sampleInvalid || sampleRefused !== null}
                onChange={(event) => {
                  setSampleText(event.target.value);
                  setSampleInvalid(false);
                }}
              />
              {sampleInvalid && <FieldError>{t("authority.sample.invalid")}</FieldError>}
              {sampleRefused !== null && (
                <FieldError data-testid="authority-sample-refused">
                  {t("authority.sample.schema", { detail: sampleRefused })}
                </FieldError>
              )}
            </Field>
            <Button
              type="button"
              className="w-fit"
              disabled={busy}
              data-testid="authority-sample-prepare"
              onClick={() => {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(sampleText);
                } catch {
                  setSampleInvalid(true);
                  return;
                }
                startReview(environment, sample.versionId, parsed);
              }}
            >
              {t("authority.sample.prepare")}
            </Button>
          </div>
        </Notice>
      )}
      {prepare.error && sampleRefused === null && (
        <Notice tone="error">
          <NoticeTitle>{t("authority.loadFailed")}</NoticeTitle>
          <div className="flex flex-col gap-1">{t("authority.retryDescription")}</div>
        </Notice>
      )}
      {review && (
        <div className="flex min-w-0 flex-col gap-4" data-testid="authority-grant-review">
          {versionLabel ? (
            <div className="flex flex-wrap gap-2">
              <span
                className="rounded-md border px-2 py-0.5 text-xs font-medium"
                data-testid="authority-version-label"
              >
                {versionLabel}
              </span>
            </div>
          ) : null}
          {carriesOver ? (
            <p className="text-sm font-medium" data-testid="authority-carry-over">
              {t("authority.carryOver.hint")}
            </p>
          ) : null}
          {review && growthLine(t, review.boundary_growth) ? (
            <p className="text-sm font-medium" data-testid="authority-growth">
              {growthLine(t, review.boundary_growth)}
            </p>
          ) : null}
          {input && (
            <p className="text-sm">
              {t("authority.window")}
              {": "}
              {dateTime(input.valid_from)}
              {" — "}
              {input.valid_until === null
                ? t("authority.headline.untilRevoked")
                : dateTime(input.valid_until)}
            </p>
          )}
          {hasEffectDetails ? (
            <details
              open={!unsupported && !recurringReport && !recurringContent}
              data-testid="authority-effect-details"
            >
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
                      {t(AUTHORITY_EFFECT_KEYS[effect.effect])}
                      {" · "}
                      {effect.connector_id
                        ? (connectorNames.get(effect.connector_id) ??
                          t("authority.configuredConnector"))
                        : t("authority.directRequest")}
                    </p>
                    <p className="break-all">{effect.target ?? t("authority.unboundTarget")}</p>
                    {effect.read_path && <p>{t("authority.readPath")}</p>}
                    <p className="text-muted-foreground text-xs">
                      {t("authority.issueStep", { step: effect.step_id })}
                      {" · "}
                      {effect.operation}
                    </p>
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
                    <CodeBlock code={request.redacted_request_json} lang="json" />
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
              </div>
            </details>
          ) : null}
          {!input && boundsVisible && !invalidRuns && !invalidHours && (
            <Notice>
              <NoticeTitle>{t("authority.reviewExpired")}</NoticeTitle>
              <div className="flex flex-col gap-1">{t("authority.reviewExpiredHint")}</div>
            </Notice>
          )}
        </div>
      )}
    </FormDialog>
  );
}

function Notice({
  testId,
  tone,
  children,
}: {
  testId?: string;
  tone?: "error";
  children: ReactNode;
}) {
  return (
    <section
      role={tone === "error" ? "alert" : undefined}
      className={
        tone === "error"
          ? "flex flex-col gap-1 rounded-lg border border-destructive/40 p-3 text-sm text-destructive"
          : "flex flex-col gap-1 rounded-lg border bg-accent/10 p-3 text-sm"
      }
      data-testid={testId}
    >
      {children}
    </section>
  );
}

function NoticeTitle({ children }: { children: ReactNode }) {
  return <p className="font-medium">{children}</p>;
}
