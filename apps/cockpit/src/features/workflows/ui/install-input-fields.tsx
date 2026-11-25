import { TextAreaField, TextField } from "@/components/cockpit/form-field";
import { useI18n } from "@/lib/i18n-context";
import type { InstallInputField } from "../model/create-template-model";

export function InstallInputFields({
  fields,
  values,
  onChange,
}: {
  fields: readonly InstallInputField[];
  values: Readonly<Record<string, string>>;
  onChange(key: string, value: string): void;
}) {
  const { t } = useI18n();
  if (fields.length === 0) return null;
  return (
    <div className="grid gap-3" data-testid="create-solution-inputs">
      {fields.map((field) =>
        field.list ? (
          <TextAreaField
            key={field.key}
            id={`create-solution-input-${field.key}`}
            label={field.label}
            help={t("create.solution.hostsHelp")}
            value={values[field.key] ?? ""}
            onChange={(value) => onChange(field.key, value)}
            placeholder="docs.example.com"
            rows={3}
            required
            mono
          />
        ) : (
          <TextField
            key={field.key}
            id={`create-solution-input-${field.key}`}
            label={field.label}
            help={t("create.solution.inputHelp")}
            value={values[field.key] ?? ""}
            onChange={(value) => onChange(field.key, value)}
            required
            mono
          />
        ),
      )}
    </div>
  );
}
