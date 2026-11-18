import { Sparkles } from "lucide-react";
import { useState } from "react";
import { absolute, chatNewHref } from "@/app/links";
import { CreateChoiceDialog } from "@/components/cockpit/create-choice";
import { SolutionGallery, useSolutionTemplates } from "@/components/cockpit/create-from-template";
import { ActionButton, Input, OnboardingFrame, Section } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";

const GALLERY_SIZE = 6;

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
