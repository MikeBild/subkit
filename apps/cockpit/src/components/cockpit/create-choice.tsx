import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquare, PencilLine } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, chatNewHref, connectorHref, workflowHref } from "@/app/links";
import { useSession } from "@/app/session";
import {
  afterCreateTab,
  type ConnectorSignIn,
  type ConnectorTarget,
  connectorCreateBody,
  EMPTY_OAUTH_CLIENT,
  manualConnectorProblem,
  needsOAuthClient,
  needsSecret,
  type OAuthClientFields,
} from "@/components/cockpit/create-connector-model";
import {
  ChoiceField,
  CopyValueField,
  SelectField,
  TextField,
} from "@/components/cockpit/form-field";
import { ActionButton, ChoiceCards, FormDialog } from "@/components/cockpit/patterns";
import { ScheduleFields } from "@/components/cockpit/workflow-schedule";
import { connectorSignIn, signInFailure } from "@/lib/connector-sign-in";
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
type Step = "choose" | "manual";

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
  const [step, setStep] = useState<Step>(canChat ? "choose" : "manual");
  const [error, setError] = useState<string | null>(null);
  const done = () => onOpenChange(false);
  const workflow = useManualWorkflow(open && kind === "workflow", done, setError);
  const connector = useManualConnector(done, setError);
  const manual = kind === "workflow" ? workflow : connector;
  const close = (next: boolean) => {
    if (manual.pending) return;
    onOpenChange(next);
    if (!next) {
      setStep(canChat ? "choose" : "manual");
      setError(null);
      manual.reset();
    }
  };
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
            {
              icon: <MessageSquare />,
              title: t(kind === "workflow" ? "create.workflow.chat" : "create.connector.chat"),
              line: t(
                kind === "workflow" ? "create.workflow.chatLine" : "create.connector.chatLine",
              ),
              onSelect: () =>
                window.location.assign(
                  absolute(
                    chatNewHref({
                      prompt: t(
                        kind === "workflow" ? "create.workflow.prompt" : "create.connector.prompt",
                      ),
                    }),
                  ),
                ),
              testId: `create-${kind}-chat`,
            },
            {
              icon: <PencilLine />,
              title: t("create.byHand"),
              line: t(
                kind === "workflow" ? "create.workflow.byHandLine" : "create.connector.byHandLine",
              ),
              onSelect: () => setStep("manual"),
              testId: `create-${kind}-manual`,
            },
          ]}
        />
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
      {...(canChat
        ? {
            back: {
              label: t("create.back"),
              onClick: () => {
                setStep("choose");
                setError(null);
              },
            },
          }
        : {})}
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
      const base = slugify(name);
      const slug =
        category !== UNCATEGORIZED && !base.startsWith(`${category}-`)
          ? `${category}-${base}`
          : base;
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
        body: JSON.stringify({ definition }),
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
  const navigate = useNavigate();
  const client = useQueryClient();
  const callbackUrl = useSession().oauth_callback_url;
  const [target, setTarget] = useState<ConnectorTarget>("web");
  const [signIn, setSignIn] = useState<ConnectorSignIn>("account");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [secret, setSecret] = useState("");
  const [oauth, setOAuth] = useState<OAuthClientFields>(EMPTY_OAUTH_CLIENT);
  const oauthField = (key: keyof OAuthClientFields) => (value: string) =>
    setOAuth((current) => ({ ...current, [key]: value }));
  const reset = () => {
    setTarget("web");
    setSignIn("account");
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
      await client.invalidateQueries({ queryKey: ["catalog"] });
      await client.invalidateQueries({ queryKey: ["connectors", "lookup"] });
      const page = `${connectorHref(connector.id)}?tab=${afterCreateTab(target)}`;
      const route = connectorSignIn(connector);
      if (route) {
        try {
          const start = await apiRequest<{ authorization_url: string }>(route.start, {
            method: "POST",
          });
          if (start.authorization_url) {
            window.location.assign(start.authorization_url);
            return;
          }
          toast.success(t("create.connector.connected", { name: connector.display_name }));
        } catch (failure) {
          toast.error(signInFailure(failure, t));
        }
        void navigate({ to: page });
        return;
      }
      toast.success(
        t(needsSecret(signIn) ? "create.connector.connected" : "create.connector.created", {
          name: connector.display_name,
        }),
      );
      void navigate({ to: page });
    },
    onError: (failure) => fail(refusal(failure, t("create.connector.taken"), t)),
  });
  const oauthFields = needsOAuthClient(target, signIn);
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
        <ChoiceField<ConnectorSignIn>
          label={t("create.connector.signIn")}
          value={signIn}
          onChange={setSignIn}
          help={t("create.connector.signInHelp")}
          testId="create-connector-signin"
          options={[
            { value: "account", label: t("create.connector.signIn.account") },
            { value: "key", label: t("create.connector.signIn.key") },
            { value: "none", label: t("create.connector.signIn.none") },
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
        {needsSecret(signIn) ? (
          <TextField
            id="create-connector-secret"
            type="password"
            label={t("create.connector.secret")}
            placeholder={t("create.connector.secretPlaceholder")}
            value={secret}
            onChange={setSecret}
          />
        ) : null}
        {oauthFields && callbackUrl ? (
          <CopyValueField
            id="create-connector-callback"
            label={t("create.connector.callback")}
            value={callbackUrl}
            copyLabel={t("create.connector.copyCallback")}
            help={t("create.connector.callbackHelp")}
          />
        ) : null}
        {oauthFields ? (
          <>
            <TextField
              id="create-connector-issuer"
              type="url"
              label={t("create.connector.issuer")}
              placeholder="https://accounts.example.com"
              help={t("create.connector.issuerHelp")}
              value={oauth.issuer}
              onChange={oauthField("issuer")}
              mono
            />
            <TextField
              id="create-connector-client-id"
              label={t("create.connector.clientId")}
              value={oauth.clientId}
              onChange={oauthField("clientId")}
              mono
            />
            <TextField
              id="create-connector-client-secret"
              type="password"
              label={t("create.connector.clientSecret")}
              placeholder={t("create.connector.secretPlaceholder")}
              value={oauth.clientSecret}
              onChange={oauthField("clientSecret")}
            />
            <TextField
              id="create-connector-scopes"
              label={t("create.connector.scopes")}
              placeholder={t("create.connector.scopesPlaceholder")}
              value={oauth.scopes}
              onChange={oauthField("scopes")}
              mono
            />
          </>
        ) : null}
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
