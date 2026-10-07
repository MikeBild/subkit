import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LayoutTemplate, MessageSquare, PencilLine } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, chatNewHref, workflowHref } from "@/app/links";
import { useSession } from "@/app/session";
import { ConnectorSignInFields } from "@/components/cockpit/connector-sign-in-fields";
import {
  afterCreateTab,
  type ConnectorSignIn,
  type ConnectorTarget,
  connectorCreateBody,
  DEFAULT_SIGN_IN,
  EMPTY_OAUTH_CLIENT,
  manualConnectorProblem,
  needsSecret,
  type OAuthClientFields,
} from "@/components/cockpit/create-connector-model";
import {
  useConnectorFinish,
  useConnectorTemplateFlow,
  useSolutionFlow,
} from "@/components/cockpit/create-from-template";
import { ChoiceField, SelectField, TextField } from "@/components/cockpit/form-field";
import { ActionButton, ChoiceCards, FormDialog } from "@/components/cockpit/patterns";
import { ScheduleFields } from "@/components/cockpit/workflow-schedule";
import { useI18n } from "@/lib/i18n-context";
import { DEFAULT_RHYTHM, type RhythmValue, rhythmToCron, validTime } from "@/lib/schedule-rhythm";
import { humanizeCategory, UNCATEGORIZED } from "@/lib/workflow-category";

type WorkflowDraft = components["schemas"]["WorkflowDraft"];
type Connector = components["schemas"]["Connector"];

export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

type Kind = "workflow" | "connector";
type Step = "choose" | "manual" | "template" | "template-detail";

function CreateChoiceDialog({
  kind,
  open,
  onOpenChange,
  canChat,
}: {
  kind: Kind;
  open: boolean;
  onOpenChange(open: boolean): void;
  canChat: boolean;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>("choose");
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = () => onOpenChange(false);
  const taken = t(kind === "workflow" ? "create.workflow.taken" : "create.connector.taken");
  const refuse = (failure: unknown) => refusal(failure, taken, t);
  const workflow = useManualWorkflow(open && kind === "workflow", done, setError);
  const connector = useManualConnector(done, setError);
  const solutions = useSolutionFlow(open && kind === "workflow", done, setError, refuse);
  const templates = useConnectorTemplateFlow(open && kind === "connector", done, setError, refuse);
  const manual = kind === "workflow" ? workflow : connector;
  const flow = kind === "workflow" ? solutions : templates;
  const busy = manual.pending || flow.pending;
  const goTo = (next: Step) => {
    setStep(next);
    setError(null);
  };
  const close = (next: boolean) => {
    if (busy) return;
    onOpenChange(next);
    if (!next) {
      goTo("choose");
      setPicked(null);
      manual.reset();
      flow.reset();
    }
  };
  const back = { label: t("create.back"), onClick: () => goTo("choose") };
  if (step === "choose")
    return (
      <FormDialog
        open={open}
        onOpenChange={close}
        title={t(kind === "workflow" ? "create.workflow.how" : "create.connector.how")}
        size="wide"
        step="choose"
        testId={`create-${kind}-dialog`}
      >
        <ChoiceCards
          items={[
            ...(canChat
              ? [
                  {
                    icon: <MessageSquare />,
                    title: t(
                      kind === "workflow" ? "create.workflow.chat" : "create.connector.chat",
                    ),
                    line: t(
                      kind === "workflow"
                        ? "create.workflow.chatLine"
                        : "create.connector.chatLine",
                    ),
                    onSelect: () =>
                      window.location.assign(
                        absolute(
                          chatNewHref({
                            prompt: t(
                              kind === "workflow"
                                ? "create.workflow.prompt"
                                : "create.connector.prompt",
                            ),
                          }),
                        ),
                      ),
                    testId: `create-${kind}-chat`,
                  },
                ]
              : []),
            {
              icon: <LayoutTemplate />,
              title: t("create.template.card"),
              line: t(
                kind === "workflow"
                  ? "create.workflow.templateLine"
                  : "create.connector.templateLine",
              ),
              onSelect: () => goTo("template"),
              testId: `create-${kind}-template`,
            },
            {
              icon: <PencilLine />,
              title: t("create.byHand"),
              line: t(
                kind === "workflow" ? "create.workflow.byHandLine" : "create.connector.byHandLine",
              ),
              onSelect: () => goTo("manual"),
              testId: `create-${kind}-manual`,
            },
          ]}
        />
      </FormDialog>
    );
  const detail = step === "template-detail" && picked ? flow.detail(picked) : null;
  if (step === "template" || (step === "template-detail" && !detail))
    return (
      <FormDialog
        open={open}
        onOpenChange={close}
        title={t("create.template.pickTitle")}
        description={t(
          kind === "workflow"
            ? "create.workflow.templateDescription"
            : "create.connector.templateDescription",
        )}
        size="wide"
        step="template"
        back={back}
        testId={`create-${kind}-dialog`}
      >
        {flow.list((slug) => {
          setPicked(slug);
          goTo("template-detail");
        })}
      </FormDialog>
    );
  if (detail && picked)
    return (
      <FormDialog
        open={open}
        onOpenChange={close}
        title={detail.title}
        description={detail.description}
        size="wide"
        step="template-detail"
        back={{ label: t("create.template.all"), onClick: () => goTo("template") }}
        submit={{
          label: t(kind === "workflow" ? "create.create" : "create.template.connect"),
          pending: flow.pending,
        }}
        onSubmit={() => {
          setError(null);
          flow.submit(picked);
        }}
        error={error}
        testId={`create-${kind}-dialog`}
      >
        {detail.body}
      </FormDialog>
    );
  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      title={t(
        kind === "workflow" ? "create.workflow.byHandTitle" : "create.connector.byHandTitle",
      )}
      size="wide"
      step="manual"
      back={back}
      submit={{ label: t("create.create"), pending: manual.pending }}
      onSubmit={() => {
        setError(null);
        manual.submit();
      }}
      error={error}
      testId={`create-${kind}-dialog`}
    >
      {manual.fields}
    </FormDialog>
  );
}

