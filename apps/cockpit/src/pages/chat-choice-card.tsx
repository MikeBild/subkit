import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, ChatCard, Spinner } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { cn } from "@/lib/utils";
import type { ChatChoice } from "./chat-choice";
import { chatChoicePresentation } from "./chat-choice-presentation";

/**
 * A question with fixed answers: the question as the card's line, each option
 * with its effect, nothing chosen until the reader chooses, one button that
 * sends the choice. The card exists once — in the transcript — so there is
 * one selection, not one per copy.
 */
export function ChatChoiceCard({
  choice,
  busy,
  error,
  onAnswer,
  testId,
}: {
  choice: ChatChoice;
  busy: boolean;
  error: boolean;
  onAnswer: (id: string, value: string) => void;
  testId: string;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState<string>("");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setValue("");
  }, [choice.id]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const deadline = Date.parse(choice.expiresAt);
  const expired = !Number.isFinite(deadline) || deadline <= now;
  const presentation = chatChoicePresentation(choice, t);
  const selected = presentation.options.find((option) => option.value === value);
  const readable = (text: string) =>
    hideTechnicalIdentifiers(text, t("tool.referenceHiddenInline"));
  const disabled = busy || expired;
  return (
    <ChatCard
      testId={testId}
      title={t("chat.choice.title")}
      line={readable(presentation.question)}
      action={
        <Button
          disabled={disabled || !selected}
          onClick={() => onAnswer(choice.id, value)}
          data-testid={`${testId}-submit`}
        >
          {busy && <Spinner aria-hidden="true" aria-label={undefined} />}
          {t(busy ? "chat.decision.processing" : "chat.choice.submit")}
        </Button>
      }
    >
      <div
        role="radiogroup"
        aria-label={t("chat.choice.select")}
        className="flex flex-col gap-2"
        data-testid={`${testId}-select`}
      >
        {presentation.options.map((option) => {
          const checked = value === option.value;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a radio that carries a two-line label and its effect
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={disabled}
              onClick={() => setValue(option.value)}
              data-testid={`${testId}-option-${option.value}`}
              className={cn(
                "flex min-h-10 w-full items-start gap-2 rounded-md border px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
                checked && "border-foreground/40 bg-muted",
              )}
            >
              <span className="flex flex-1 flex-col gap-1">
                <span>{readable(option.label)}</span>
                {option.description && (
                  <span className="text-xs text-muted-foreground">
                    {readable(option.description)}
                  </span>
                )}
              </span>
              {checked && <Check aria-hidden="true" className="size-4 shrink-0" />}
            </button>
          );
        })}
      </div>
      {expired && <p className="text-sm text-muted-foreground">{t("chat.decision.expired")}</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t("chat.decision.failed")}
        </p>
      )}
    </ChatCard>
  );
}
