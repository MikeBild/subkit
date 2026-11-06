import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ConversationDetail } from "@/api/client";
import { chatApproval } from "./chat-approval";
import { chatChoice } from "./chat-choice";
import { chatForm } from "./chat-form";
import { chatText } from "./chat-text";

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
  const pendingDecision = chatApproval(data);
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
