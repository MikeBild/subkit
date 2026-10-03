import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquare, PencilLine } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, chatNewHref, connectorHref, workflowHref } from "@/app/links";
import { ChoiceField, SelectField, TextField } from "@/components/cockpit/form-field";
import { ActionButton, ChoiceCard, FormDialog } from "@/components/cockpit/patterns";
import { ScheduleFields } from "@/components/cockpit/workflow-schedule";
import { useI18n } from "@/lib/i18n-context";
import { DEFAULT_RHYTHM, type RhythmValue, rhythmToCron, validTime } from "@/lib/schedule-rhythm";
import { humanizeCategory, UNCATEGORIZED } from "@/lib/workflow-category";

type WorkflowDraft = components["schemas"]["WorkflowDraft"];
type Connector = components["schemas"]["Connector"];

/** A name as a slug: lowercase words joined by "-". */
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

/**
 * "Workflow erstellen" / "Konnektor hinzufügen" (R16, R19): one dialog of two
 * steps for both. First two ChoiceCards — the chat or by hand — and only
 * "Abbrechen"; choosing the chat opens it, choosing by hand shows the form
 * with "‹ Zurück" and "Anlegen".
 */
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
  const title = t(kind === "workflow" ? "resource.workflows.action" : "resource.connectors.action");
  if (step === "choose")
    return (
      <FormDialog
        open={open}
        onOpenChange={close}
        title={title}
        size="wide"
        step="choose"
        testId={`create-${kind}-dialog`}
      >
        <ChoiceCard
          icon={<MessageSquare />}
          title={t(kind === "workflow" ? "create.workflow.chat" : "create.connector.chat")}
          line={t(kind === "workflow" ? "create.workflow.chatLine" : "create.connector.chatLine")}
          onSelect={() =>
            window.location.assign(
              absolute(
                chatNewHref({
                  prompt: t(
                    kind === "workflow" ? "create.workflow.prompt" : "create.connector.prompt",
                  ),
                }),
              ),
            )
          }
          testId={`create-${kind}-chat`}
        />
        <ChoiceCard
          icon={<PencilLine />}
          title={t("create.byHand")}
          line={t(
            kind === "workflow" ? "create.workflow.byHandLine" : "create.connector.byHandLine",
          )}
          onSelect={() => setStep("manual")}
          testId={`create-${kind}-manual`}
        />
      </FormDialog>
    );
  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      title={title}
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

/** A workflow by hand: name, purpose, trigger and category — its steps follow in "Aufbau". */
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
        // A workflow holds at least one step: it starts with one that hands
        // its input on, and "Aufbau" takes it from there.
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
      void navigate({ to: `${workflowHref(draft.workflow_id)}?tab=aufbau` });
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

type ConnectorKind = "oauth" | "mcp" | "key";

/**
 * A connector by hand (R19): kind, name, address and — except for OAuth — the
 * key. OAuth goes on to the provider's sign-in, MCP to its tools, a key to
 * its connection.
 */
function useManualConnector(done: () => void, fail: (error: string) => void): ManualForm {
  const { t } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [kind, setKind] = useState<ConnectorKind>("oauth");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [secret, setSecret] = useState("");
  const reset = () => {
    setKind("oauth");
    setName("");
    setAddress("");
    setSecret("");
  };
  const create = useMutation({
    mutationFn: async () => {
      const connector = await apiRequest<Connector>("/v1/connectors", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          slug: slugify(name),
          driver: kind === "mcp" ? "mcp" : "http",
          environment: "prod",
          base_url: address.trim(),
          auth_type: kind === "oauth" ? "oauth2" : "bearer",
        }),
      });
      // The key is stored as the connector's credential, never in its record.
      if (kind !== "oauth")
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
      const page = connectorHref(connector.id);
      if (kind === "oauth") {
        // The provider's sign-in, straight away; where it cannot start yet,
        // the connection tab says what is missing.
        try {
          const start = await apiRequest<{ authorization_url: string }>(
            `/v1/connectors/${encodeURIComponent(connector.id)}/oauth/start`,
            { method: "POST" },
          );
          window.location.assign(start.authorization_url);
          return;
        } catch {
          toast.success(t("create.connector.created", { name: name.trim() }));
          void navigate({ to: `${page}?tab=verbindung` });
          return;
        }
      }
      if (kind === "mcp") {
        toast.success(t("create.connector.created", { name: name.trim() }));
        void navigate({ to: `${page}?tab=werkzeuge` });
        return;
      }
      toast.success(t("create.connector.connected", { name: name.trim() }));
      void navigate({ to: `${page}?tab=verbindung` });
    },
    onError: (failure) => fail(refusal(failure, t("create.connector.taken"), t)),
  });
  return {
    pending: create.isPending,
    reset,
    submit: () => {
      if (!slugify(name)) return fail(t("create.nameMissing"));
      if (!/^https:\/\/\S+\.\S+/.test(address.trim()))
        return fail(t("create.connector.addressInvalid"));
      if (kind !== "oauth" && !secret.trim()) return fail(t("create.connector.secretMissing"));
      create.mutate();
    },
    fields: (
      <>
        <ChoiceField<ConnectorKind>
          label={t("create.connector.kind")}
          value={kind}
          onChange={setKind}
          testId="create-connector-kind"
          options={[
            { value: "oauth", label: "OAuth" },
            { value: "mcp", label: "MCP" },
            { value: "key", label: t("create.connector.key") },
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
          placeholder="https://api.example.com"
          value={address}
          onChange={setAddress}
          mono
        />
        {kind !== "oauth" ? (
          <TextField
            id="create-connector-secret"
            type="password"
            label={t("create.connector.secret")}
            placeholder={t("create.connector.secretPlaceholder")}
            help={t("create.connector.secretHelp")}
            value={secret}
            onChange={setSecret}
          />
        ) : null}
      </>
    ),
  };
}

/** The list page's one action: opens the choice. */
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
