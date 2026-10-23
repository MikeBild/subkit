import { ChatCard, type Fact } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import type { ChatSensitiveTestRun } from "./chat-test-run";

export function ChatTestRunCard({ run }: { run: ChatSensitiveTestRun }) {
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
  return (
    <ChatCard
      testId="chat-test-run-card"
      title={t(run.succeeded ? "chat.testRun.succeeded" : "chat.testRun.failed")}
      line={t("chat.testRun.confidential")}
      facts={facts}
      action={null}
    />
  );
}
