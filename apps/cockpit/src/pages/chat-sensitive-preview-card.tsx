import { CircleCheck, TriangleExclamationPoint } from "lucide-react";
import type { ReactNode } from "react";
import { contextualHref } from "@/app/installation-context";
import { absolute, workflowHref, workflowRunHref } from "@/app/links";
import { TYPE_ICON } from "@/components/cockpit/mention-picker";
import { Button, ChatCard, Chip } from "@/components/cockpit/patterns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import {
  type ChatSensitivePreview,
  type ChatWorkflowRef,
  PREVIEW_STAGES,
  type PreviewStage,
  workflowMention,
} from "./chat-preview-cards";

const STAGE_KEYS: Record<PreviewStage, TranslationKey> = {
  schema_only: "chat.preview.stage.schemaOnly",
  redacted_fixture: "chat.preview.stage.redacted",
  person_verified: "chat.preview.stage.person",
};

const WorkflowIcon = TYPE_ICON.workflow;

export function ChatWorkflowMention({
  workflow,
  testId,
}: {
  workflow: ChatWorkflowRef | null;
  testId: string;
}) {
  const token = workflowMention(workflow);
  if (!workflow || !token) return null;
  return (
    <a
      href={contextualHref(absolute(workflowHref(workflow.id)))}
      className="inline-flex min-w-0 items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground hover:underline [&>svg]:size-3"
      data-testid={testId}
    >
      <WorkflowIcon aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 truncate">{token}</span>
    </a>
  );
}

export function ChatCardTitle({ title, mention }: { title: string; mention: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <span className="min-w-0">{title}</span>
      {mention}
    </span>
  );
}

function CheckItem({ ok, children, testId }: { ok: boolean; children: string; testId: string }) {
  const Icon = ok ? CircleCheck : TriangleExclamationPoint;
  return (
    <li className="flex min-w-0 items-start gap-2" data-testid={testId} data-ok={ok}>
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0",
          ok ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400",
        )}
      />
      <span className="min-w-0 break-words">{children}</span>
    </li>
  );
}

export function ChatSensitivePreviewCard({
  preview,
  saved = null,
  testId = "chat-sensitive-preview-card",
}: {
  preview: ChatSensitivePreview;
  saved?: ChatWorkflowRef | null;
  testId?: string;
}) {
  const { t, tn } = useI18n();
  const workflow = saved ?? preview.workflow;
  const verifiable =
    workflow !== null && preview.passed && (saved !== null || !preview.saveRequired);
  return (
    <ChatCard
      testId={testId}
      title={
        <ChatCardTitle
          title={t("chat.preview.title")}
          mention={<ChatWorkflowMention workflow={workflow} testId={`${testId}-workflow`} />}
        />
      }
      line={t(preview.passed ? "chat.preview.passed" : "chat.preview.failed")}
      action={
        verifiable && workflow ? (
          <Button asChild className="w-full sm:w-auto">
            <a
              href={contextualHref(absolute(workflowRunHref(workflow.id)))}
              data-testid={`${testId}-verify`}
            >
              {t("chat.preview.verify")}
            </a>
          </Button>
        ) : null
      }
    >
      <ol className="flex flex-wrap gap-1.5" data-testid={`${testId}-stages`}>
        {PREVIEW_STAGES.map((stage) => {
          const active = stage === preview.stage;
          return (
            <li key={stage} className="min-w-0">
              <Chip
                aria-current={active ? "step" : undefined}
                data-active={active}
                testId={`${testId}-stage-${stage}`}
                className={cn(
                  active
                    ? "border-accent/30 bg-accent/10 font-medium text-accent"
                    : "text-muted-foreground",
                )}
              >
                <span className="min-w-0 truncate">{t(STAGE_KEYS[stage])}</span>
              </Chip>
            </li>
          );
        })}
      </ol>
      <ul className="flex flex-col gap-1.5 text-sm" data-testid={`${testId}-checks`}>
        <CheckItem ok testId={`${testId}-check-structure`}>
          {tn("chat.preview.check.structure", preview.steps)}
        </CheckItem>
        <CheckItem ok={preview.compileErrors === 0} testId={`${testId}-check-expressions`}>
          {preview.compileErrors === 0
            ? tn("chat.preview.check.expressions", preview.expressions)
            : tn("chat.preview.check.compileErrors", preview.compileErrors)}
        </CheckItem>
        {preview.requestsHeld ? (
          <CheckItem ok testId={`${testId}-check-held`}>
            {t("chat.preview.check.held")}
          </CheckItem>
        ) : null}
      </ul>
      <p className="text-xs text-muted-foreground" data-testid={`${testId}-note`}>
        {t(verifiable ? "chat.preview.note" : "chat.preview.noteUnsaved")}
      </p>
    </ChatCard>
  );
}
