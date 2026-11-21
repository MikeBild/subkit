import { CalendarDays } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { formatLocalValue, parseLocalValue } from "@/lib/locale-date";
import { cn } from "@/lib/utils";

export function DateField({
  id,
  value,
  onChange,
  withTime = false,
  disabled,
  invalid,
  describedBy,
  label,
  testId,
  className,
}: {
  id?: string | undefined;
  value: string;
  onChange(value: string): void;
  withTime?: boolean;
  disabled?: boolean | undefined;
  invalid?: boolean | undefined;
  describedBy?: string | undefined;
  label?: string | undefined;
  testId?: string | undefined;
  className?: string | undefined;
}) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const picker = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => formatLocalValue(value, tag, withTime));
  const parsed = parseLocalValue(text, tag, withTime);
  useEffect(() => {
    if (parseLocalValue(text, tag, withTime) !== value)
      setText(formatLocalValue(value, tag, withTime));
    // biome-ignore lint/correctness/useExhaustiveDependencies: text is the field's own draft
  }, [value, tag, withTime]);
  return (
    <InputGroup data-slot="date-field" className={cn("w-48", withTime && "w-60", className)}>
      <InputGroupInput
        id={id}
        inputMode="numeric"
        autoComplete="off"
        value={text}
        disabled={disabled}
        placeholder={t(withTime ? "common.dateTimePlaceholder" : "common.datePlaceholder")}
        aria-label={label}
        aria-invalid={invalid || parsed === null || undefined}
        aria-describedby={describedBy}
        onChange={(event) => {
          setText(event.target.value);
          onChange(parseLocalValue(event.target.value, tag, withTime) ?? "");
        }}
        onBlur={() => {
          if (parsed) setText(formatLocalValue(parsed, tag, withTime));
        }}
        data-testid={testId}
      />
      <InputGroupAddon align="inline-end" className="relative">
        <InputGroupButton
          type="button"
          size="icon-sm"
          disabled={disabled}
          aria-label={t("common.pickDate")}
          title={t("common.pickDate")}
          onClick={() => picker.current?.showPicker?.()}
          data-testid={testId ? `${testId}-picker` : undefined}
        >
          <CalendarDays />
        </InputGroupButton>
        <input
          ref={picker}
          type={withTime ? "datetime-local" : "date"}
          tabIndex={-1}
          aria-hidden
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="pointer-events-none absolute right-0 bottom-0 size-px opacity-0"
        />
      </InputGroupAddon>
    </InputGroup>
  );
}
