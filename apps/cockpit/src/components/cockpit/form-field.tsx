import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ContextHelp, CopyField, SegmentedControl } from "./patterns";

/**
 * The fields of a FormDialog (P14): a label, the control, one line of help
 * behind (?), and the error the control carries. Native controls, styled like
 * the rest of the cockpit, so a form needs nothing from the primitives.
 */
const CONTROL =
  "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm dark:bg-input/30";

function Shell({
  id,
  label,
  help,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-slot="form-field">
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
  mono?: boolean;
}) {
  return (
    <Shell id={id} label={label} help={help}>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        className={cn(CONTROL, "h-10 sm:h-8", mono && "font-mono")}
        data-testid={id}
      />
    </Shell>
  );
}

/** A value the reader takes from the form, not into it: shown whole, with a copy button. */
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
}: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  help?: string;
  rows?: number;
  mono?: boolean;
}) {
  return (
    <Shell id={id} label={label} help={help}>
      <textarea
        id={id}
        rows={rows}
        value={value}
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
}: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  options: readonly { value: string; label: string }[];
  help?: string;
}) {
  return (
    <Shell id={id} label={label} help={help}>
      <select
        id={id}
        value={value}
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

/** A labelled segmented choice: two to five options, all visible at once. */
export function ChoiceField<T extends string>({
  label,
  value,
  onChange,
  options,
  help,
  testId,
}: {
  label: string;
  value: T;
  onChange(value: T): void;
  options: { value: T; label: string }[];
  /** One sentence behind (?). */
  help?: string;
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
        options={options.map((option) => ({ ...option, testId: `${testId}-${option.value}` }))}
      />
    </div>
  );
}
