import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { type ChatForm, formFieldLabel, formValues } from "./chat-form";

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
  const question = /^Workflow ".+" needs the following inputs? to run:$/.test(form.question)
    ? t("chat.form.runQuestion")
    : form.question;
  const [values, setValues] = useState<Record<string, string | boolean | string[]>>({});
  const [now, setNow] = useState(Date.now);
  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (initialized.current === form.id) return;
    initialized.current = form.id;
    setValues(
      Object.fromEntries(
        form.fields.map((field) => [
          field.name,
          field.default === undefined
            ? field.type === "boolean"
              ? false
              : ""
            : typeof field.default === "number"
              ? String(field.default)
              : field.default,
        ]),
      ),
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
  return (
    <Card tone="question" size="sm" data-testid={testId}>
      <CardHeader>
        <CardTitle>{t("chat.form.title")}</CardTitle>
        <CardDescription>{question}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {form.fields.map((field, fieldIndex) => (
          <Field key={field.name}>
            <FieldLabel htmlFor={`${testId}-${field.name}`}>
              <LabelText label={formFieldLabel(field, fieldLabels)} />
              {field.required ? " *" : ""}
            </FieldLabel>
            {field.type === "boolean" ? (
              <Checkbox
                data-testid={`${testId}-field-${fieldIndex}`}
                id={`${testId}-${field.name}`}
                disabled={busy || expired}
                checked={values[field.name] === true}
                onCheckedChange={(checked) => set(field.name, checked === true)}
              />
            ) : field.type === "select" ? (
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
            ) : field.type === "multi" ? (
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
            ) : field.type === "json" ? (
              <Textarea
                data-testid={`${testId}-field-${fieldIndex}`}
                id={`${testId}-${field.name}`}
                disabled={busy || expired}
                value={String(values[field.name] ?? "")}
                placeholder={field.placeholder}
                onChange={(e) => set(field.name, e.target.value)}
              />
            ) : (
              <Input
                data-testid={`${testId}-field-${fieldIndex}`}
                id={`${testId}-${field.name}`}
                type={field.type === "number" ? "number" : "text"}
                disabled={busy || expired}
                value={String(values[field.name] ?? "")}
                placeholder={field.placeholder}
                onChange={(e) => set(field.name, e.target.value)}
              />
            )}
          </Field>
        ))}
        {expired && <p>{t("chat.decision.expired")}</p>}
        {error && <p role="alert">{t("chat.decision.failed")}</p>}
      </CardContent>
      <CardFooter className="gap-2">
        <Button
          data-testid={`${testId}-cancel`}
          variant="outline"
          disabled={busy || expired}
          onClick={() => onAnswer(form.id, { declined: true })}
        >
          {t("chat.form.cancel")}
        </Button>
        <Button
          data-testid={`${testId}-submit`}
          disabled={busy || expired || output === null}
          onClick={() => output && onAnswer(form.id, { values: output })}
        >
          {t(busy ? "chat.decision.processing" : "chat.form.submit")}
        </Button>
      </CardFooter>
    </Card>
  );
}
