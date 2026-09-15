import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useI18n } from "@/lib/i18n-context";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import type { ChatChoice } from "./chat-choice";
import { chatChoicePresentation } from "./chat-choice-presentation";

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
  return (
    <Card size="sm" data-testid={testId}>
      <CardHeader>
        <CardTitle>{t("chat.choice.title")}</CardTitle>
        <CardDescription>{readable(presentation.question)}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field>
            <FieldLabel id={`${testId}-label`}>{t("chat.choice.select")}</FieldLabel>
            <ToggleGroup
              type="single"
              orientation="vertical"
              variant="outline"
              className="w-full"
              value={value}
              onValueChange={setValue}
              disabled={busy || expired}
              aria-labelledby={`${testId}-label`}
              data-testid={`${testId}-select`}
            >
              {presentation.options.map((option) => (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  className="h-auto w-full justify-start whitespace-normal px-3 py-3 text-left"
                  data-testid={`${testId}-option-${option.value}`}
                >
                  <span className="flex flex-col gap-1">
                    <span>{readable(option.label)}</span>
                    {option.description && (
                      <span className="text-xs text-muted-foreground">
                        {readable(option.description)}
                      </span>
                    )}
                  </span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
        </FieldGroup>
        {expired && <p>{t("chat.decision.expired")}</p>}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{t("chat.decision.failed")}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter>
        <Button
          disabled={busy || expired || !selected}
          onClick={() => onAnswer(choice.id, value)}
          data-testid={`${testId}-submit`}
        >
          {busy && <Spinner aria-hidden="true" aria-label={undefined} />}
          {t(busy ? "chat.decision.processing" : "chat.choice.submit")}
        </Button>
      </CardFooter>
    </Card>
  );
}
