import { Sparkles } from "lucide-react";
import { useState } from "react";
import { absolute, chatNewHref } from "@/app/links";
import { useConnectorRecords } from "@/components/cockpit/connector-names";
import { CreateChoiceDialog } from "@/components/cockpit/create-choice";
import { SolutionGallery, useSolutionTemplates } from "@/components/cockpit/create-from-template";
import {
  ActionButton,
  Input,
  OnboardingFrame,
  Section,
  StartChecklist,
  type StartStep,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";

const GALLERY_SIZE = 6;

export function workflowStartSteps(
  t: ReturnType<typeof useI18n>["t"],
  facts: { connectors: number; workflows: number },
): StartStep[] {
  return [
    {
      title: t("workflowOnboarding.step.connect"),
      line: t("workflowOnboarding.step.connectLine"),
      href: "/connectors",
      done: facts.connectors > 0,
    },
    {
      title: t("workflowOnboarding.step.template"),
      line: t("workflowOnboarding.step.templateLine"),
      href: "/workflows",
      done: facts.workflows > 0,
    },
    {
      title: t("workflowOnboarding.step.trial"),
      line: t("workflowOnboarding.step.trialLine"),
      href: "/workflows",
      done: false,
    },
    {
      title: t("workflowOnboarding.step.approve"),
      line: t("workflowOnboarding.step.approveLine"),
      href: "/workflows",
      done: false,
    },
  ];
}

function AskBox() {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const start = () =>
    window.location.assign(
      absolute(chatNewHref({ prompt: text.trim() || t("create.workflow.prompt") })),
    );
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        start();
      }}
      data-testid="workflow-onboarding-ask"
    >
      <div className="flex items-center gap-2 rounded-xl border p-1.5 focus-within:ring-2 focus-within:ring-ring/40">
        <Sparkles aria-hidden="true" className="ml-2 size-4 shrink-0 text-muted-foreground" />
        <Input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t("workflowOnboarding.ask")}
          aria-label={t("workflowOnboarding.ask")}
          className="h-10 flex-1 border-0 shadow-none focus-visible:ring-0"
          data-testid="workflow-onboarding-ask-input"
        />
        <ActionButton type="submit" testId="workflow-onboarding-ask-submit">
          {t("workflowOnboarding.askAction")}
        </ActionButton>
      </div>
      <p className="text-xs text-muted-foreground">{t("workflowOnboarding.askExample")}</p>
    </form>
  );
}

export function WorkflowOnboarding({ canWrite, canChat }: { canWrite: boolean; canChat: boolean }) {
  const { t } = useI18n();
  const templates = useSolutionTemplates(true);
  const connectors = useConnectorRecords();
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <OnboardingFrame lead={t("workflowOnboarding.lead")} testId="workflow-onboarding">
      {canChat ? <AskBox /> : null}
      <Section label={t("workflowOnboarding.templates")} testId="workflow-onboarding-templates">
        <SolutionGallery
          entries={templates.entries}
          pending={templates.pending}
          failed={templates.failed}
          onRetry={templates.retry}
          onPick={(slug) => (canWrite ? setPicked(slug) : undefined)}
          limit={GALLERY_SIZE}
        />
      </Section>
      <StartChecklist
        steps={workflowStartSteps(t, { connectors: connectors.length, workflows: 0 })}
        testId="workflow-start-checklist"
      />
      {canWrite ? (
        <CreateChoiceDialog
          open={picked !== null}
          onOpenChange={(next) => !next && setPicked(null)}
          canChat={canChat}
          initialTemplate={picked}
        />
      ) : null}
    </OnboardingFrame>
  );
}
