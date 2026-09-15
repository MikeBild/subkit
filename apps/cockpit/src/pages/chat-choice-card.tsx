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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
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
            <FieldLabel htmlFor={`${testId}-select`}>{t("chat.choice.select")}</FieldLabel>
            <Select
              value={value}
              onValueChange={(next) => setValue(next ?? "")}
              disabled={busy || expired}
            >
              <SelectTrigger id={`${testId}-select`} data-testid={`${testId}-select`}>
                <SelectValue placeholder={t("chat.choice.select")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {presentation.options.map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      data-testid={`${testId}-option-${option.value}`}
                    >
                      {readable(option.label)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {selected?.description && (
              <FieldDescription>{readable(selected.description)}</FieldDescription>
            )}
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
