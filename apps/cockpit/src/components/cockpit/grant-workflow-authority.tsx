import type { components } from "@cli-core/engine-api/openapi";
import { approvalChoice } from "@shared/approval-choice.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { type ApiResponse, apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import { useDefaultEnvironment } from "@/api/setup";
import { cockpitApiHref } from "@/app/installation-context";
import { absolute, chatNewHref } from "@/app/links";
import { useSession } from "@/app/session";
import { useConnectorNames, useConnectorServices } from "@/components/cockpit/connector-names";
import { GrantBoundaryProposals } from "@/components/cockpit/grant-boundary-proposals";
import { GrantEffectReview } from "@/components/cockpit/grant-effect-review";
import { GrantEnvironmentDecision } from "@/components/cockpit/grant-environment";
import { GrantLoadFailed } from "@/components/cockpit/grant-load-failed";
import {
  GrantRemedyAction,
  GrantScopeWarnings,
  useGrantContext,
  useGrantRemedy,
} from "@/components/cockpit/grant-notices";
import { OPENS_APPROVAL } from "@/components/cockpit/opens-approval";
import {
  ActionMenu,
  Button,
  CodeBlock,
  CollapsibleSection,
  ContextHelp,
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FormDialog,
  Section,
  Textarea,
} from "@/components/cockpit/patterns";
import { RunWorkflowDialog } from "@/components/cockpit/run-workflow-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  type ApprovalLimits,
  ApprovalLimitsFields,
  approvalBounds,
  approvalLimits,
  pairFailure,
  pairKeys,
  pairRequestBody,
  renewalSource,
  usePairVisibility,
} from "@/features/operations";
import { reportFailure } from "@/lib/action-failure";
import { authorityIssues, authorityProblems } from "@/lib/authority-issues";
import { proposalStepIds, proposalsModel, readBoundaryProposals } from "@/lib/authority-proposals";
import { authorityReviewModel, replacedVersion, reviewTitle } from "@/lib/authority-review-model";
import { automationQueryKeys, invalidateWorkflowAutomation } from "@/lib/automation-queries";
import { carryOverChoice } from "@/lib/automation-state";
import { existingGrant, grantScopeWarnings } from "@/lib/grant-context";
import { reviewedEnvironment } from "@/lib/grant-decision";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { liveTestState } from "@/lib/live-test-result";
import { type AuthorityPages, withProvisionalAuthority } from "@/lib/optimistic-authorities";
import { useOptimisticAction } from "@/lib/use-optimistic-action";
import {
  acceptReview,
  authorityGrantInputUntil,
  type WorkflowAuthorityPreview,
} from "@/lib/workflow-authorities";

type WorkflowJsonValue = components["schemas"]["WorkflowJsonValue"];
type PrepareOutcome = ApiResponse<
  "/v1/workflows/{id}/versions/{version_id}/prepare-authority",
  "post"
>;

const PREPARATION_REUSE_MS = 10 * 60_000;
const recentPreparations = new Map<string, number>();

function preparationRecentlyRan(key: string, now: number): boolean {
  const at = recentPreparations.get(key);
  return at !== undefined && now - at < PREPARATION_REUSE_MS;
}

function notePreparation(key: string, now: number): void {
  recentPreparations.set(key, now);
}

