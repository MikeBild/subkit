import { useEffect, useState } from "react";
import {
  Button,
  ChatCard,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Spinner,
  Textarea,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { type ChatText, textAnswerAcceptable } from "./chat-text";

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
    <ChatCard
      testId={testId}
      title={t("chat.choice.title")}
      line={
        <span data-testid={`${testId}-question`} className="whitespace-pre-line">
          {hideTechnicalIdentifiers(text.question, t("tool.referenceHiddenInline"))}
        </span>
      }
      action={
        <Button
          disabled={disabled || !acceptable}
          onClick={submit}
          data-testid={`${testId}-submit`}
        >
          {busy && <Spinner aria-hidden="true" aria-label={undefined} />}
          {t(busy ? "chat.decision.processing" : "chat.text.submit")}
        </Button>
      }
    >
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
      {expired && <p className="text-sm text-muted-foreground">{t("chat.decision.expired")}</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t("chat.decision.failed")}
        </p>
      )}
    </ChatCard>
  );
}
