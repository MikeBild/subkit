import { Button } from "@ui/atoms/button";
import { Input } from "@ui/atoms/input";
import { Switch } from "@ui/atoms/switch";
import { Textarea } from "@ui/atoms/textarea";
import { Field, FieldDescription, FieldError, FieldLabel } from "@ui/molecules/field";
import { IconButton } from "@ui/molecules/icon-button";
import { SegmentedControl } from "@ui/molecules/segmented-control";
import { Plus, X } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useI18n } from "@/lib/i18n-context";
import {
  buildSchemaInput,
  fieldTitle,
  type SchemaError,
  type SchemaValue,
  type SchemaValues,
  schemaFieldKind,
  valuesFromInput,
} from "@/lib/schema-form";
import type { InputField } from "@/lib/workflow-inputs";
import { CollapsibleSection } from "./section";

const MAX_SEGMENTS = 4;

function ErrorLine({ error }: { error: SchemaError | undefined }) {
  const { t } = useI18n();
  if (!error) return null;
  const field = fieldTitle(error.field);
  const key =
    error.problem === "missing"
      ? "schemaForm.missing"
      : error.problem === "number"
        ? "schemaForm.notNumber"
        : error.problem === "integer"
          ? "schemaForm.notInteger"
          : "schemaForm.notJson";
  return <FieldError>{t(key, { field })}</FieldError>;
}

function Label({ field, htmlFor }: { field: InputField; htmlFor?: string }) {
  const { t } = useI18n();
  return (
    <FieldLabel htmlFor={htmlFor}>
      {fieldTitle(field)}
      {field.required ? (
        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
          {t("schemaForm.required")}
        </span>
      ) : null}
    </FieldLabel>
  );
}

function SchemaField({
  field,
  value,
  onChange,
  errors,
  idPrefix,
}: {
  field: InputField;
  value: SchemaValue | undefined;
  onChange(value: SchemaValue): void;
  errors: readonly SchemaError[];
  idPrefix: string;
}) {
  const { t } = useI18n();
  const id = `${idPrefix}-${field.path.replace(/[^\w-]/g, "-")}`;
  const error = errors.find((entry) => entry.path === field.path);
  const invalid = Boolean(error);
  const description = field.description ? (
    <FieldDescription>{field.description}</FieldDescription>
  ) : null;
  const kind = schemaFieldKind(field);

  if (kind === "boolean")
    return (
      <Field
        orientation="horizontal"
        className="items-center justify-between rounded-md border px-3 py-2"
        data-testid={id}
      >
        <div className="flex flex-col gap-0.5">
          <Label field={field} htmlFor={`${id}-input`} />
          {description}
        </div>
        <Switch
          id={`${id}-input`}
          checked={value === true}
          onCheckedChange={(checked) => onChange(checked)}
        />
      </Field>
    );

  if (kind === "group")
    return (
      <fieldset className="rounded-lg border p-3" data-testid={id} data-slot="schema-group">
        <legend className="px-1 text-sm font-medium">{fieldTitle(field)}</legend>
        {field.description ? (
          <p className="mb-2 text-xs text-muted-foreground">{field.description}</p>
        ) : null}
        <div className="flex flex-col gap-3">
          {field.children.map((child) => (
            <SchemaField
              key={child.path}
              field={child}
              value={(value as SchemaValues | undefined)?.[child.name]}
              onChange={(next) =>
                onChange({ ...((value as SchemaValues) ?? {}), [child.name]: next })
              }
              errors={errors}
              idPrefix={idPrefix}
            />
          ))}
        </div>
      </fieldset>
    );

  if (kind === "list") {
    const items = Array.isArray(value) ? value : [];
    const numeric = field.itemType === "number" || field.itemType === "integer";
    return (
      <Field data-invalid={invalid || undefined} data-testid={id}>
        <Label field={field} />
        <div className="flex flex-col gap-1.5" data-slot="schema-list">
          {items.map((item, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                value={item}
                inputMode={numeric ? "decimal" : undefined}
                aria-label={`${fieldTitle(field)} ${index + 1}`}
                aria-invalid={invalid}
                onChange={(event) =>
                  onChange(items.map((entry, at) => (at === index ? event.target.value : entry)))
                }
                data-testid={`${id}-item-${index}`}
              />
              <IconButton
                type="button"
                label={t("schemaForm.removeItem")}
                onClick={() => onChange(items.filter((_, at) => at !== index))}
                data-testid={`${id}-remove-${index}`}
              >
                <X />
              </IconButton>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-fit"
            onClick={() => onChange([...items, ""])}
            data-testid={`${id}-add`}
          >
            <Plus data-icon="inline-start" />
            {t("schemaForm.addItem")}
          </Button>
        </div>
        {description}
        <ErrorLine error={error} />
      </Field>
    );
  }

  if (kind === "enum") {
    const options = field.options ?? [];
    const text = typeof value === "string" ? value : "";
    return (
      <Field data-invalid={invalid || undefined} data-testid={id}>
        <Label field={field} />
        {options.length <= MAX_SEGMENTS ? (
          <div className="w-fit">
            <SegmentedControl
              label={fieldTitle(field)}
              value={text}
              onValueChange={onChange}
              options={options.map((option, index) => ({
                value: String(option),
                label: String(option),
                testId: `${id}-option-${index}`,
              }))}
            />
          </div>
        ) : (
          <select
            id={`${id}-input`}
            value={text}
            aria-invalid={invalid}
            onChange={(event) => onChange(event.target.value)}
            className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <option value="">{t("schemaForm.choose")}</option>
            {options.map((option) => (
              <option key={String(option)} value={String(option)}>
                {String(option)}
              </option>
            ))}
          </select>
        )}
        {description}
        <ErrorLine error={error} />
      </Field>
    );
  }

  const text = typeof value === "string" ? value : "";
  return (
    <Field data-invalid={invalid || undefined} data-testid={id}>
      <Label field={field} htmlFor={`${id}-input`} />
      {kind === "json" ? (
        <Textarea
          id={`${id}-input`}
          rows={3}
          className="font-mono text-xs"
          value={text}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value)}
          data-testid={`${id}-input`}
        />
      ) : (
        <Input
          id={`${id}-input`}
          type="text"
          inputMode={kind === "number" ? "decimal" : undefined}
          className={kind === "number" ? "w-40" : undefined}
          value={text}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value)}
          data-testid={`${id}-input`}
        />
      )}
      {description}
      <ErrorLine error={error} />
    </Field>
  );
}

