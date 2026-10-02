import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { absolute, chatNewHref } from "@/app/links";
import { useSession } from "@/app/session";
import { BoundaryPanels } from "@/components/cockpit/grant-boundary-panels";
import {
  GrantRemedyAction,
  GrantScopeWarnings,
  GrantSuggestionNote,
  useGrantContext,
  useGrantRemedy,
} from "@/components/cockpit/grant-notices";
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
import { Textarea } from "@/components/ui/textarea";
import { effectKey, groupByCall } from "@/lib/authority-calls";
import { authorityIssues } from "@/lib/authority-issues";
import { invalidateWorkflowAutomation } from "@/lib/automation-queries";
import { existingGrant, grantScopeWarnings } from "@/lib/grant-context";
import { useI18n } from "@/lib/i18n-context";
import { environmentToCorrectTo } from "@/lib/resolved-environment";
import {
  AUTHORITY_EFFECT_KEYS,
  acceptReview,
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
  triggerVariant = "outline",
  triggerTestId = "authority-grant-open",
  openRequest,
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
  /**
   * Opens the dialog from outside its own trigger: every change of this
   * number is one request to open. With it the dialog renders no trigger of
   * its own — the caller owns the buttons, so one dialog can answer several.
   */
  openRequest?: number;
}) {
  const { t, dateTime, locale } = useI18n();
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
  // When the trial run started, or null while nothing is running. A timestamp
  // rather than a boolean, so the counter below survives a re-render without
  // restarting — a number that jumps back to zero reads as a stall.
  const [trialStartedAt, setTrialStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  /** A trial run was already going when this dialog asked for one. */
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
  // At most one environment correction per opening. The review names the half
  // its steps really live in, so a second pass can never learn more than the
  // first — and a flag that resets only on open is what keeps a disagreement
  // between the two halves from becoming a loop.
  const corrected = useRef(false);
  // Which review request is the current one. Every request takes the next
  // number; closing the dialog takes one too. An answer is shown only while its
  // number is still the latest — the request that FINISHES last is not the one
  // that was ASKED last, and an older answer landing on top of a newer question
  // put a review on screen that the confirm button then refused for good.
  const latestReview = useRef(0);
  const isLatest = (token: number) => token === latestReview.current;
  /** A webhook-started workflow waiting for the reviewer's sample call. */
  const [sample, setSample] = useState<{ slug: string; versionId: string } | null>(null);
  const [sampleText, setSampleText] = useState("");
  const [sampleInvalid, setSampleInvalid] = useState(false);
  /** The newest call this workflow received, else an empty delivery envelope
   *  — the shape the engine hands a webhook-started run. */
  async function sampleCall(): Promise<string> {
    if (session.permissions.includes("execution:read")) {
      try {
        const newest = await apiRequest<{ items: { input?: unknown }[] }>(
          `/v1/executions?workflow_id=${encodeURIComponent(workflowId)}&request_source=webhook&limit=1`,
        );
        const received = newest.items[0]?.input;
        if (received !== undefined && received !== null) return JSON.stringify(received, null, 2);
      } catch {
        // The template below still lets the reviewer go on.
      }
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
      /** The version to judge, when the caller already knows it (a repair). */
      version?: string;
      /** The sample call the reviewer supplied for a webhook-started workflow. */
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
      // The answer to "which environment should this have been" arrives with
      // the complaint: every effect names the environment its connector really
      // belongs to, whichever one was asked about. Asked once, acted on once.
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
        // Opening this dialog STARTS a trial run. Nothing said so, and the wait
        // showed a bare "loading" for minutes — which is why people opened a
        // second tab and three runs started at once. The flag below is what the
        // wait text reads to say what is actually happening.
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
          // A second tab, or a repair reload, meets a run that is already
          // going. That is the engine doing the right thing — one run instead
          // of three — and it must not arrive as a red failure. The review is
          // simply not ready yet, and the line below says why.
          if (isLatest(token)) setTrialElsewhere(outcome.reason === "preparation_in_flight");
        } finally {
          // Only this request's own timer: a newer request may be running one.
          if (isLatest(token)) setTrialStartedAt(null);
        }
        if (!isLatest(token)) throw superseded();
        // A webhook's input is a delivery, and refused deliveries are not
        // kept. The engine asks rather than running over `{}`; the reviewer
        // supplies one call, and the review waits for it — not a refusal, and
        // not yet something to judge.
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
      // Stale: a newer question was asked (or the dialog closed) while this
      // one was out — its answer is dropped. A mismatch on the latest request
      // is still shown: `authorityGrantInput` refuses to approve from it and
      // the footer offers the re-check, which is the way out of it.
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
  /**
   * Start a review, superseding any still in flight. The answer is applied
   * here, per request, and only while it is still the latest — never from the
   * mutation's options, which run for every call that completes.
   */
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
      await invalidateWorkflowAutomation(client, workflowId);
      await client.invalidateQueries({ queryKey: ["decisions"] });
      await client.invalidateQueries({ queryKey: ["attention"] });
      await client.invalidateQueries({ queryKey: ["patch-candidate"] });
      await client.invalidateQueries({ queryKey: ["workflow-schedule-holds"] });
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
      // The catalog page shows the same workflow, and a version that is now
      // running must stop being announced as one that is waiting.
      await invalidateWorkflowAutomation(client, workflowId);
      await client.invalidateQueries({ queryKey: ["conversation"] });
      await client.invalidateQueries({ queryKey: ["attention"] });
      await client.invalidateQueries({ queryKey: ["workflows"] });
      await client.invalidateQueries({ queryKey: ["workflow-schedule-holds"] });
      setOpen(false);
      onSingleRun?.();
    },
  });
  // What SubKit can work out for itself about the steps that block this
  // approval. Asked only when the review actually refused: otherwise this is a
  // question about a problem nobody has.
  const repairable = useQuery({
    queryKey: ["boundary-proposals", workflowId],
    enabled: open && Boolean(review) && !review?.eligible_for_repeated_runs,
    queryFn: async () => {
      const body = await apiRequest<{
        proposals?: Array<{ step_id: string }>;
        unproposable?: Array<{ step_id: string; reason: string }>;
      }>(`/v1/workflows/${encodeURIComponent(workflowId)}/boundary-proposals`);
      // Shaped here, once. A dialog that reads fields straight off a response
      // renders whatever the other side happened to send — a body without
      // `proposals` took the whole page down in the sweep.
      return {
        proposals: Array.isArray(body?.proposals) ? body.proposals : [],
        unproposable: Array.isArray(body?.unproposable) ? body.unproposable : [],
      };
    },
  });
  const repair = useMutation({
    mutationFn: async () => {
      // Which opening this repair belongs to. Closing the dialog moves the
      // counter on, and a repair that lands after that must not reopen a
      // review in a dialog nobody is looking at.
      const opening = latestReview.current;
      const current = await apiRequest<{ draft_version_id: string | null }>(
        `/v1/workflows/${encodeURIComponent(workflowId)}`,
      );
      const result = await apiRequest<{
        draft: { version_id: string };
        applied_step_ids: string[];
      }>(`/v1/workflows/${encodeURIComponent(workflowId)}/boundary-proposals/apply`, {
        method: "POST",
        // Explicitly null when there is no draft yet: an omitted key is not
        // "no draft", it is a body the engine refuses — and the caller would
        // read that as the repair being impossible.
        body: JSON.stringify({ expected_draft_version_id: current.draft_version_id ?? null }),
      });
      return { ...result, opening };
    },
    onSuccess: async (result) => {
      // The prepared version IS the thing to review now, so the dialog reloads
      // onto it rather than leaving the reader looking at the old refusal.
      await client.invalidateQueries({ queryKey: ["catalog-detail", "workflows", workflowId] });
      await client.invalidateQueries({ queryKey: ["workflow-draft-version", workflowId] });
      await client.invalidateQueries({ queryKey: ["boundary-proposals", workflowId] });
      if (latestReview.current !== result.opening) return;
      // The draft by name: the version prop catches up only after the
      // invalidation above re-renders the caller, which this does not wait for.
      startReview(environment, result.draft.version_id);
    },
  });
  const actionError = grant.error ?? activateOnly.error;
  const sessionExpired =
    actionError instanceof ApiError &&
    (actionError.status === 401 ||
      actionError.code === "human_session_expired" ||
      actionError.code === "human_session_required");
  // A submit in flight must not be abandoned by closing the dialog; a review
  // that is only loading may be — its answer is then dropped (`latestReview`).
  const submitting = grant.isPending || activateOnly.isPending;
  const busy = prepare.isPending || repair.isPending || submitting;
  // The sample did not fit the workflow's input: the reviewer's to correct,
  // said beside the field — not the generic "could not be loaded".
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
  // One approval can cover more than one workflow. Own permissions first, then
  // a section per called workflow — grouped by call path, because a parent and
  // a child may use the same step id and must not be merged into one row.
  const callGroups = groupByCall(review?.manifest, review?.execution_shape);
  const issues = authorityIssues(review);
  const incomplete = review?.execution_shape.requests.some(
    (request) => request.request_review_truncated || request.opaque_payload_omitted,
  );
  const invalidRuns = !Number.isInteger(Number(runs)) || Number(runs) < 1 || Number(runs) > 10000;
  const invalidHours = !Number.isInteger(Number(hours)) || Number(hours) < 1 || Number(hours) > 744;
  const boundsVisible = review && !unsupported && !incomplete;
  const context = useGrantContext(workflowId, open);
  // An approval that already covers exactly this — the same version, the same
  // environment. A further one is then an extension, and is offered as one.
  const existing =
    review && !unsupported && !activation
      ? existingGrant(context.authorities, reviewVersionId, environment, Date.now())
      : null;
  const scopeWarnings = grantScopeWarnings({
    environment,
    startedIn: context.startedIn,
    savedChange: Boolean(activation),
    activeVersion: context.activeVersion,
  });
  // What removes the refusal, where the gate diagnosis names an act for it.
  // The in-dialog repair above is the stronger offer for the same steps: with
  // it on screen a second repair button would be the same decision twice.
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
      setEnvironment(initialEnvironment);
      startReview(initialEnvironment);
    } else {
      // Closing is a request too: whatever is still loading answers nobody.
      latestReview.current += 1;
      setReview(null);
      setTrialStartedAt(null);
      prepare.reset();
    }
  }
  const requested = useRef(openRequest);
  // A request is the number changing, nothing else; openDialog is this render's own.
  useEffect(() => {
    if (openRequest === undefined || openRequest === requested.current) return;
    requested.current = openRequest;
    if (!disabled) openDialog(true);
  }, [openRequest]);
  return (
    <Dialog open={open} onOpenChange={openDialog}>
      {openRequest === undefined && (
        <DialogTrigger asChild>
          <Button
            variant={triggerVariant}
            size="sm"
            disabled={disabled}
            data-testid={triggerTestId}
          >
            {triggerLabel ?? t(onGrant ? "decisions.applyAndAuthorize" : "authority.grantOpen")}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent
        closeLabel={t("common.close")}
        className="flex max-h-[85svh] flex-col overflow-hidden sm:max-w-2xl"
      >
        <DialogHeader className="-mx-4 -mt-4 shrink-0 bg-accent/10 px-4 py-4 pr-12">
          <DialogTitle data-testid="authority-dialog-title">
            {existing
              ? t(
                  existing.remaining_runs === 1
                    ? "authority.existing.titleOne"
                    : "authority.existing.title",
                  {
                    until: dateTime(existing.valid_until),
                    runs: existing.remaining_runs,
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
                )}
          </DialogTitle>
          <DialogDescription>
            {existing
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
                )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          {reviewContent}
          <GrantScopeWarnings warnings={scopeWarnings} />
          {recurringContent &&
            publications.map((publication, index) => (
              <Alert key={index} data-testid="authority-content-boundary" className="bg-accent/10">
                <AlertTitle>
                  {t("authority.content.members", {
                    count: publication.sources.reduce((n, source) => n + source.item_ids.length, 0),
                  })}
                </AlertTitle>
                <AlertDescription>
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
                </AlertDescription>
              </Alert>
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
            <Alert data-testid="authority-report-boundary" className="bg-accent/10">
              <AlertTitle>{t("authority.report.recipients")}</AlertTitle>
              <AlertDescription>
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
              </AlertDescription>
            </Alert>
          )}
          {/* The reasons, wherever the version cannot be approved — not only on
              the surface that has no approve button. A reviewer who cannot see
              why is being asked to judge something they cannot see. */}
          {unsupported && issues.length > 0 && (
            <Alert data-testid="authority-issues">
              <AlertTitle>{t("authority.issuesTitle")}</AlertTitle>
              <AlertDescription>
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
                      {/* The engine's own reason when it gave one, and the
                          blanket code only when it did not. Showing both would
                          print two different statements about the same step —
                          one of which says the target is unbounded for a step
                          whose address is a constant. */}
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
              </AlertDescription>
            </Alert>
          )}
          {unsupported && issues.length === 0 && !onSingleRun && (
            <Alert data-testid="authority-needs-adjustment">
              <AlertTitle>{t("schedules.held.status")}</AlertTitle>
              <AlertDescription>
                {t("authority.unsupportedSteps", {
                  steps: review?.unavailable_steps.join(", ") || t("authority.effects"),
                })}
              </AlertDescription>
            </Alert>
          )}
          {/* The refusal used to end at "investigate the cause in the chat" — a
              technical question handed to the one person who cannot answer it.
              SubKit has read what these steps really did; this is it saying so
              and offering to write it down. Approving stays a human act. */}
          {unsupported && (repairable.data?.proposals?.length ?? 0) > 0 && (
            <Alert data-testid="authority-repair" className="bg-accent/10">
              <AlertTitle>{t("authority.repairTitle")}</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-3">
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
                  size="sm"
                  disabled={busy || repair.isPending}
                  onClick={() => repair.mutate()}
                  data-testid="authority-repair-apply"
                >
                  {t(repair.isPending ? "authority.repairWorking" : "authority.repairAction")}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {incomplete && !unsupported && (
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
              // Six minutes of "loading" is what sent people to a second tab.
              // The counter is the part that makes waiting bearable: it says
              // this is still moving, without claiming to know how long it
              // takes — nothing here can know that.
              <Alert data-testid="authority-trial-running" className="bg-accent/10">
                <AlertTitle>{t("authority.trial.title")}</AlertTitle>
                <AlertDescription>
                  <p>{t("authority.trial.what")}</p>
                  <p role="status">{t("authority.trial.elapsed", { seconds: elapsed })}</p>
                </AlertDescription>
              </Alert>
            ))}
          {trialElsewhere && !prepare.isPending && (
            <Alert data-testid="authority-trial-elsewhere" className="bg-accent/10">
              <AlertTitle>{t("authority.trial.title")}</AlertTitle>
              <AlertDescription>{t("authority.trial.alreadyRunning")}</AlertDescription>
            </Alert>
          )}
          {sample && !prepare.isPending && (
            <Alert data-testid="authority-sample" className="bg-accent/10">
              <AlertTitle>{t("authority.sample.title", { slug: sample.slug })}</AlertTitle>
              <AlertDescription className="flex flex-col gap-3">
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
              </AlertDescription>
            </Alert>
          )}
          {prepare.error && sampleRefused === null && (
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
                      {/* What happens and where it happens lead; the authored
                          step id follows as provenance. It used to lead, and a
                          reader deciding whether to approve was met with
                          `fetch_route` — an identifier that answers a different
                          question than the one they are being asked. Nothing is
                          hidden and nothing is invented: every part of this was
                          already on screen, in the wrong order. */}
                      <p className="font-medium">
                        {t(AUTHORITY_EFFECT_KEYS[effect.effect])}
                        {" · "}
                        {effect.connector_id
                          ? (connectors.data?.items.find(
                              (connector) => connector.id === effect.connector_id,
                            )?.name ?? t("authority.configuredConnector"))
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
              <AlertTitle>
                {t(sessionExpired ? "authority.sessionExpired" : "authority.grantFailed")}
              </AlertTitle>
              <AlertDescription>
                {t(
                  sessionExpired
                    ? "authority.sessionExpiredHint"
                    : "authority.grantFailedDescription",
                )}
              </AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter className="shrink-0">
          <Button
            variant="outline"
            disabled={submitting}
            onClick={() => openDialog(false)}
            data-testid="authority-grant-cancel"
          >
            {t("common.cancel")}
          </Button>
          {sessionExpired && (
            <Button asChild data-testid="authority-sign-in">
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
          {/* Two different decisions, and a reader must be able to make the
              smaller one. Putting a repaired version into service is not the
              same as permitting repeated unattended runs — a called child
              needs only the first, and forcing them together would make
              every activation buy a permission nobody asked for.

              Which is why it sits OUTSIDE the branch below. It used to live in
              the approvable half only, so a version with one step still
              unbound could not be put into service at all — and a child whose
              other steps the repair had just bound stayed on its old version
              because of the one step nobody could bind. The engine never asked
              for that: `activate-draft` checks that the reviewed digest still
              matches and nothing else, and authorizes no run.

              Not while the review is stale or the session is gone: the smaller
              decision is still a decision, and offering it when it cannot be
              carried out is offering a dead button. */}
          {activation && review && !incomplete && !sessionExpired && !actionError && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => activateOnly.mutate()}
              data-testid="authority-activate-only"
            >
              {t("authority.activateOnly")}
            </Button>
          )}
          {unsupported ? (
            <>
              {onAdjust ? (
                <Button
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
