import { contextualHref } from "@/app/installation-context";
import { absolute, runHref, workflowRunHref } from "@/app/links";
import { Button, ChatCard, type Fact } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import type { ChatWorkflowRef } from "../model/preview-cards";
import type { ChatSensitiveTestRun } from "../model/test-run";
import { ChatCardTitle, ChatWorkflowMention } from "./sensitive-preview-card";

export function ChatTestRunCard({
  run,
  saved = null,
  latest = true,
  testId = "chat-test-run-card",
}: {
  run: ChatSensitiveTestRun;
  saved?: ChatWorkflowRef | null;
  latest?: boolean;
  testId?: string;
}) {
  const { t } = useI18n();
  const facts: Fact[] = [
    {
      label: t("chat.testRun.steps"),
      value: t("chat.testRun.stepCounts", {
        succeeded: run.steps.succeeded,
        failed: run.steps.failed,
        held: run.steps.held,
      }),
      testId: "chat-test-run-steps",
    },
    ...run.reads.map((read) => ({
      label: t("chat.testRun.read", { step: read.step }),
      value: t(read.complete ? "chat.testRun.itemsComplete" : "chat.testRun.itemsTruncated", {
        count: read.items,
      }),
      testId: `chat-test-run-read-${read.step}`,
    })),
    ...(run.checks === "none"
      ? []
      : [
          {
            label: t("chat.testRun.checks"),
            value: t(
              run.checks === "passed" ? "chat.testRun.checksPassed" : "chat.testRun.checksFailed",
            ),
            testId: "chat-test-run-checks",
          },
        ]),
  ];
  const title = t(run.succeeded ? "chat.testRun.succeeded" : "chat.testRun.failed");
  const verifiable = run.succeeded && saved !== null && latest;
  return (
    <ChatCard
      testId={testId}
      title={
        saved ? (
          <ChatCardTitle
            title={title}
            mention={<ChatWorkflowMention workflow={saved} testId={`${testId}-workflow`} />}
          />
        ) : (
          title
        )
      }
      line={t("chat.testRun.confidential")}
      facts={facts}
      action={
        verifiable && saved ? (
          <Button asChild className="w-full sm:w-auto">
            <a
              href={contextualHref(
                absolute(run.executionId ? runHref(run.executionId) : workflowRunHref(saved.id)),
              )}
              data-testid={`${testId}-verify`}
            >
              {t("chat.preview.verify")}
            </a>
          </Button>
        ) : null
      }
    />
  );
}
