import { useMutation } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { useState } from "react";
import { ApiError, getConversation, sendConversationTurn } from "@/api/client";
import { absolute, chatNewHref, conversationHref } from "@/app/links";
import type { ToolPart } from "@/components/ai-elements/tool";
import { AutomationToolCard } from "@/components/cockpit/automation-grant";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n-context";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { chatAutomationTool } from "@/pages/chat-automation-tool";
import { groupMessageParts } from "@/pages/chat-transcript";

interface PanelTurn {
  question: string;
  conversationId: string;
  /** What the turn wrote. */
  texts: string[];
  /** The cards the turn handed over instead of — or besides — words. */
  cards: ToolPart[];
}

/**
 * The turn as the conversation recorded it: its written text and the cards a
 * person acts on.
 *
 * Only the streamed text was shown here. A turn that answered with a card —
 * the automation review ends the turn on one — streamed no text, and the
 * panel stayed empty under the question. The recorded message is what the
 * full chat renders, so it is what this renders too.
 */
function recordedAnswer(
  parts: readonly unknown[] | null,
  streamed: string,
): Pick<PanelTurn, "texts" | "cards"> {
  if (!parts) return { texts: streamed.trim() ? [streamed] : [], cards: [] };
  const texts: string[] = [];
  const cards: ToolPart[] = [];
  for (const group of groupMessageParts(parts)) {
    if (group.kind === "part") {
      const part = group.part as { type?: unknown; text?: unknown };
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim())
        texts.push(part.text);
    } else if (group.kind === "tool") {
      if ((chatAutomationTool(group.tool)?.environments.length ?? 0) > 0) cards.push(group.tool);
    }
  }
  if (texts.length === 0 && streamed.trim()) texts.push(streamed);
  return { texts, cards };
}

/**
 * A conversation bound to the object on screen, so a question about this
 * workflow is asked beside it. Anything beyond asking belongs in the full
 * chat, which the footer links to with the same binding.
 */
export function AgentPanel({
  workflowId,
  workflowName,
}: {
  workflowId: string;
  workflowName: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<PanelTurn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);

  const ask = useMutation({
    mutationFn: async (message: string): Promise<PanelTurn> => {
      let streamed = "";
      const onEvent = (event: { type: string; [key: string]: unknown }) => {
        if (event.type === "text_delta" && typeof event.text === "string") streamed += event.text;
      };
      const outcome = await sendConversationTurn(
        conversationId
          ? { conversationId, message }
          : { message, target: { workflow_id: workflowId } },
        onEvent,
      );
      const id = outcome.conversation.id;
      // The recorded turn, once it is over. If it cannot be read, the streamed
      // words are still an answer; with none of either the turn says so below.
      const detail = await getConversation(id).catch(() => null);
      // This turn only: everything the assistant recorded after the last
      // question. A turn that recorded nothing must not show the one before.
      const messages = detail?.messages ?? null;
      const fromEnd = [...(messages ?? [])].reverse().findIndex((entry) => entry.role === "user");
      const asked = messages && fromEnd >= 0 ? messages.length - 1 - fromEnd : -1;
      const reply = messages
        ?.slice(asked + 1)
        .filter((entry) => entry.role === "assistant")
        .flatMap((entry) => entry.parts);
      return {
        question: message,
        conversationId: id,
        ...recordedAnswer(reply ?? null, streamed),
      };
    },
    onSuccess: (turn) => {
      setConversationId(turn.conversationId);
      setTurns((current) => [...current, turn]);
      setQuestion("");
    },
  });

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" data-testid="agent-panel-open">
          <Bot data-icon="inline-start" />
          {t("agentPanel.open")}
        </Button>
      </SheetTrigger>
      <SheetContent className="flex w-full flex-col sm:max-w-lg" data-testid="agent-panel">
        <SheetHeader>
          <SheetTitle>{t("agentPanel.title")}</SheetTitle>
          <SheetDescription>{t("agentPanel.description", { name: workflowName })}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4">
          {turns.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="agent-panel-empty">
              {t("agentPanel.empty")}
            </p>
          ) : (
            turns.map((turn, index) => (
              <div key={`${turn.question}-${index}`} className="grid gap-2">
                <p className="text-sm font-medium" data-testid={`agent-panel-question-${index}`}>
                  {turn.question}
                </p>
                {turn.texts.length > 0 && (
                  <p
                    className="text-sm whitespace-pre-wrap text-muted-foreground"
                    data-testid={`agent-panel-answer-${index}`}
                  >
                    {hideTechnicalIdentifiers(
                      turn.texts.join("\n\n"),
                      t("tool.referenceHiddenInline"),
                    )}
                  </p>
                )}
                {turn.cards.map((tool) => (
                  <AutomationToolCard key={tool.toolCallId} tool={tool} />
                ))}
                {turn.texts.length === 0 && turn.cards.length === 0 && (
                  <p
                    className="text-sm text-muted-foreground"
                    data-testid={`agent-panel-no-answer-${index}`}
                  >
                    {t("agentPanel.noAnswer")}{" "}
                    <a
                      className="underline underline-offset-4"
                      href={absolute(conversationHref(turn.conversationId))}
                      data-testid={`agent-panel-conversation-${index}`}
                    >
                      {t("agentPanel.openConversation")}
                    </a>
                  </p>
                )}
              </div>
            ))
          )}
          {ask.isPending && (
            <p className="text-sm text-muted-foreground" data-testid="agent-panel-pending">
              {t("agentPanel.thinking")}
            </p>
          )}
          {ask.isError &&
            (ask.error instanceof ApiError &&
            ask.error.code === "pending_elicitation_blocked" &&
            conversationId ? (
              // The conversation waits on a question this panel cannot show.
              // A message typed here is not its answer; the chat shows it.
              <p className="text-sm text-destructive" data-testid="agent-panel-waiting">
                {t("agentPanel.questionWaiting")}{" "}
                <a
                  className="underline underline-offset-4"
                  href={absolute(conversationHref(conversationId))}
                  data-testid="agent-panel-waiting-link"
                >
                  {t("agentPanel.openConversation")}
                </a>
              </p>
            ) : (
              <p className="text-sm text-destructive" data-testid="agent-panel-error">
                {t("agentPanel.failed")}
              </p>
            ))}
        </div>

        <div className="grid gap-2 border-t p-4">
          <Textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={t("agentPanel.placeholder")}
            aria-label={t("agentPanel.placeholder")}
            data-testid="agent-panel-input"
          />
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" asChild>
              <a href={absolute(chatNewHref({ workflowId }))} data-testid="agent-panel-full-chat">
                {t("agentPanel.openChat")}
              </a>
            </Button>
            <Button
              size="sm"
              disabled={ask.isPending || question.trim().length === 0}
              data-testid="agent-panel-send"
              onClick={() => ask.mutate(question.trim())}
            >
              {t("agentPanel.send")}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
