import { cn } from "@ui/lib/utils";
import { useState } from "react";
import { useI18n } from "@/lib/i18n-context";

export interface ChipFilterOption {
  value: string;
  label: string;
  count?: number;
}

export const CHIP_FILTER_VISIBLE = 8;

export function visibleChipOptions(
  options: readonly ChipFilterOption[],
  value: string,
  expanded: boolean,
  limit: number = CHIP_FILTER_VISIBLE,
): { shown: ChipFilterOption[]; hidden: number } {
  if (expanded || options.length <= limit) return { shown: [...options], hidden: 0 };
  const shown = options.slice(0, limit);
  const selected = options.find((option) => option.value === value);
  if (selected && !shown.includes(selected)) shown.push(selected);
  return { shown, hidden: options.length - shown.length };
}

const CHIP =
  "inline-flex h-10 shrink-0 items-center gap-1 rounded-full border px-3 text-sm font-medium transition-colors pointer-coarse:h-11";

export function ChipFilter({
  label,
  allLabel,
  value,
  allValue = "all",
  onChange,
  options,
  loading,
  testId,
}: {
  label: string;
  allLabel: string;
  value: string;
  allValue?: string;
  onChange(value: string): void;
  options: readonly ChipFilterOption[];
  loading?: boolean;
  testId?: string;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (options.length < 2)
    return loading ? (
      <div
        aria-hidden="true"
        data-slot="chip-filter-reserve"
        className="h-10 pointer-coarse:h-11"
      />
    ) : null;
  const { shown, hidden } = visibleChipOptions(options, value, expanded);
  const chip = (option: ChipFilterOption) => {
    const selected = option.value === value;
    return (
      <button
        key={option.value}
        type="button"
        aria-pressed={selected}
        onClick={() => onChange(selected && option.value !== allValue ? allValue : option.value)}
        data-testid={testId ? `${testId}-${option.value}` : undefined}
        className={cn(
          CHIP,
          selected
            ? "border-transparent bg-secondary text-secondary-foreground"
            : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        {option.label}
        {option.count === undefined ? null : (
          <span className="text-[11px] opacity-70">{option.count}</span>
        )}
      </button>
    );
  };
  return (
    <fieldset
      aria-label={label}
      data-slot="chip-filter"
      data-testid={testId}
      className={cn(
        "m-0 flex min-w-0 items-center gap-2 border-0 p-0 pt-2",
        expanded ? "flex-wrap" : "overflow-x-auto scrollbar-none",
      )}
    >
      {chip({ value: allValue, label: allLabel })}
      {shown.map(chip)}
      {hidden > 0 || expanded ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          data-testid={testId ? `${testId}-more` : undefined}
          className="inline-flex h-10 shrink-0 items-center px-1 text-sm font-medium text-primary hover:underline pointer-coarse:h-11"
        >
          {expanded ? t("common.lessChips") : t("common.moreCount", { count: hidden })}
        </button>
      ) : null}
    </fieldset>
  );
}
