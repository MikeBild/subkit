import { RadioCard, RadioGroup } from "@ui/atoms/radio-group";
import { ErrorNotice } from "@ui/molecules/error-notice";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, ChatCard, Spinner } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { useNow } from "@/lib/use-now";
import type { ChatChoice } from "../model/choice";

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
  const now = useNow();
  useEffect(() => {
    setValue("");
  }, [choice.id]);
  const deadline = Date.parse(choice.expiresAt);
  const expired = !Number.isFinite(deadline) || deadline <= now;
  const selected = choice.options.find((option) => option.value === value);
  const readable = (text: string) =>
    hideTechnicalIdentifiers(text, t("tool.referenceHiddenInline"));
  const disabled = busy || expired;
  return (
    <ChatCard
      testId={testId}
      title={t("chat.choice.title")}
      line={readable(choice.question)}
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
      <RadioGroup
        value={value}
        onValueChange={setValue}
        disabled={disabled}
        aria-label={t("chat.choice.select")}
        className="flex flex-col gap-2"
        data-testid={`${testId}-select`}
      >
        {choice.options.map((option) => (
          <RadioCard
            key={option.value}
            value={option.value}
            data-testid={`${testId}-option-${option.value}`}
          >
            <span className="flex flex-1 flex-col gap-1">
              <span>{readable(option.label)}</span>
              {option.description && (
                <span className="text-xs text-muted-foreground">
                  {readable(option.description)}
                </span>
              )}
            </span>
            {value === option.value && <Check aria-hidden="true" className="size-4 shrink-0" />}
          </RadioCard>
        ))}
      </RadioGroup>
      {expired && <p className="text-sm text-muted-foreground">{t("chat.decision.expired")}</p>}
      {error && (
        <ErrorNotice
          kind="unknown"
          technical={false}
          title={t("chat.decision.failed")}
          body={t("chat.decision.failedBody")}
        />
      )}
    </ChatCard>
  );
}