interface ManualForm {
  fields: ReactNode;
  submit(): void;
  reset(): void;
  pending: boolean;
}

function refusal(failure: unknown, taken: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (failure instanceof ApiError && failure.status === 409) return taken;
  if (failure instanceof ApiError && failure.message)
    return t("stepEditor.refused", { reason: failure.message });
  return t("common.actionFailed");
}

type WorkflowTrigger = "webhook" | "schedule" | "request";

function useManualWorkflow(
  active: boolean,
  done: () => void,
  fail: (error: string) => void,
): ManualForm {
  const { t } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [trigger, setTrigger] = useState<WorkflowTrigger>("webhook");
  const [rhythm, setRhythm] = useState<RhythmValue>(DEFAULT_RHYTHM);
  const [category, setCategory] = useState(UNCATEGORIZED);
  const categories = useQuery({
    queryKey: ["workflow-categories"],
    enabled: active,
    queryFn: () =>
      apiRequest<{ categories?: { category: string; count: number }[] }>("/v1/workflows?limit=1"),
  });
  const reset = () => {
    setName("");
    setPurpose("");
    setTrigger("webhook");
    setRhythm(DEFAULT_RHYTHM);
    setCategory(UNCATEGORIZED);
  };
  const create = useMutation({
    mutationFn: () => {
      const slug = slugify(name);
      const definition = {
        name: name.trim(),
        slug,
        ...(purpose.trim() ? { description: purpose.trim() } : {}),
        steps: [{ id: "start", kind: "transform", expression: "return input;" }],
        trigger:
          trigger === "schedule"
            ? {
                kind: "schedule",
                cron: rhythmToCron(rhythm),
                tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
              }
            : trigger === "webhook"
              ? { kind: "webhook", source: slug, events: [], verify: "none" }
              : { kind: "request" },
      };
      return apiRequest<WorkflowDraft>("/v1/workflows/drafts", {
        method: "POST",
        body: JSON.stringify({
          definition,
          ...(category !== UNCATEGORIZED ? { category } : {}),
        }),
      });
    },
    onSuccess: async (draft) => {
      toast.success(t("create.workflow.created", { name: name.trim() }));
      done();
      reset();
      await client.invalidateQueries({ queryKey: ["catalog"] });
      void navigate({ to: `${workflowHref(draft.workflow_id)}?tab=structure` });
    },
    onError: (failure) => fail(refusal(failure, t("create.workflow.taken"), t)),
  });
  const blocks = (categories.data?.categories ?? []).filter(
    (entry) => entry.category !== UNCATEGORIZED,
  );
  return {
    pending: create.isPending,
    reset,
    submit: () => {
      if (!slugify(name)) return fail(t("create.nameMissing"));
      if (trigger === "schedule" && !validTime(rhythm.time)) return fail(t("schedule.timeInvalid"));
      create.mutate();
    },
    fields: (
      <>
        <TextField
          id="create-workflow-name"
          label={t("create.name")}
          placeholder={t("create.workflow.namePlaceholder")}
          value={name}
          onChange={setName}
        />
        <TextField
          id="create-workflow-purpose"
          label={t("create.workflow.purpose")}
          placeholder={t("create.workflow.purposePlaceholder")}
          value={purpose}
          onChange={setPurpose}
        />
        <ChoiceField<WorkflowTrigger>
          label={t("create.workflow.trigger")}
          value={trigger}
          onChange={setTrigger}
          testId="create-workflow-trigger"
          options={[
            { value: "webhook", label: t("create.workflow.webhook") },
            { value: "schedule", label: t("create.workflow.schedule") },
            { value: "request", label: t("create.workflow.onRequest") },
          ]}
        />
        {trigger === "schedule" ? <ScheduleFields value={rhythm} onChange={setRhythm} /> : null}
        <SelectField
          id="create-workflow-category"
          label={t("create.workflow.category")}
          value={category}
          onChange={setCategory}
          options={[
            { value: UNCATEGORIZED, label: t("catalog.categoryOther") },
            ...blocks.map((entry) => ({
              value: entry.category,
              label: humanizeCategory(entry.category, t("catalog.categoryOther")),
            })),
          ]}
        />
      </>
    ),
  };
}

