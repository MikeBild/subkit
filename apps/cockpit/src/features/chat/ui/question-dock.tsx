import type { ConversationDetail } from "@/api/client";
import type { HeldSchedule } from "@/api/decisions";
import { absolute, runHref } from "@/app/links";
import { useSession } from "@/app/session";
import { usePairWaiting, useWaitingOn } from "@/app/use-attention";
import { Button, ChatCard, MessageScrollerItem, StatusStrip } from "@/components/cockpit/patterns";
import { WaitingOnLine } from "@/features/overview";
import { pairRequestedLine } from "@/features/workflows";
import { useI18n } from "@/lib/i18n-context";
import type { ChatTurn } from "../hooks/turn";
import type { ChatApproval } from "../model/approval";
import type { ChatChoice } from "../model/choice";
import type { ChatForm } from "../model/form";
import { liveTestState } from "../model/resume";
import { ChatApprovalCard } from "./approval-card";
import { ChatChoiceCard } from "./choice-card";
import { ChatFormCard } from "./form-card";
import { HeldScheduleAction, heldScheduleCopy } from "./held-schedule";

type ReadySchedule = { ready: boolean; next_run_at: string | null; timezone: string };

export function QuestionDock({
  turn,
  activeId,
  busy,
  status,
  decisionErrorFor,
  unanchoredDecision,
  unanchoredChoice,
  unanchoredForm,
  showPreparation,
  showDraftConflict,
  liveTest,
  showScheduleStep,
  heldTarget,
  targetWorkflowId,
  showProdLiveTest,
  unsaved,
  readyAutomations,
  readySchedules,
}: {
  turn: ChatTurn;
  activeId: string | null;
  busy: boolean;
  status: "streaming" | "ready";
  decisionErrorFor: (id: string | undefined) => boolean;
  unanchoredDecision: ChatApproval | null;
  unanchoredChoice: ChatChoice | null;
  unanchoredForm: ChatForm | null;
  showPreparation: boolean;
  showDraftConflict: boolean;
  liveTest: NonNullable<ConversationDetail["resume_summary"]>["live_test"] | null;
  showScheduleStep: boolean;
  heldTarget: HeldSchedule | undefined;
  targetWorkflowId: string | null;
  showProdLiveTest: boolean;
  unsaved: boolean | undefined;
  readyAutomations: number;
  readySchedules: ReadySchedule[];
}) {
  const { t, locale } = useI18n();
  const permissions = useSession().permissions;
  const waitingOn = useWaitingOn(targetWorkflowId, permissions);
  const pairWaiting = usePairWaiting(targetWorkflowId, permissions);
  const { submitApproval, submitChoice, submitForm, submitTurn } = turn;
  return (
    <MessageScrollerItem data-testid="chat-next-action">
      {unanchoredDecision && (
        <ChatApprovalCard
          approval={unanchoredDecision}
          conversationId={activeId ?? undefined}
          busy={busy}
          error={decisionErrorFor(unanchoredDecision.id)}
          onDecision={submitApproval}
          testId="chat-approval"
        />
      )}
      {unanchoredChoice && (
        <ChatChoiceCard
          choice={unanchoredChoice}
          busy={busy}
          error={decisionErrorFor(unanchoredChoice.id)}
          onAnswer={submitChoice}
          testId="chat-choice"
        />
      )}
      {unanchoredForm && (
        <ChatFormCard
          form={unanchoredForm}
          busy={busy}
          error={decisionErrorFor(unanchoredForm.id)}
          onAnswer={submitForm}
          testId="chat-form"
        />
      )}
      {showPreparation && (
        <ChatCard
          testId="chat-preparation-next-step"
          title={t("chat.preparation.title")}
          line={t("chat.preparation.effect")}
          action={
            <Button
              onClick={() => void submitTurn(t("chat.preparation.prompt"))}
              data-testid="chat-continue-preparation"
            >
              {t("chat.preparation.continue")}
            </Button>
          }
        />
      )}
      {showDraftConflict && (
        <ChatCard
          testId="chat-draft-conflict-next-step"
          title={t("chat.draftConflict.title")}
          line={t("chat.draftConflict.effect")}
          action={
            <Button
              onClick={() => void submitTurn(t("chat.draftConflict.prompt"))}
              data-testid="chat-reconcile-draft-conflict"
            >
              {t("chat.draftConflict.continue")}
            </Button>
          }
        />
      )}
      {liveTest && (
        <ChatCard
          testId="chat-live-test-result"
          title={t("chat.liveTest.title")}
          line={t(`chat.liveTest.${liveTestState(liveTest.status)}`)}
          action={
            <Button asChild variant="outline">
              <a href={absolute(runHref(liveTest.execution_id))} data-testid="chat-live-test-run">
                {t("chat.liveTest.openRun")}
              </a>
            </Button>
          }
        />
      )}

      {showScheduleStep && heldTarget && targetWorkflowId && (
        <ChatCard
          testId="chat-schedule-next-step"
          title={t(heldScheduleCopy(heldTarget).title)}
          line={t(heldScheduleCopy(heldTarget).line)}
          action={
            <HeldScheduleAction
              schedule={heldTarget}
              conversationId={activeId ?? undefined}
              workflowId={targetWorkflowId}
              testId="chat-review-schedule"
              busy={status !== "ready"}
              onPrepareSingleRun={() => void submitTurn(t("chat.activation.singlePrompt"))}
              onRepair={() => void submitTurn(t("authority.adjustPrompt"))}
            />
          }
        >
          {waitingOn ? <WaitingOnLine name={waitingOn} testId="chat-schedule-waiting-on" /> : null}
        </ChatCard>
      )}
      {showProdLiveTest && (
        <ChatCard
          testId="chat-live-test-next-step"
          title={t("chat.liveTest.prepareTitle")}
          line={t("chat.liveTest.prepareEffect")}
          action={
            <Button
              onClick={() => void submitTurn(t("chat.activation.singlePrompt"))}
              data-testid="chat-prepare-live-test"
            >
              {t("chat.liveTest.prepare")}
            </Button>
          }
        />
      )}

      {pairWaiting && !unanchoredDecision && !(showScheduleStep && heldTarget && waitingOn) && (
        <StatusStrip
          tone="info"
          testId="chat-pair-waiting"
          line={pairRequestedLine(pairWaiting, t)}
        />
      )}
      {!heldTarget && !unsaved && readyAutomations > 0 && status === "ready" && (
        <StatusStrip
          tone="ok"
          testId="chat-automation-ready"
          line={t("chat.automation.ready")}
          help={t("chat.automation.readyHint")}
          more={readySchedules
            .filter((schedule) => schedule.next_run_at)
            .map((schedule) =>
              t("authority.report.next", {
                time: new Intl.DateTimeFormat(locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: schedule.timezone,
                }).format(new Date(schedule.next_run_at as string)),
                zone: schedule.timezone,
              }),
            )
            .join(" · ")}
        />
      )}
    </MessageScrollerItem>
  );
}