function RawInput({
  fields,
  values,
  onChange,
  testId,
}: {
  fields: readonly InputField[];
  values: SchemaValues;
  onChange(values: SchemaValues): void;
  testId: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const current = JSON.stringify(buildSchemaInput(fields, values).input, null, 2);
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  return (
    <CollapsibleSection label={t("schemaForm.raw")} testId={`${testId}-raw`}>
      <Field data-invalid={bad || undefined}>
        <FieldLabel htmlFor={id} className="sr-only">
          {t("schemaForm.raw")}
        </FieldLabel>
        <Textarea
          id={id}
          rows={6}
          className="font-mono text-xs"
          value={draft ?? current}
          aria-invalid={bad}
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            try {
              const parsed = JSON.parse(text) as unknown;
              if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                setBad(true);
                return;
              }
              setBad(false);
              onChange(valuesFromInput(fields, parsed as Record<string, unknown>));
            } catch {
              setBad(true);
            }
          }}
          onBlur={() => {
            if (!bad) setDraft(null);
          }}
          data-testid={`${testId}-raw-input`}
        />
        {bad ? <FieldError>{t("schemaForm.rawInvalid")}</FieldError> : null}
      </Field>
    </CollapsibleSection>
  );
}

export function SchemaForm({
  fields,
  values,
  onChange,
  errors = [],
  empty,
  raw = true,
  testId = "schema-form",
}: {
  fields: readonly InputField[];
  values: SchemaValues;
  onChange(values: SchemaValues): void;
  errors?: readonly SchemaError[];
  empty?: ReactNode;
  raw?: boolean;
  testId?: string;
}) {
  if (fields.length === 0)
    return empty ? (
      <p className="text-sm text-muted-foreground" data-testid={`${testId}-empty`}>
        {empty}
      </p>
    ) : null;
  return (
    <div className="flex flex-col gap-3" data-slot="schema-form" data-testid={testId}>
      {fields.map((field) => (
        <SchemaField
          key={field.path}
          field={field}
          value={values[field.name]}
          onChange={(next) => onChange({ ...values, [field.name]: next })}
          errors={errors}
          idPrefix={testId}
        />
      ))}
      {raw ? (
        <RawInput fields={fields} values={values} onChange={onChange} testId={testId} />
      ) : null}
    </div>
  );
}