function useManualConnector(done: () => void, fail: (error: string) => void): ManualForm {
  const { t } = useI18n();
  const finish = useConnectorFinish();
  const callbackUrl = useSession().oauth_callback_url;
  const [target, setTarget] = useState<ConnectorTarget>("web");
  const [signIn, setSignIn] = useState<ConnectorSignIn>(DEFAULT_SIGN_IN);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [secret, setSecret] = useState("");
  const [oauth, setOAuth] = useState<OAuthClientFields>(EMPTY_OAUTH_CLIENT);
  const reset = () => {
    setTarget("web");
    setSignIn(DEFAULT_SIGN_IN);
    setName("");
    setAddress("");
    setSecret("");
    setOAuth(EMPTY_OAUTH_CLIENT);
  };
  const create = useMutation({
    mutationFn: async () => {
      const connector = await apiRequest<Connector>("/v1/connectors", {
        method: "POST",
        body: JSON.stringify(
          connectorCreateBody({ target, signIn, name, slug: slugify(name), address, oauth }),
        ),
      });
      if (needsSecret(signIn))
        await apiRequest(`/v1/connectors/${encodeURIComponent(connector.id)}/credentials`, {
          method: "POST",
          body: JSON.stringify({ mode: "bearer", token: secret.trim() }),
        });
      return connector;
    },
    onSuccess: async (connector) => {
      done();
      reset();
      await finish(connector, { keyed: needsSecret(signIn), tab: afterCreateTab(target) });
    },
    onError: (failure) => fail(refusal(failure, t("create.connector.taken"), t)),
  });
  return {
    pending: create.isPending,
    reset,
    submit: () => {
      const problem = manualConnectorProblem({
        target,
        signIn,
        slug: slugify(name),
        address,
        secret,
        oauth,
        callbackUrl,
      });
      if (problem) return fail(t(problem));
      create.mutate();
    },
    fields: (
      <>
        <ChoiceField<ConnectorTarget>
          label={t("create.connector.target")}
          value={target}
          onChange={setTarget}
          help={t("create.connector.targetHelp")}
          testId="create-connector-target"
          options={[
            { value: "web", label: t("create.connector.target.web") },
            { value: "mcp", label: t("create.connector.target.mcp") },
          ]}
        />
        <TextField
          id="create-connector-name"
          label={t("create.name")}
          placeholder={t("create.connector.namePlaceholder")}
          value={name}
          onChange={setName}
        />
        <TextField
          id="create-connector-address"
          type="url"
          label={t("create.connector.address")}
          placeholder={target === "mcp" ? "https://mcp.example.com/mcp" : "https://api.example.com"}
          value={address}
          onChange={setAddress}
          mono
        />
        <ConnectorSignInFields
          idPrefix="create-connector"
          testId="create-connector-signin"
          target={target}
          signIn={signIn}
          onSignIn={(next) => setSignIn(next ?? DEFAULT_SIGN_IN)}
          secret={secret}
          onSecret={setSecret}
          keepsKey={false}
          keepsClientSecret={false}
          oauth={oauth}
          onOAuth={setOAuth}
          callbackUrl={callbackUrl}
        />
      </>
    ),
  };
}

export function CreateAction({
  kind,
  canChat,
  size = "default",
  testId,
}: {
  kind: Kind;
  canChat: boolean;
  size?: "default" | "sm";
  testId: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <ActionButton variant="primary" size={size} onClick={() => setOpen(true)} testId={testId}>
        {t(kind === "workflow" ? "resource.workflows.action" : "resource.connectors.action")}
      </ActionButton>
      <CreateChoiceDialog kind={kind} open={open} onOpenChange={setOpen} canChat={canChat} />
    </>
  );
}
