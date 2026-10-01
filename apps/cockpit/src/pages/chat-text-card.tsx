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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n-context";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { type ChatText, textAnswerAcceptable } from "./chat-text";

/**
 * A free-text question, shown where the reader reads: the question itself, a
 * field for the answer and one action. It used to be a collapsed tool row and
 * a placeholder in the composer — the question was never on screen, and the
 * reader's next message, written without seeing it, was taken as the answer.
 */
export function ChatTextCard({
  text,
  busy,
  error,
  onAnswer,
  testId,
}: {
  text: ChatText;
  busy: boolean;
  error: boolean;
  onAnswer: (id: string, value: string) => void;
  testId: string;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(text.initialValue ?? "");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setValue(text.initialValue ?? "");
  }, [text.id, text.initialValue]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const deadline = Date.parse(text.expiresAt);
  const expired = !Number.isFinite(deadline) || deadline <= now;
  const acceptable = textAnswerAcceptable(text, value);
  const rejected = value.trim().length > 0 && !acceptable;
  const disabled = busy || expired;
  const submit = () => {
    if (disabled || !acceptable) return;
    onAnswer(text.id, value);
  };
  const fieldId = `${testId}-input`;
  const fieldProps = {
    id: fieldId,
    "data-testid": fieldId,
    value,
    placeholder: text.placeholder ?? t("chat.text.placeholder"),
    disabled,
    "aria-invalid": rejected || undefined,
    onChange: (event: { target: { value: string } }) => setValue(event.target.value),
  };
  return (
    <Card size="sm" tone="question" data-testid={testId}>
      <CardHeader>
        <CardTitle>{t("chat.choice.title")}</CardTitle>
        <CardDescription data-testid={`${testId}-question`} className="whitespace-pre-line">
          {hideTechnicalIdentifiers(text.question, t("tool.referenceHiddenInline"))}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field>
            <FieldLabel htmlFor={fieldId}>{t("chat.text.label")}</FieldLabel>
            {text.multiline ? (
              <Textarea {...fieldProps} />
            ) : (
              <Input {...fieldProps} type="text" autoComplete="off" />
            )}
            {rejected && <FieldDescription role="alert">{t("chat.text.invalid")}</FieldDescription>}
          </Field>
        </form>
        {expired && <p>{t("chat.decision.expired")}</p>}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{t("chat.decision.failed")}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter>
        <Button
          disabled={disabled || !acceptable}
          onClick={submit}
          data-testid={`${testId}-submit`}
        >
          {busy && <Spinner aria-hidden="true" aria-label={undefined} />}
          {t(busy ? "chat.decision.processing" : "chat.text.submit")}
        </Button>
      </CardFooter>
    </Card>
  );
}
