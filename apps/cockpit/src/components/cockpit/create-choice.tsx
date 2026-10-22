import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarClock,
  Hand,
  LayoutTemplate,
  MessageSquare,
  PencilLine,
  Webhook,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, chatNewHref, workflowHref } from "@/app/links";
import { CreateConnectorDialog } from "@/components/cockpit/create-connector";
import { useSolutionFlow } from "@/components/cockpit/create-from-template";
import { createRefusal, slugify } from "@/components/cockpit/create-refusal";
import { SelectField, TextField } from "@/components/cockpit/form-field";
import {
  ActionButton,
  ChoiceCards,
  FactList,
  Field,
  FieldLabel,
  FormDialog,
  MarkdownEditor,
  WizardProgress,
} from "@/components/cockpit/patterns";
import { ScheduleFields } from "@/components/cockpit/workflow-schedule";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { DEFAULT_RHYTHM, type RhythmValue, rhythmToCron, validTime } from "@/lib/schedule-rhythm";
import { humanizeCategory, UNCATEGORIZED } from "@/lib/workflow-category";

type WorkflowDraft = components["schemas"]["WorkflowDraft"];

type Kind = "workflow" | "connector";
type Step = "choose" | "what" | "when" | "review" | "template" | "template-detail";

const WIZARD_STEPS = ["how", "what", "when", "review"] as const;

const STEP_INDEX: Record<Step, number> = {
  choose: 0,
  what: 1,
  template: 1,
  when: 2,
  review: 3,
  "template-detail": 3,
};

export function CreateChoiceDialog({
  open,
  onOpenChange,
  canChat,
  initialTemplate = null,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  canChat: boolean;
  initialTemplate?: string | null;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>("choose");
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !initialTemplate) return;
    setPicked(initialTemplate);
    setStep("template-detail");
  }, [open, initialTemplate]);
  const [error, setError] = useState<string | null>(null);
  const done = () => onOpenChange(false);
  const refuse = (failure: unknown) => createRefusal(failure, t("create.workflow.taken"), t);
  const manual = useManualWorkflow(open, done, setError);
  const flow = useSolutionFlow(open, done, setError, refuse);
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
  const backTo = (target: Step) => ({ label: t("create.back"), onClick: () => goTo(target) });
  const progress = (
    <WizardProgress
      steps={WIZARD_STEPS.map((entry) => t(`wizard.step.${entry}`))}
      current={STEP_INDEX[step]}
      testId="create-workflow-progress"
    />
  );
  if (step === "choose")
    return (
      <FormDialog
        open={open}
        onOpenChange={close}
        title={t("create.workflow.how")}
        size="wide"
        step="choose"
        testId={"create-workflow-dialog"}
      >
        {progress}
        <ChoiceCards
          items={[
            ...(canChat
              ? [
                  {
                    icon: <MessageSquare />,
                    title: t("create.workflow.chat"),
                    line: t("create.workflow.chatLine"),
                    onSelect: () =>
                      window.location.assign(
                        absolute(
                          chatNewHref({
                            prompt: t("create.workflow.prompt"),
                          }),
                        ),
                      ),
                    testId: "create-workflow-chat",
                  },
                ]
              : []),
            {
              icon: <LayoutTemplate />,
              title: t("create.template.card"),
              line: t("create.workflow.templateLine"),
              onSelect: () => goTo("template"),
              testId: "create-workflow-template",
            },
            {
              icon: <PencilLine />,
              title: t("create.byHand"),
              line: t("create.workflow.byHandLine"),
              onSelect: () => goTo("what"),
              testId: "create-workflow-manual",
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
        description={t("create.workflow.templateDescription")}
        size="wide"
        step="template"
        back={backTo("choose")}
        testId={"create-workflow-dialog"}
      >
        {progress}
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
          label: t("create.create"),
          pending: flow.pending,
        }}
        onSubmit={() => {
          setError(null);
          flow.submit(picked);
        }}
        error={error}
        testId={"create-workflow-dialog"}
      >
        {progress}
        {detail.body}
      </FormDialog>
    );
  if (step === "what")
    return (
      <FormDialog
        open={open}
        onOpenChange={close}
        title={t("create.workflow.whatTitle")}
        size="wide"
        step="what"
        back={backTo("choose")}
        submit={{ label: t("wizard.next"), testId: "create-workflow-next" }}
        onSubmit={() => {
          setError(null);
          if (manual.checkWhat()) goTo("when");
        }}
        error={error}
        testId={"create-workflow-dialog"}
      >
        {progress}
        {manual.what}
      </FormDialog>
    );
  if (step === "when")
    return (
      <FormDialog
        open={open}
        onOpenChange={close}
        title={t("create.workflow.whenTitle")}
        size="wide"
        step="when"
        back={backTo("what")}
        submit={{ label: t("wizard.next"), testId: "create-workflow-next" }}
        onSubmit={() => {
          setError(null);
          if (manual.checkWhen()) goTo("review");
        }}
        error={error}
        testId={"create-workflow-dialog"}
      >
        {progress}
        {manual.when}
      </FormDialog>
    );
  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      title={t("create.workflow.reviewTitle")}
      size="wide"
      step="review"
      back={backTo("when")}
      submit={{ label: t("create.create"), pending: manual.pending }}
      onSubmit={() => {
        setError(null);
        manual.submit();
      }}
      error={error}
      testId={"create-workflow-dialog"}
    >
      {progress}
      {manual.review}
    </FormDialog>
  );
}

