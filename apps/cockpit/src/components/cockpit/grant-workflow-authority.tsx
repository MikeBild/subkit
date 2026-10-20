import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { cockpitApiHref } from "@/app/installation-context";
import { absolute, chatNewHref } from "@/app/links";
import { useSession } from "@/app/session";
import { useConnectorNames } from "@/components/cockpit/connector-names";
import { BoundaryPanels } from "@/components/cockpit/grant-boundary-panels";
import {
  GrantRemedyAction,
  GrantScopeWarnings,
  loadGrantStartedIn,
  useGrantContext,
  useGrantRemedy,
} from "@/components/cockpit/grant-notices";
import { OPENS_APPROVAL } from "@/components/cockpit/opens-approval";
import {
  Button,
  CodeBlock,
  CollapsibleSection,
  ContextHelp,
  DataState,
  FactList,
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FormDialog,
  Section,
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
import { liveTestState } from "@/lib/live-test-result";
import { type AuthorityPages, withProvisionalAuthority } from "@/lib/optimistic-authorities";
import { environmentToCorrectTo, heldEnvironments } from "@/lib/resolved-environment";
import { useOptimisticAction } from "@/lib/use-optimistic-action";
import {
  AUTHORITY_EFFECT_KEYS,
  acceptReview,
  authorityGrantInput,
  DEFAULT_GRANT_LIMIT,
  type GrantLimit,
  grantLimitBounds,
  type WorkflowAuthority,
  type WorkflowAuthorityPreview,
} from "@/lib/workflow-authorities";

export function GrantWorkflowAuthority({
  conversationId,
  workflowId,
  versionId,
  activation,
  onCompleted,
  onSingleRun,
  onAdjust,
  prepareVersion,
  onGrant,
  reviewContent,
  initialEnvironment,
  environmentChosen = false,
  ranIn,
  versionLabel,
  disabled = false,
  triggerLabel,
  triggerVariant = "outline",
  triggerTestId = "authority-grant-open",
  openRequest,
  withTrigger = false,
  triggerSize = "sm",
}: {
  conversationId?: string;
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
  environmentChosen?: boolean;
  ranIn?: "dev" | "prod";
  versionLabel?: string;
  disabled?: boolean;
  triggerLabel?: string;
  triggerVariant?: "default" | "outline";
  triggerTestId?: string;
  openRequest?: number;
  withTrigger?: boolean;
  triggerSize?: "sm" | "default";
}) {
  const { t, tn, dateTime, locale } = useI18n();
  function showLiveTestResult(result: unknown): boolean {
    const state = liveTestState(result);
    if (!state) return false;
    const message = t(`chat.liveTest.${state}`);
    if (state === "succeeded") toast.success(message);
    else if (state === "failed") toast.error(message);
    else toast.info(message);
    return true;
  }
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const session = useSession();
  const connectorNames = useConnectorNames(open);
  const [environment, setEnvironment] = useState<"dev" | "prod">("dev");
  const [limit, setLimit] = useState<GrantLimit>(DEFAULT_GRANT_LIMIT);
  const [reviewVersionId, setReviewVersionId] = useState(versionId);
  const titleFacts = useQuery({
    queryKey: ["authority-title", workflowId, reviewVersionId],
    enabled: open && session.permissions.includes("workflow:read"),
    queryFn: async () => {
      const workflow = await apiRequest<{ name: string }>(
        `/v1/workflows/${encodeURIComponent(workflowId)}`,
      );
      let offset = 0;
      for (;;) {
        const history = await apiRequest<{
          items: { id: string; version: number }[];
          total: number;
        }>(`/v1/workflows/${encodeURIComponent(workflowId)}/history?limit=200&offset=${offset}`);
        const version = history.items.find((entry) => entry.id === reviewVersionId);
        if (version) return { name: workflow.name, version: version.version };
        offset += history.items.length;
        if (history.items.length === 0 || offset >= history.total) return null;
      }
    },
  });
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
  const settled = useRef(false);
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
      if (
        !settled.current &&
        environmentToCorrectTo(
          result,
          asked,
          heldEnvironments({ chosen: environmentChosen ? initialEnvironment : null }),
        )
      ) {
        const runsIn = await loadGrantStartedIn(
          client,
          workflowId,
          session.permissions.includes("schedule:read"),
        );
        if (!isLatest(token)) throw superseded();
        const belongs = environmentToCorrectTo(
          result,
          asked,
          heldEnvironments({
            chosen: environmentChosen ? initialEnvironment : null,
            ranIn,
            runsIn,
          }),
        );
        settled.current = true;
        if (belongs) {
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
          setReview(answer.review);
        },
      },
    );
  }
  const expected = { workflowId, versionId: reviewVersionId, environment };
  const { runs: grantRuns, hours: grantHours } = grantLimitBounds(limit);
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
          body: JSON.stringify({
            ...checked,
            ...(activation ? { activation } : {}),
            ...(conversationId ? { conversation_id: conversationId } : {}),
          }),
        },
      );
    },
    onSuccess: (result) => {
      onCompleted?.();
      setOpen(false);
      if (!showLiveTestResult(result))
        toast.success(t(activation ? "chat.activation.saved" : "authority.grantSaved"));
    },
  });
  const activateOnly = useMutation({
    mutationFn: async (_then: "nothing" | "single_run") => {
      if (!review || !activation) throw new Error("activation_review_missing");
      return apiRequest(`/v1/workflows/${encodeURIComponent(workflowId)}/activate-draft`, {
        method: "POST",
        body: JSON.stringify({
          ...(conversationId && _then !== "single_run" ? { conversation_id: conversationId } : {}),
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
        if (!showLiveTestResult(_result)) toast.success(t("authority.activatedOnly"));
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
  const transactionalDeliveries =
    review?.manifest.effects.flatMap((effect) =>
      effect.transactional_delivery ? [effect.transactional_delivery] : [],
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
  const adjustUrl = absolute(
    chatNewHref({
      workflowId,
      prompt: t("authority.adjustPrompt"),
      references: [{ type: "workflow", id: workflowId }],
    }),
  );
  function openDialog(value: boolean) {
    if (submitting) return;
    setOpen(value);
    grant.reset();
    activateOnly.reset();
    setSample(null);
    if (value) {
      settled.current = false;
      setLimit(DEFAULT_GRANT_LIMIT);
      const opening = initialEnvironment ?? ranIn ?? "dev";
      setEnvironment(opening);
      startReview(opening);
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
          : titleFacts.data && !recurringContent && !recurringReport && !unsupported
            ? t("authority.namedTitle", {
                name: titleFacts.data.name,
                version: `v${titleFacts.data.version}`,
              })
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
                            : "authority.grantConfirmUntilRevoked",
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
                href={cockpitApiHref(
                  `/v1/identity/cockpit-login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`,
                )}
              >
                {t("authority.signIn")}
              </a>
            </Button>
          )}
          {!sessionExpired &&
            ((prepare.error && sampleRefused === null) ||
              grant.error ||
              (incomplete && !unsupported) ||
              (boundsVisible && !input)) && (
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
          <Section
            key={index}
            testId="authority-content-boundary"
            label={tn(
              "authority.content.members",
              publication.sources.reduce((n, source) => n + source.item_ids.length, 0),
            )}
            aside={
              <ContextHelp
                label={t("authority.content.targets")}
                testId={`authority-content-scope-${index}`}
              >
                {t("authority.content.scope")}
              </ContextHelp>
            }
          >
            <div className="flex flex-col gap-1 text-sm">
              <p>{publication.origin}</p>
              <ul>
                {publication.sources.flatMap((source) =>
                  source.item_ids.flatMap((id) => {
                    const label = review?.content_items?.find((item) => item.id === id)?.label;
                    return label ? [<li key={id}>{label}</li>] : [];
                  }),
                )}
              </ul>
              <CollapsibleSection
                label={t("authority.content.targets")}
                testId={`authority-content-targets-${index}`}
              >
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
              </CollapsibleSection>
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
          </Section>
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
            <p className="flex items-center gap-1 font-medium">
              {t("authority.call.title", {
                step: group.step_id,
                name: group.workflow_name ?? t("common.unknown"),
                version: group.version ?? t("common.unknown"),
              })}
              <ContextHelp
                label={t("authority.effects")}
                testId={`authority-call-scope-${group.step_id}`}
              >
                {t("authority.call.scope")}
              </ContextHelp>
            </p>
            <BoundaryPanels effects={group.effects} />
          </section>
        ),
      )}
      <TransactionalDeliveryReview deliveries={transactionalDeliveries} />
      {recurringReport && (
        <Section
          testId="authority-report-boundary"
          label={t("authority.report.recipients")}
          aside={
            <ContextHelp
              label={t("authority.report.recipients")}
              testId="authority-report-variable"
            >
              {t("authority.report.variable")}
            </ContextHelp>
          }
        >
          <div className="flex flex-col gap-1 text-sm">
            {deliveries.map((delivery, index) => (
              <p key={`${delivery.to}:${index}`}>
                {t("authority.report.delivery", { from: delivery.from, to: delivery.to })}
              </p>
            ))}
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
        </Section>
      )}
      {unsupported && issues.length > 0 && (
        <Section testId="authority-issues" label={t("authority.issuesTitle")}>
          <div className="flex flex-col gap-1 text-sm">
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
        </Section>
      )}
      {unsupported && issues.length === 0 && !onSingleRun && (
        <p className="text-sm" data-testid="authority-needs-adjustment">
          {t("authority.unsupportedSteps", {
            steps: review?.unavailable_steps.join(", ") || t("authority.effects"),
          })}
        </p>
      )}
      {unsupported && (repairable.data?.proposals?.length ?? 0) > 0 && (
        <Section
          testId="authority-repair"
          label={t("authority.repairTitle")}
          aside={
            <ContextHelp label={t("authority.repairTitle")} testId="authority-repair-help">
              {tn("authority.repairDescription", repairable.data?.proposals?.length ?? 0)}
            </ContextHelp>
          }
        >
          <div className="flex flex-col items-start gap-3 text-sm">
            <p>{tn("authority.repairLine", repairable.data?.proposals?.length ?? 0)}</p>
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
                {tn("authority.repairDone", repair.data?.applied_step_ids?.length ?? 0)}
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
        </Section>
      )}
      {incomplete && !unsupported && (
        <p className="flex items-center gap-1 text-sm" data-testid="authority-incomplete">
          {t("authority.incompleteTitle")}
          <ContextHelp label={t("authority.incompleteTitle")} testId="authority-incomplete-help">
            {t("authority.incompleteDescription")}
          </ContextHelp>
        </p>
      )}
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="authority-environment">{t("authority.environment")}</FieldLabel>
          <Select
            value={environment}
            disabled={busy}
            onValueChange={(value) => {
              if (value !== "dev" && value !== "prod") return;
              settled.current = true;
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
            <FieldLabel className="flex items-center gap-1">
              {t("authority.limit.label")}
              <ContextHelp label={t("authority.limit.label")} testId="authority-limit-hint">
                {t(
                  limit === "until_revoked"
                    ? "authority.limit.untilRevokedHint"
                    : "authority.limit.durationHint",
                )}
              </ContextHelp>
            </FieldLabel>
            <SegmentedControl
              label={t("authority.limit.label")}
              value={limit}
              onValueChange={(next) => {
                if (!busy && (next === "until_revoked" || next === "7d" || next === "30d"))
                  setLimit(next);
              }}
              testId="authority-limit"
              options={[
                {
                  value: "7d",
                  label: t("authority.limit.sevenDays"),
                  testId: "authority-limit-seven-days",
                },
                {
                  value: "30d",
                  label: t("authority.limit.thirtyDays"),
                  testId: "authority-limit-thirty-days",
                },
                {
                  value: "until_revoked",
                  label: t("authority.limit.untilRevoked"),
                  testId: "authority-limit-until-revoked",
                },
              ]}
            />
          </Field>
        )}
      </FieldGroup>
      {prepare.isPending &&
        (trialStartedAt === null ? (
          <p role="status">{t("common.loading")}</p>
        ) : (
          <p
            role="status"
            className="flex items-center gap-1 text-sm"
            data-testid="authority-trial-running"
          >
            {t("authority.trial.title")}
            {" · "}
            {t("authority.trial.elapsed", { seconds: elapsed })}
            <ContextHelp label={t("authority.trial.title")} testId="authority-trial-help">
              {t("authority.trial.what")}
            </ContextHelp>
          </p>
        ))}
      {trialElsewhere && !prepare.isPending && (
        <p role="status" className="text-sm" data-testid="authority-trial-elsewhere">
          {t("authority.trial.alreadyRunning")}
        </p>
      )}
      {sample && !prepare.isPending && (
        <Section
          testId="authority-sample"
          label={t("authority.sample.title", { slug: sample.slug })}
          aside={
            <ContextHelp label={t("authority.sample.label")} testId="authority-sample-help">
              {t("authority.sample.what", { slug: sample.slug })}
            </ContextHelp>
          }
        >
          <div className="flex flex-col gap-3">
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
        </Section>
      )}
      {prepare.error && sampleRefused === null && (
        <DataState
          state="error"
          line={t("authority.loadFailed")}
          testId="authority-load-failed"
          className="py-0"
        />
      )}
      {review && (
        <div className="flex min-w-0 flex-col gap-4" data-testid="authority-grant-review">
          {versionLabel || input ? (
            <FactList
              testId="authority-boundary-facts"
              items={[
                ...(versionLabel
                  ? [
                      {
                        label: t("catalog.version"),
                        value: versionLabel,
                        testId: "authority-version-label",
                      },
                    ]
                  : []),
                ...(input
                  ? [
                      {
                        label: t("authority.window"),
                        value: `${dateTime(input.valid_from)} — ${
                          input.valid_until === null
                            ? t("authority.headline.untilRevoked")
                            : dateTime(input.valid_until)
                        }`,
                        testId: "authority-window",
                      },
                    ]
                  : []),
              ]}
            />
          ) : null}
          {carriesOver ? (
            <p className="text-sm font-medium" data-testid="authority-carry-over">
              {t("authority.carryOver.hint")}
            </p>
          ) : growthLine(t, review.boundary_growth) ? (
            <p className="text-sm font-medium" data-testid="authority-growth">
              {growthLine(t, review.boundary_growth)}
            </p>
          ) : boundsVisible ? (
            <p className="text-sm" data-testid="authority-consequence">
              {t("authority.sameBoundary")}
            </p>
          ) : null}
          {hasEffectDetails ? (
            <Section
              label={t("authority.effects")}
              testId="authority-effect-details"
              aside={
                <ContextHelp label={t("authority.effects")} testId="authority-effect-help">
                  {`${t("authority.runNotRequestDescription")} ${t("authority.maskedDescription")}`}
                </ContextHelp>
              }
            >
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
              {review.execution_shape.iterations.map((iteration) => (
                <p key={`${iteration.step_id}:${iteration.kind}`} className="break-words text-sm">
                  {t("authority.iteration", {
                    step: iteration.step_id,
                    children: iteration.body_step_ids.join(", "),
                  })}
                </p>
              ))}
              {review.execution_shape.requests.length > 0 ? (
                <CollapsibleSection
                  label={t("authority.requests")}
                  count={review.execution_shape.requests.length}
                  testId="authority-effect-requests"
                >
                  <div className="flex flex-col gap-3">
                    {review.execution_shape.requests.map((request) => (
                      <div key={request.step_id} className="flex min-w-0 flex-col gap-1">
                        <p className="text-muted-foreground text-xs">
                          {t("authority.attempts", {
                            count: request.retry_policy_max_attempts ?? t("common.unknown"),
                          })}
                        </p>
                        <CodeBlock
                          label={t("authority.requestReview", { step: request.step_id })}
                          code={request.redacted_request_json}
                          lang="json"
                        />
                      </div>
                    ))}
                  </div>
                </CollapsibleSection>
              ) : null}
            </Section>
          ) : null}
          {!input && boundsVisible && (
            <p className="text-sm" data-testid="authority-review-expired">
              {t("authority.reviewExpired")} · {t("authority.reviewExpiredHint")}
            </p>
          )}
        </div>
      )}
    </FormDialog>
  );
}

export function TransactionalDeliveryReview({
  deliveries,
}: {
  deliveries: Array<
    NonNullable<WorkflowAuthorityPreview["manifest"]["effects"][number]["transactional_delivery"]>
  >;
}) {
  const { t } = useI18n();
  return (
    deliveries.length > 0 && (
      <Section
        testId="authority-transactional-boundary"
        label={t("authority.transactional.recipients")}
      >
        <div className="flex flex-col gap-1 text-sm">
          <p>{t("authority.transactional.scope")}</p>
          {deliveries.map((delivery, index) => (
            <p key={`${delivery.webhook_id}:${index}`}>
              {t("authority.transactional.delivery", {
                from: delivery.from,
                field: delivery.recipient_input,
                event: delivery.event_type,
                eventField: delivery.event_type_input,
                requestField: delivery.request_id_input,
                bytes: delivery.max_body_bytes,
                hook: delivery.webhook_id,
              })}
            </p>
          ))}
        </div>
      </Section>
    )
  );
}
