import { useEffect, useRef, useState } from "react";
import {
  Button,
  ChatCard,
  Checkbox,
  ContextHelp,
  ErrorNotice,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import {
  type ChatForm,
  formFieldLabel,
  formInputKind,
  formValues,
  initialFieldValue,
} from "./chat-form";

export function ChatFormCard({
  form,
  busy,
  error,
  onAnswer,
  testId,
}: {
  form: ChatForm;
  busy: boolean;
  error: boolean;
  onAnswer: (id: string, output: Record<string, unknown>) => void;
  testId: string;
}) {
  const { t } = useI18n();
  const fieldLabels: Record<string, string> = {
    linkedin: t("chat.form.linkedin"),
    period_end: t("chat.form.periodEnd"),
    ga4_property: t("chat.form.analytics"),
    github_owner: t("chat.form.githubOwner"),
    github_repositories: t("chat.form.repositories"),
    search_console_site: t("chat.form.searchSite"),
    wikikit_report_space: t("chat.form.knowledgeSpace"),
    contentkit_report_site: t("chat.form.reportSite"),
  };
  const runQuestion = /^Workflow ".+" needs the following inputs? to run:$/.test(form.question);
  const question = runQuestion ? t("chat.form.runQuestion") : form.question;
  const [values, setValues] = useState<Record<string, string | boolean | string[]>>({});
  const [now, setNow] = useState(Date.now);
  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (initialized.current === form.id) return;
    initialized.current = form.id;
    setValues(
      Object.fromEntries(form.fields.map((field) => [field.name, initialFieldValue(field)])),
    );
  }, [form]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const expired = !Number.isFinite(Date.parse(form.expiresAt)) || Date.parse(form.expiresAt) <= now;
  const output = formValues(form, values);
  const set = (name: string, value: string | boolean | string[]) =>
    setValues((current) => ({ ...current, [name]: value }));
  const secretHint = t(
    form.intentKind === "save_connector_draft"
      ? "chat.form.secretHintConnector"
      : "chat.form.secretHint",
  );
  return (
    <ChatCard
      testId={testId}
      title={
        <span className="flex items-center gap-1">
          {t("chat.form.title")}
          {runQuestion ? (
            <ContextHelp label={t("chat.form.title")} testId={`${testId}-help`}>
              {t("chat.form.runQuestionHelp")}
            </ContextHelp>
          ) : null}
        </span>
      }
      line={question}
      secondary={
        <Button
          data-testid={`${testId}-cancel`}
          variant="outline"
          disabled={busy || expired}
          onClick={() => onAnswer(form.id, { declined: true })}
        >
          {t("chat.form.cancel")}
        </Button>
      }
      action={
        <Button
          data-testid={`${testId}-submit`}
          disabled={busy || expired || output === null}
          onClick={() => output && onAnswer(form.id, { values: output })}
        >
          {t(busy ? "chat.decision.processing" : "chat.form.submit")}
        </Button>
      }
    >
      {form.fields.map((field, fieldIndex) => {
        const kind = formInputKind(field);
        return (
          <Field key={field.name}>
            <FieldLabel htmlFor={`${testId}-${field.name}`}>
              <LabelText label={formFieldLabel(field, fieldLabels)} />
              {field.required ? " *" : ""}
            </FieldLabel>
            {kind === "checkbox" ? (
              <Checkbox
                data-testid={`${testId}-field-${fieldIndex}`}
                id={`${testId}-${field.name}`}
                disabled={busy || expired}
                checked={values[field.name] === true}
                onCheckedChange={(checked) => set(field.name, checked === true)}
              />
            ) : kind === "select" ? (
              <Select
                disabled={busy || expired}
                value={String(values[field.name] ?? "")}
                onValueChange={(value) => set(field.name, value)}
              >
                <SelectTrigger
                  data-testid={`${testId}-field-${fieldIndex}`}
                  id={`${testId}-${field.name}`}
                >
                  <SelectValue placeholder={t("chat.choice.select")} />
                </SelectTrigger>
                <SelectContent>
                  {field.options?.map((option, optionIndex) =>
                    typeof option === "object" ? (
                      <SelectItem
                        data-testid={`${testId}-field-${fieldIndex}-option-${optionIndex}`}
                        key={option.value}
                        value={option.value}
                      >
                        {option.label}
                      </SelectItem>
                    ) : null,
                  )}
                </SelectContent>
              </Select>
            ) : kind === "multi" ? (
              <div className="flex flex-col gap-2">
                {field.options?.map((option, optionIndex) =>
                  typeof option === "string" ? (
                    <label key={option} htmlFor={`${testId}-${field.name}-${option}`}>
                      <Checkbox
                        data-testid={`${testId}-field-${fieldIndex}-option-${optionIndex}`}
                        id={`${testId}-${field.name}-${option}`}
                        disabled={busy || expired}
                        checked={
                          Array.isArray(values[field.name]) &&
                          (values[field.name] as string[]).includes(option)
                        }
                        onCheckedChange={(checked) => {
                          const previous = Array.isArray(values[field.name])
                            ? (values[field.name] as string[])
                            : [];
                          set(
                            field.name,
                            checked === true
                              ? [...previous, option]
                              : previous.filter((v) => v !== option),
                          );
                        }}
                      />{" "}
                      {option}
                    </label>
                  ) : null,
                )}
              </div>
            ) : kind === "textarea" ? (
              <Textarea
                data-testid={`${testId}-field-${fieldIndex}`}
                id={`${testId}-${field.name}`}
                disabled={busy || expired}
                value={String(values[field.name] ?? "")}
                placeholder={field.placeholder}
                onChange={(e) => set(field.name, e.target.value)}
              />
            ) : kind === "secret" ? (
              <Input
                data-testid={`${testId}-field-${fieldIndex}`}
                id={`${testId}-${field.name}`}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                disabled={busy || expired}
                value={String(values[field.name] ?? "")}
                placeholder={field.placeholder}
                onChange={(e) => set(field.name, e.target.value)}
              />
            ) : (
              <Input
                data-testid={`${testId}-field-${fieldIndex}`}
                id={`${testId}-${field.name}`}
                type={kind === "number" ? "number" : "text"}
                disabled={busy || expired}
                value={String(values[field.name] ?? "")}
                placeholder={field.placeholder}
                onChange={(e) => set(field.name, e.target.value)}
              />
            )}
            {kind === "secret" && (
              <FieldDescription data-testid={`${testId}-field-${fieldIndex}-hint`}>
                {secretHint}
              </FieldDescription>
            )}
          </Field>
        );
      })}
      {expired && <p className="text-sm text-muted-foreground">{t("chat.decision.expired")}</p>}
      {error && (
        <ErrorNotice title={t("chat.decision.failed")} body={t("chat.decision.failedBody")} />
      )}
    </ChatCard>
  );
}
