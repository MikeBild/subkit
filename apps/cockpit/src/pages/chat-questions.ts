import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiCall } from "@/api/call";
import type { ConversationDetail } from "@/api/client";
import { useSession } from "@/app/session";
import { taskKeys } from "@/lib/task-keys";
import { chatApproval } from "./chat-approval";
import { chatChoice } from "./chat-choice";
import { chatForm } from "./chat-form";
import { type TaskAction, withTaskName } from "./chat-task-approval";
import { chatText } from "./chat-text";

function useTaskActionName(action: TaskAction | null): string | null {
  const { permissions } = useSession();
  const runId = action?.taskRunId ?? "";
  const run = useQuery({
    queryKey: taskKeys.run(runId),
    enabled: Boolean(runId) && permissions.includes("task_run:read"),
    retry: false,
    queryFn: () => apiCall("get", "/v1/task-runs/{id}", { path: { id: runId } }),
  });
  const taskId = action?.taskId ?? run.data?.task_id ?? "";
  const task = useQuery({
    queryKey: taskKeys.detail(taskId),
    enabled: Boolean(taskId) && !action?.name && permissions.includes("task:read"),
    retry: false,
    queryFn: () => apiCall("get", "/v1/tasks/{id}", { path: { id: taskId } }),
  });
  return task.data?.name ?? null;
}

export function useChatQuestions(data: ConversationDetail | undefined) {
  const queryClient = useQueryClient();
  const resume = data?.resume_summary;
  const openQuestionId = resume?.pending_approval?.id ?? null;
  const seenQuestionId = useRef(openQuestionId);
  useEffect(() => {
    if (seenQuestionId.current === openQuestionId) return;
    seenQuestionId.current = openQuestionId;
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
  }, [openQuestionId, queryClient]);
  const viewer = useSession().principal;
  const askedDecision = chatApproval(data, viewer.id, viewer.role_name === "admin");
  const taskName = useTaskActionName(askedDecision?.taskAction ?? null);
  const pendingDecision = askedDecision?.taskAction
    ? { ...askedDecision, taskAction: withTaskName(askedDecision.taskAction, taskName) }
    : askedDecision;
  const pendingChoice = chatChoice(data);
  const pendingForm = useMemo(() => chatForm(data), [data]);
  const pendingText = useMemo(() => chatText(data), [data]);
  const [clock, setClock] = useState(Date.now);
  const lockingId =
    pendingDecision?.id ?? pendingChoice?.id ?? pendingForm?.id ?? pendingText?.id ?? null;
  useEffect(() => {
    if (!lockingId) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [lockingId]);
  const open = (question: { expiresAt: string } | null) =>
    question !== null && Date.parse(question.expiresAt) > clock;
  const choiceOpen = open(pendingChoice);
  const formOpen = open(pendingForm);
  const anyQuestion = Boolean(pendingDecision || pendingChoice || pendingForm || pendingText);
  const playbookQuestions = [pendingDecision, pendingChoice, pendingForm, pendingText].filter(
    (question): question is NonNullable<typeof question> => question !== null,
  );
  return {
    pendingDecision,
    pendingChoice,
    pendingForm,
    pendingText,
    clock,
    open,
    choiceOpen,
    formOpen,
    anyQuestion,
    playbookQuestions,
  };
}

export type ChatQuestions = ReturnType<typeof useChatQuestions>;