interface ManualForm {
  what: ReactNode;
  when: ReactNode;
  review: ReactNode;
  checkWhat(): boolean;
  checkWhen(): boolean;
  submit(): void;
  reset(): void;
  pending: boolean;
}

type WorkflowTrigger = "webhook" | "schedule" | "request";

const TRIGGER_CARDS: readonly {
  value: WorkflowTrigger;
  icon: ReactNode;
  title: TranslationKey;
  line: TranslationKey;
}[] = [
  {
    value: "request",
    icon: <Hand />,
    title: "create.workflow.onRequest",
    line: "workflowFlow.trigger.requestLine",
  },
  {
    value: "schedule",
    icon: <CalendarClock />,
    title: "create.workflow.schedule",
    line: "workflowFlow.trigger.scheduleLine",
  },
  {
    value: "webhook",
    icon: <Webhook />,
    title: "create.workflow.webhook",
    line: "workflowFlow.trigger.webhookLine",
  },
];

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
  const [trigger, setTrigger] = useState<WorkflowTrigger>("request");
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
    setTrigger("request");
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
      void navigate({ to: `${workflowHref(draft.workflow_id)}?tab=overview` });
    },
    onError: (failure) => fail(createRefusal(failure, t("create.workflow.taken"), t)),
  });
  const blocks = (categories.data?.categories ?? []).filter(
    (entry) => entry.category !== UNCATEGORIZED,
  );
  const categoryLabel = humanizeCategory(category, t("catalog.categoryOther"));
  const triggerTitle =
    TRIGGER_CARDS.find((card) => card.value === trigger)?.title ?? "create.workflow.onRequest";
  const checkWhat = () => {
    if (slugify(name)) return true;
    fail(t("create.nameMissing"));
    return false;
  };
  const checkWhen = () => {
    if (trigger !== "schedule" || validTime(rhythm.time)) return true;
    fail(t("schedule.timeInvalid"));
    return false;
  };
  return {
    pending: create.isPending,
    reset,
    checkWhat,
    checkWhen,
    submit: () => {
      if (checkWhat() && checkWhen()) create.mutate();
    },
    what: (
      <>
        <TextField
          id="create-workflow-name"
          label={t("create.name")}
          placeholder={t("create.workflow.namePlaceholder")}
          value={name}
          onChange={setName}
        />
        <Field>
          <FieldLabel htmlFor="create-workflow-purpose">{t("create.workflow.purpose")}</FieldLabel>
          <MarkdownEditor
            id="create-workflow-purpose"
            label={t("create.workflow.purpose")}
            value={purpose}
            onChange={setPurpose}
            placeholder={t("create.workflow.purposePlaceholder")}
            rows={4}
            testId="create-workflow-purpose"
          />
        </Field>
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
    when: (
      <>
        <div data-testid="create-workflow-trigger">
          <ChoiceCards
            items={TRIGGER_CARDS.map((card) => ({
              icon: card.icon,
              title: t(card.title),
              line: t(card.line),
              selected: trigger === card.value,
              onSelect: () => setTrigger(card.value),
              testId: `create-workflow-trigger-${card.value}`,
            }))}
          />
        </div>
        {trigger === "schedule" ? <ScheduleFields value={rhythm} onChange={setRhythm} /> : null}
      </>
    ),
    review: (
      <div className="flex flex-col gap-4" data-testid="create-workflow-review">
        <FactList
          items={[
            { label: t("create.name"), value: name.trim() },
            { label: t("create.workflow.trigger"), value: t(triggerTitle) },
            { label: t("create.workflow.category"), value: categoryLabel },
          ]}
        />
        <p className="text-sm text-muted-foreground">{t("create.workflow.reviewLine")}</p>
      </div>
    ),
  };
}

export function CreateAction({
  kind,
  canChat,
  size = "default",
  variant = "primary",
  testId,
}: {
  kind: Kind;
  canChat: boolean;
  size?: "default" | "sm";
  variant?: "primary" | "outline";
  testId: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <ActionButton variant={variant} size={size} onClick={() => setOpen(true)} testId={testId}>
        {t(kind === "workflow" ? "resource.workflows.action" : "resource.connectors.action")}
      </ActionButton>
      {kind === "workflow" ? (
        <CreateChoiceDialog open={open} onOpenChange={setOpen} canChat={canChat} />
      ) : (
        <CreateConnectorDialog open={open} onOpenChange={setOpen} canChat={canChat} />
      )}
    </>
  );
}
