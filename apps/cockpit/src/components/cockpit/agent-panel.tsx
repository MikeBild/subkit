import { useMutation } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { useState } from "react";
import { sendConversationTurn } from "@/api/client";
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

interface PanelTurn {
  question: string;
  answer: string;
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
    mutationFn: async (message: string) => {
      let answer = "";
      const onEvent = (event: { type: string; [key: string]: unknown }) => {
        if (event.type === "text_delta" && typeof event.text === "string") answer += event.text;
      };
      const outcome = await sendConversationTurn(
        conversationId
          ? { conversationId, message }
          : { message, target: { workflow_id: workflowId } },
        onEvent,
      );
      return { conversationId: outcome.conversation.id, answer };
    },
    onSuccess: (result, message) => {
      setConversationId(result.conversationId);
      setTurns((current) => [...current, { question: message, answer: result.answer }]);
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
                <p
                  className="text-sm whitespace-pre-wrap text-muted-foreground"
                  data-testid={`agent-panel-answer-${index}`}
                >
                  {hideTechnicalIdentifiers(turn.answer, t("tool.referenceHiddenInline"))}
                </p>
              </div>
            ))
          )}
          {ask.isPending && (
            <p className="text-sm text-muted-foreground" data-testid="agent-panel-pending">
              {t("agentPanel.thinking")}
            </p>
          )}
          {ask.isError && (
            <p className="text-sm text-destructive" data-testid="agent-panel-error">
              {t("agentPanel.failed")}
            </p>
          )}
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
              <a
                href={`/cockpit/chat/new?workflow_id=${encodeURIComponent(workflowId)}`}
                data-testid="agent-panel-full-chat"
              >
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
