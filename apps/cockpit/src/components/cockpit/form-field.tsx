import { cn } from "@ui/lib/utils";
import { type ReactNode, useState } from "react";
import { useI18n } from "@/lib/i18n-context";
import { ContextHelp, CopyField, SECTION_LABEL, SearchInput, SegmentedControl } from "./patterns";

export const CHECK_LIST_FILTER_FROM = 9;

export function checkListMatches(
  options: readonly { value: string; label: string }[],
  needle: string,
): { value: string; label: string }[] {
  const term = needle.trim().toLocaleLowerCase();
  return term
    ? options.filter((option) => option.label.toLocaleLowerCase().includes(term))
    : [...options];
}

const CONTROL =
  "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm dark:bg-input/30";

function Shell({
  id,
  label,
  help,
  error,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-1.5"
      data-slot="form-field"
      data-invalid={error ? true : undefined}
    >
      <span className="flex items-center gap-1">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {help ? (
          <ContextHelp label={label} testId={`${id}-help`}>
            {help}
          </ContextHelp>
        ) : null}
      </span>
      {children}
      {error ? (
        <p role="alert" className="text-destructive text-xs" data-testid={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  help,
  type = "text",
  placeholder,
  required,
  invalid,
  error,
  mono,
}: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  help?: string;
  type?: "text" | "url" | "password" | "time" | "email";
  placeholder?: string;
  required?: boolean;
  invalid?: boolean;
  error?: string | null;
  mono?: boolean;
}) {
  return (
    <Shell id={id} label={label} help={help} error={error}>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        aria-invalid={invalid || Boolean(error) || undefined}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        className={cn(CONTROL, "h-10 sm:h-8", mono && "font-mono")}
        data-testid={id}
      />
    </Shell>
  );
}

export function CopyValueField({
  id,
  label,
  value,
  copyLabel,
  help,
}: {
  id: string;
  label: string;
  value: string;
  copyLabel: string;
  help?: string;
}) {
  return (
    <Shell id={id} label={label} help={help}>
      <CopyField value={value} label={copyLabel} testId={id} />
    </Shell>
  );
}

export function TextAreaField({
  id,
  label,
  value,
  onChange,
  help,
  rows = 6,
  mono,
  placeholder,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  help?: string;
  rows?: number;
  mono?: boolean;
  placeholder?: string;
  error?: string | null;
}) {
  return (
    <Shell id={id} label={label} help={help} error={error}>
      <textarea
        id={id}
        rows={rows}
        value={value}
        placeholder={placeholder}
        aria-invalid={Boolean(error) || undefined}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        className={cn(CONTROL, "py-2", mono && "font-mono text-xs md:text-xs")}
        data-testid={id}
      />
    </Shell>
  );
}

export function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  help,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  options: readonly { value: string; label: string }[];
  help?: string;
  error?: string | null;
}) {
  return (
    <Shell id={id} label={label} help={help} error={error}>
      <select
        id={id}
        value={value}
        aria-invalid={Boolean(error) || undefined}
        onChange={(event) => onChange(event.target.value)}
        className={cn(CONTROL, "h-10 sm:h-8")}
        data-testid={id}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Shell>
  );
}

export function ChoiceField<T extends string>({
  label,
  value,
  onChange,
  options,
  help,
  description,
  wrap,
  testId,
}: {
  label: string;
  value: T;
  onChange(value: T): void;
  options: { value: T; label: string }[];
  help?: string;
  description?: string;
  wrap?: boolean;
  testId: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-slot="form-field">
      <span className="flex items-center gap-1">
        <span className="text-sm font-medium">{label}</span>
        {help ? (
          <ContextHelp label={label} testId={`${testId}-help`}>
            {help}
          </ContextHelp>
        ) : null}
      </span>
      <SegmentedControl
        label={label}
        value={value}
        onValueChange={(next) => onChange(next as T)}
        testId={testId}
        wrap={wrap}
        options={options.map((option) => ({ ...option, testId: `${testId}-${option.value}` }))}
      />
      {description ? (
        <p className="text-muted-foreground text-xs" data-testid={`${testId}-description`}>
          {description}
        </p>
      ) : null}
    </div>
  );
}

export function CheckListField({
  id,
  label,
  values,
  onChange,
  options,
  help,
  empty,
  error,
  quiet = false,
}: {
  id: string;
  label: string;
  values: readonly string[];
  onChange(values: string[]): void;
  options: readonly { value: string; label: string }[];
  help?: string;
  empty: string;
  error?: string | null;
  quiet?: boolean;
}) {
  const { t } = useI18n();
  const [needle, setNeedle] = useState("");
  const filters = options.length >= CHECK_LIST_FILTER_FROM;
  const shown = filters ? checkListMatches(options, needle) : options;
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-1.5"
      data-slot="form-field"
      data-testid={id}
      aria-invalid={Boolean(error) || undefined}
    >
      <legend
        className={cn(
          "mb-1.5 flex items-center gap-1",
          quiet ? SECTION_LABEL : "text-sm font-medium",
        )}
      >
        {label}
        {help ? (
          <ContextHelp label={label} testId={`${id}-help`}>
            {help}
          </ContextHelp>
        ) : null}
      </legend>
      {filters ? (
        <SearchInput
          value={needle}
          onChange={setNeedle}
          label={`${t("pattern.filterList")}: ${label}`}
          testId={`${id}-filter`}
        />
      ) : null}
      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid={`${id}-no-match`}>
          {t("pattern.noMatch")}
        </p>
      ) : (
        <ul
          className={cn(
            "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-x-4 sm:grid-cols-[repeat(2,minmax(0,1fr))]",
            filters && "max-h-56 overflow-y-auto",
          )}
          data-slot="check-list"
        >
          {shown.map((option) => (
            <li key={option.value} className="min-w-0">
              <label className="flex min-h-9 min-w-0 cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-primary"
                  checked={values.includes(option.value)}
                  data-testid={`${id}-${option.value}`}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...values, option.value]
                        : values.filter((value) => value !== option.value),
                    )
                  }
                />
                <span className="min-w-0 truncate" title={option.label}>
                  {option.label}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="text-destructive text-xs" data-testid={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