export function GrantWorkflowAuthority({
  conversationId,
  workflowId,
  versionId,
  activation,
  onCompleted,
  onSingleRun,
  onAdjust,
  reviewContent,
  initialEnvironment,
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
  const { t, tn, dateTime, locale } = useI18n();
  function showLiveTestResult(result: unknown): boolean {
    const state = liveTestState(result);
    if (!state) return false;
    const message = t(`chat.liveTest.${state}`);
    if (state === "succeeded") toast.success(message);
    else if (state === "failed") reportFailure(message);
    else toast.info(message);
    return true;
  }
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const session = useSession();
  const connectorNames = useConnectorNames(open);
  const connectorServices = useConnectorServices(open);
  const defaultEnvironment = useDefaultEnvironment();
  const [environment, setEnvironment] = useState<"dev" | "prod">(defaultEnvironment);
  const [limits, setLimits] = useState<ApprovalLimits>(() => approvalLimits(null, new Date()));
  const [reviewVersionId, setReviewVersionId] = useState(versionId);
  const [runAfter, setRunAfter] = useState(false);
  const [runRequest, setRunRequest] = useState<number | undefined>(undefined);
  const pairMode = usePairVisibility(open).hints && !activation;
  function runIfNotStarted(result: unknown) {
    const state =
      result && typeof result === "object" && "live_test" in result
        ? (result.live_test as { state?: string } | null)?.state
        : undefined;
    if ((state ?? "not_requested") === "not_requested")
      setRunRequest((current) => (current ?? 0) + 1);
  }
  const titleFacts = useQuery({
    queryKey: ["authority-title", workflowId, reviewVersionId],
    enabled: open && session.permissions.includes("workflow:read"),
    queryFn: async () => {
      const workflow = await apiCall("get", "/v1/workflows/{id}", { path: { id: workflowId } });
      let offset = 0;
      let latest = 0;
      for (;;) {
        const history = await apiCall("get", "/v1/workflows/{id}/history", {
          path: { id: workflowId },
          query: { limit: 200, offset },
        });
        latest = Math.max(latest, ...history.items.map((entry) => entry.version));
        const version = history.items.find((entry) => entry.id === reviewVersionId);
        if (version) return { name: workflow.name, version: version.version, latest };
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
  const [decision, setDecision] = useState<WorkflowAuthorityPreview | null>(null);
  const latestReview = useRef(0);
  const isLatest = (token: number) => token === latestReview.current;
  const [sample, setSample] = useState<{
    slug: string;
    versionId: string;
    trial: boolean;
  } | null>(null);
  const [trialAsked, setTrialAsked] = useState(false);
  const [trialSkipped, setTrialSkipped] = useState(false);
  const mounted = useRef(true);
  const savedVersion = useRef<string | null>(null);
  const followedVersion = useRef(versionId);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (followedVersion.current === versionId) return;
    followedVersion.current = versionId;
    if (savedVersion.current === versionId) return;
    savedVersion.current = null;
    setReviewVersionId(versionId);
    if (open) leaveReview();
  }, [versionId]);
  const [sampleText, setSampleText] = useState("");
  const [sampleInvalid, setSampleInvalid] = useState(false);
  async function sampleCall(): Promise<string> {
    if (session.permissions.includes("execution:read")) {
      try {
        const newest = await apiCall("get", "/v1/executions", {
          query: { workflow_id: workflowId, request_source: "webhook", limit: 1 },
        });
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
      pinned,
      trial,
    }: {
      env: "dev" | "prod";
      token: number;
      version?: string;
      input?: WorkflowJsonValue;
      pinned: boolean;
      trial: boolean;
    }): Promise<{
      review: WorkflowAuthorityPreview | null;
      decision: WorkflowAuthorityPreview;
      versionId: string;
      environment: "dev" | "prod";
      token: number;
      trial: boolean;
      skipped?: boolean;
      sample?: { slug: string; text: string };
    }> => {
      const superseded = () => new Error("authority_review_superseded");
      const targetVersion = version ?? versionId;
      const preview = (forEnvironment: "dev" | "prod") =>
        apiCall("get", "/v1/workflows/{id}/versions/{version_id}/authority-preview", {
          path: { id: workflowId, version_id: targetVersion },
          query: { environment: forEnvironment },
        });
      let asked = env;
      let result = await preview(asked);
      if (!isLatest(token)) throw superseded();
      let choice = approvalChoice(result, asked);
      for (let round = 0; round < 2; round++) {
        const belongs = reviewedEnvironment({
          choice,
          asked,
          pinned,
          hint: initialEnvironment,
        });
        if (belongs === asked) break;
        asked = belongs;
        result = await preview(asked);
        if (!isLatest(token)) throw superseded();
        choice = approvalChoice(result, asked);
      }
      const preparationKey = `${workflowId}:${targetVersion}:${asked}`;
      const mayRun = session.permissions.includes("workflow:run");
      const prepares =
        choice.kind !== "none" &&
        !result.eligible_for_repeated_runs &&
        result.preparation_required &&
        (input !== undefined || !preparationRecentlyRan(preparationKey, Date.now()));
      let skipped = false;
      if (mayRun && (trial || prepares)) {
        notePreparation(preparationKey, Date.now());
        setTrialStartedAt(Date.now());
        let outcome: PrepareOutcome;
        try {
          outcome = await apiCall(
            "post",
            "/v1/workflows/{id}/versions/{version_id}/prepare-authority",
            {
              path: { id: workflowId, version_id: targetVersion },
              body: { environment: asked, ...(input !== undefined ? { input } : {}) },
            },
          );
          if (isLatest(token)) setTrialElsewhere(outcome.reason === "preparation_in_flight");
          skipped =
            trial &&
            !outcome.prepared &&
            outcome.reason !== "preparation_in_flight" &&
            outcome.reason !== "input_required";
        } finally {
          if (isLatest(token)) setTrialStartedAt(null);
        }
        if (!isLatest(token)) throw superseded();
        if (outcome.reason === "input_required" && outcome.trigger)
          return {
            review: null,
            decision: result,
            versionId: targetVersion,
            environment: asked,
            token,
            trial,
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
      return {
        review: result,
        decision: result,
        versionId: targetVersion,
        environment: asked,
        token,
        trial,
        skipped,
      };
    },
  });
  function startReview(
    env: "dev" | "prod",
    version?: string,
    input?: WorkflowJsonValue,
    pinned = true,
    trial = false,
  ) {
    const token = latestReview.current + 1;
    latestReview.current = token;
    setReview(null);
    if (!pinned) setDecision(null);
    setTrialElsewhere(false);
    setTrialStartedAt(null);
    setTrialAsked(trial);
    setTrialSkipped(false);
    prepare.reset();
    prepare.mutate(
      { env, token, version, input, pinned, trial },
      {
        onSuccess: (answer) => {
          if (answer.trial)
            void client.invalidateQueries({ queryKey: ["boundary-proposals", workflowId] });
          if (!isLatest(answer.token)) return;
          setTrialSkipped(answer.skipped === true);
          setReviewVersionId(answer.versionId);
          setEnvironment(answer.environment);
          setDecision(answer.decision);
          if (answer.sample) {
            setSample({
              slug: answer.sample.slug,
              versionId: answer.versionId,
              trial: answer.trial,
            });
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
  const bounds = approvalBounds(limits, new Date());
  const limitsProblem = bounds.ok ? null : bounds.problem;
  const input =
    review && bounds.ok
      ? authorityGrantInputUntil(review, expected, bounds.validUntil, bounds.maxRuns, Date.now())
      : null;
  const grant = useOptimisticAction({
    queryKey: ["workflow-authorities", workflowId],
    apply: (current: AuthorityPages | undefined) =>
      review && input && !pairMode
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
    mutationFn: (): Promise<unknown> => {
      const checked = review
        ? bounds.ok
          ? authorityGrantInputUntil(
              review,
              expected,
              bounds.validUntil,
              bounds.maxRuns,
              Date.now(),
            )
          : null
        : null;
      if (!checked) throw new Error("authority_review_incomplete");
      if (pairMode)
        return apiCall("post", "/v1/workflows/{id}/pair-approvals", {
          path: { id: workflowId },
          body: {
            ...pairRequestBody(checked),
            ...(conversationId ? { conversation_id: conversationId } : {}),
          },
        });
      return apiCall("post", "/v1/workflows/{id}/execution-authorities", {
        path: { id: workflowId },
        body: {
          ...checked,
          ...(activation ? { activation } : {}),
          ...(conversationId ? { conversation_id: conversationId } : {}),
          ...(runAfter ? { start_run: true } : {}),
        },
      });
    },
    onSuccess: (result) => {
      onCompleted?.();
      setOpen(false);
      if (pairMode) {
        void client.invalidateQueries({ queryKey: pairKeys.list(workflowId) });
        toast.success(t("ops.pair.requested"));
        return;
      }
      if (!showLiveTestResult(result))
        toast.success(t(activation ? "chat.activation.saved" : "authority.grantSaved"));
      if (runAfter) runIfNotStarted(result);
    },
  });
  const activateOnly = useMutation({
    mutationFn: async (_then: "nothing" | "single_run") => {
      if (!review || !activation) throw new Error("activation_review_missing");
      return apiCall("post", "/v1/workflows/{id}/activate-draft", {
        path: { id: workflowId },
        body: {
          ...(conversationId && _then !== "single_run" ? { conversation_id: conversationId } : {}),
          ...(runAfter && _then !== "single_run" ? { start_run: true } : {}),
          workflow_version_id: reviewVersionId,
          expected_current_version_id: activation.expected_current_version_id,
          expected_manifest_digest: review.digest,
          execution_environment: environment,
        },
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
        if (!showLiveTestResult(_result))
          toast.success(t(model?.messages.activated ?? "authority.activatedOnly"));
        if (runAfter) runIfNotStarted(_result);
      }
    },
  });
  const repairable = useQuery({
    queryKey: ["boundary-proposals", workflowId, environment],
    enabled: open && Boolean(review) && !review?.eligible_for_repeated_runs,
    queryFn: async () =>
      readBoundaryProposals(
        await apiCall("get", "/v1/workflows/{id}/boundary-proposals", {
          path: { id: workflowId },
          query: { environment },
        } as { path: { id: string } }),
      ),
  });
  const proposals = repairable.data
    ? proposalsModel(repairable.data, (value) => new Intl.NumberFormat(locale).format(value))
    : null;
  const repair = useMutation({
    mutationFn: async () => {
      const opening = latestReview.current;
      const derivedIn = environment;
      const result = await apiCall("post", "/v1/workflows/{id}/boundary-proposals/apply", {
        path: { id: workflowId },
        body: {
          base_version_id: repairable.data?.base_version_id ?? null,
          proposals_digest: repairable.data?.digest ?? "",
          step_ids: proposals ? proposalStepIds(proposals) : [],
          environment: derivedIn,
        },
      });
      return { ...result, opening, derivedIn };
    },
    onSuccess: async (result) => {
      savedVersion.current = result.draft.version_id;
      toast.info(t("authorityProposals.applied"));
      await client.invalidateQueries({ queryKey: ["catalog-detail", "workflows", workflowId] });
      await client.invalidateQueries({ queryKey: ["workflow-draft-version", workflowId] });
      await client.invalidateQueries({ queryKey: ["boundary-proposals", workflowId] });
      if (!mounted.current || latestReview.current !== result.opening) return;
      setEnvironment(result.derivedIn);
      startReview(result.derivedIn, result.draft.version_id);
    },
    onError: () => void client.invalidateQueries({ queryKey: ["boundary-proposals", workflowId] }),
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
  const blocked = decision !== null && approvalChoice(decision, environment).kind === "none";
  const unsupported = review && (blocked || !review.eligible_for_repeated_runs);
  const deliveries =
    review?.manifest.effects.flatMap((effect) =>
      effect.report_delivery ? [effect.report_delivery] : [],
    ) ?? [];
  const transactionalDeliveries =
    review?.manifest.effects.flatMap((effect) =>
      effect.transactional_delivery ? [effect.transactional_delivery] : [],
    ) ?? [];
  const outboxDeliveries =
    review?.manifest.effects.flatMap((effect) =>
      effect.outbox_delivery ? [effect.outbox_delivery] : [],
    ) ?? [];
  const recurringReport = deliveries.length > 0 && !unsupported;
  const publications =
    review?.manifest.effects.flatMap((effect) =>
      effect.content_publication?.kind === "content_release" ? [effect.content_publication] : [],
    ) ?? [];
  const recurringContent = publications.length > 0 && !unsupported;
  const issues = authorityIssues(review);
  const incomplete = review?.execution_shape.requests.some(
    (request) => request.request_review_truncated || request.opaque_payload_omitted,
  );
  const carriesOver = carryOverChoice(review, Boolean(activation)) === "adopt";
  const boundsVisible = review && !unsupported && !incomplete && !carriesOver;
  const context = useGrantContext(workflowId, open);
  const seeded = useRef(false);
  useEffect(() => {
    if (!open || seeded.current || !context.authorities) return;
    seeded.current = true;
    const source = renewalSource(context.authorities, environment);
    if (source) setLimits(approvalLimits(source, new Date()));
  }, [open, context.authorities, environment]);
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
  const model = review
    ? authorityReviewModel({
        preview: review,
        connectorNames,
        connectorServices,
        automation: {
          schedule: review.schedules.length > 0,
          webhook: context.webhooksActive,
        },
        activation: Boolean(activation),
        carryOver: carriesOver,
      })
    : null;
  const problems = unsupported ? authorityProblems(review, t) : [];
  const hasRequestDetails =
    review !== null &&
    review.execution_shape.requests.length + review.execution_shape.iterations.length > 0;
  const nextRun = (review?.schedules ?? [])
    .flatMap((schedule) => (schedule.next_run_at ? [schedule.next_run_at] : []))
    .sort()[0];
  const canRun =
    session.permissions.includes("workflow:run") && Boolean(review) && !unsupported && !pairMode;
  const primaryHint = t(
    carriesOver
      ? "authority.review.help.adopt"
      : activation
        ? "authority.review.help.approve"
        : "authority.review.help.approveGrant",
  );
  const title = reviewTitle(titleFacts.data ?? null);
  const replaced = review
    ? replacedVersion({
        running: context.activeVersion,
        reviewed: titleFacts.data?.version ?? null,
      })
    : null;
  const remedy = useGrantRemedy(
    workflowId,
    environment,
    open && Boolean(unsupported) && (proposals?.rows.length ?? 0) === 0,
  );
  const adjustUrl = absolute(
    chatNewHref({
      workflowId,
      prompt: t("authority.adjustPrompt"),
      references: [{ type: "workflow", id: workflowId }],
    }),
  );
  function leaveReview() {
    setOpen(false);
    grant.reset();
    activateOnly.reset();
    setSample(null);
    latestReview.current += 1;
    setReview(null);
    setDecision(null);
    setTrialStartedAt(null);
    prepare.reset();
  }
  function openDialog(value: boolean) {
    if (submitting) return;
    if (!value) {
      leaveReview();
      return;
    }
    setOpen(true);
    grant.reset();
    activateOnly.reset();
    setSample(null);
    setRunAfter(false);
    setLimits(approvalLimits(null, new Date()));
    seeded.current = false;
    const opening = initialEnvironment ?? defaultEnvironment;
    setEnvironment(opening);
    startReview(opening, undefined, undefined, false);
  }
  const requested = useRef(openRequest);
  useEffect(() => {
    if (openRequest === undefined || openRequest === requested.current) return;
    requested.current = openRequest;
    if (!disabled) openDialog(true);
  }, [openRequest]);
  const pairProblem = pairFailure(grant.error);
  const failure = pairProblem
    ? t(`ops.pair.failure.${pairProblem}` as TranslationKey)
    : actionError
      ? `${t(sessionExpired ? "authority.sessionExpired" : "authority.grantFailed")} ${t(
          sessionExpired ? "authority.sessionExpiredHint" : "authority.grantFailedDescription",
        )}`
      : null;
  const confirmable = !blocked && !unsupported && !carriesOver;
  return (
    <>
      <FormDialog
        open={open}
        onOpenChange={openDialog}
        size="wide"
        testId="authority-grant-dialog"
        titleTestId="authority-dialog-title"
        cancelTestId="authority-grant-cancel"
        title={t(title.key, title.values)}
        description={
          <span className="flex flex-col gap-0.5">
            <span>
              {existing
                ? t("authority.existing.description")
                : unsupported
                  ? t("authority.adjustDescription")
                  : replaced !== null
                    ? t("authority.review.replaces", { version: `v${replaced}` })
                    : t("authority.review.lead")}
            </span>
            {versionLabel && review ? (
              <span data-testid="authority-version-label">
                {`${t("catalog.version")} ${versionLabel}`}
              </span>
            ) : null}
          </span>
        }
        hint={review && !unsupported ? primaryHint : undefined}
        cancelHint={t("authority.review.help.cancel")}
        error={failure}
        failure={sessionExpired ? undefined : actionError}
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
              {triggerLabel ?? t("authority.grantOpen")}
            </Button>
          ) : undefined
        }
        {...(carriesOver
          ? {
              submit: {
                label: t("authority.review.adopt"),
                pending: activateOnly.isPending,
                disabled: busy || Boolean(activateOnly.error),
                testId: "authority-activate-only",
                hint: primaryHint,
              },
              onSubmit: () => activateOnly.mutate("nothing"),
            }
          : confirmable
            ? {
                submit: {
                  label: t(model?.messages.approve ?? "authority.review.approve"),
                  pending: grant.isPending,
                  disabled: busy || !input || Boolean(grant.error),
                  testId: "authority-grant-confirm",
                  hint: primaryHint,
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
            {activation &&
              review &&
              !carriesOver &&
              !incomplete &&
              !sessionExpired &&
              !actionError &&
              (model?.buttons.activateOnly === "menu" ? (
                <ActionMenu
                  alwaysMenu
                  testId="authority-more-actions"
                  items={[
                    {
                      label: t("authority.review.activateOnly"),
                      disabled: busy,
                      onSelect: () => activateOnly.mutate("nothing"),
                      testId: "authority-activate-only",
                    },
                  ]}
                />
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => activateOnly.mutate("nothing")}
                  data-testid="authority-activate-only"
                  title={t(
                    model?.messages.activateOnlyHelp ?? "authority.review.help.activateOnly",
                  )}
                  data-hint={t(
                    model?.messages.activateOnlyHelp ?? "authority.review.help.activateOnly",
                  )}
                >
                  {t("authority.review.activateOnly")}
                </Button>
              ))}
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
                      activation
                        ? "chat.activation.singleConfirm"
                        : "chat.activation.singlePrepare",
                    )}
                  </Button>
                )}
              </>
            ) : null}
          </>
        }
      >
        {reviewContent}
        <GrantScopeWarnings warnings={blocked ? [] : scopeWarnings} />
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
        <TransactionalDeliveryReview deliveries={transactionalDeliveries} />
        <OutboxDeliveryReview deliveries={outboxDeliveries} />
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
        {unsupported && !blocked && issues.length === 0 && !onSingleRun && (
          <p className="text-sm" data-testid="authority-needs-adjustment">
            {t("authority.unsupportedSteps", {
              steps: review?.unavailable_steps.join(", ") || t("authority.effects"),
            })}
          </p>
        )}
        {unsupported && proposals && !prepare.isPending && (
          <GrantBoundaryProposals
            model={proposals}
            nextVersion={titleFacts.data ? `v${titleFacts.data.latest + 1}` : null}
            busy={busy}
            applying={repair.isPending}
            applyFailed={Boolean(repair.error)}
            trialSkipped={trialSkipped}
            mayApply={session.permissions.includes("workflow:write")}
            mayTry={session.permissions.includes("workflow:run") && !blocked}
            onApply={() => repair.mutate()}
            onTrial={() => startReview(environment, reviewVersionId, undefined, true, true)}
          />
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
          {decision && (
            <GrantEnvironmentDecision
              preview={decision}
              environment={environment}
              busy={busy}
              onSelect={(value) => {
                setEnvironment(value);
                grant.reset();
                startReview(value);
              }}
            />
          )}
          {boundsVisible && (
            <Field>
              <ApprovalLimitsFields
                value={limits}
                disabled={busy}
                problem={limitsProblem}
                onChange={setLimits}
                testId="authority-limit"
              />
            </Field>
          )}
        </FieldGroup>
        {prepare.isPending &&
          (trialStartedAt === null ? (
            <GrantEffectReview model={null} growth={undefined} problems={[]} loading />
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
                {t(trialAsked ? "authorityProposals.trial.what" : "authority.trial.what")}
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
                  let parsed: WorkflowJsonValue;
                  try {
                    parsed = JSON.parse(sampleText);
                  } catch {
                    setSampleInvalid(true);
                    return;
                  }
                  startReview(environment, sample.versionId, parsed, true, sample.trial);
                }}
              >
                {t("authority.sample.prepare")}
              </Button>
            </div>
          </Section>
        )}
        {prepare.error && sampleRefused === null && (
          <GrantLoadFailed
            onRetry={() => {
              const last = prepare.variables;
              grant.reset();
              if (last) startReview(last.env, last.version, last.input, last.pinned, last.trial);
              else startReview(environment);
            }}
          />
        )}
        {review && (
          <div className="flex min-w-0 flex-col gap-4" data-testid="authority-grant-review">
            {carriesOver && (
              <p className="text-sm font-medium" data-testid="authority-carry-over">
                {t("authority.carryOver.hint")}
              </p>
            )}
            <GrantEffectReview
              model={model}
              growth={review.boundary_growth}
              problems={problems}
              loading={false}
              toolPinsCompared={review.tool_pins_compared === true}
              compact
              beforeDetails={
                canRun && (confirmable || carriesOver) && !existing ? (
                  <label className="flex items-start gap-2 text-sm" htmlFor="authority-start-run">
                    <Checkbox
                      id="authority-start-run"
                      checked={runAfter}
                      disabled={busy}
                      onCheckedChange={(checked) => setRunAfter(checked === true)}
                      data-testid="authority-start-run"
                    />
                    <span className="flex flex-col">
                      {t("authority.review.startRun")}
                      <span className="text-xs text-muted-foreground">
                        {nextRun
                          ? t("authority.review.startRunNext", { time: dateTime(nextRun) })
                          : t("authority.review.startRunNone")}
                      </span>
                    </span>
                  </label>
                ) : null
              }
            >
              {hasRequestDetails ? (
                <div className="flex flex-col gap-3" data-testid="authority-effect-requests">
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
                  {review.execution_shape.requests.map((request) => (
                    <div key={request.step_id} className="flex min-w-0 flex-col gap-1">
                      <p
                        className="break-all font-mono text-xs"
                        data-testid="authority-request-target"
                      >
                        {request.target.url
                          ? t("authority.requestTarget", {
                              method: request.target.method,
                              url: request.target.url,
                            })
                          : t("authority.requestTargetOpen", { method: request.target.method })}
                      </p>
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
              ) : null}
            </GrantEffectReview>
            {!input && boundsVisible && (
              <p className="text-sm" data-testid="authority-review-expired">
                {t("authority.reviewExpired")} · {t("authority.reviewExpiredHint")}
              </p>
            )}
          </div>
        )}
      </FormDialog>
      {runRequest !== undefined && (
        <RunWorkflowDialog
          workflowId={workflowId}
          workflowName={titleFacts.data?.name ?? ""}
          liveEnvironment={environment}
          openRequest={runRequest}
        />
      )}
    </>
  );
}

export function OutboxDeliveryReview({
  deliveries,
}: {
  deliveries: Array<
    NonNullable<WorkflowAuthorityPreview["manifest"]["effects"][number]["outbox_delivery"]>
  >;
}) {
  const { t } = useI18n();
  return (
    deliveries.length > 0 && (
      <Section testId="authority-outbox-boundary" label={t("authority.outbox.recipients")}>
        <div className="flex flex-col gap-1 text-sm">
          <p>{t("authority.outbox.scope")}</p>
          {deliveries.map((delivery, index) => (
            <p key={`${delivery.source_step_id}:${index}`}>
              {t("authority.outbox.delivery", {
                from: delivery.from,
                source: delivery.source_step_id,
                field: delivery.recipient_field,
                item: delivery.item_id_field,
                bytes: delivery.max_body_bytes,
                perDay: delivery.max_per_day,
              })}
            </p>
          ))}
        </div>
      </Section>
    )
  );
}

function TransactionalDeliveryReview({
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
