import { cn } from "@/lib/utils";
import { SegmentedControl } from "./segmented-control";

export interface GroupingOption {
  value: string;
  label: string;
}

export function GroupingChoice({
  label,
  value,
  onChange,
  options,
  testId,
  note,
  className,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  options: readonly GroupingOption[];
  testId?: string;
  note?: string;
  className?: string;
}) {
  return (
    <div
      data-slot="grouping-choice"
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-2", className)}
    >
      <SegmentedControl
        label={label}
        value={value}
        onValueChange={onChange}
        testId={testId}
        options={options.map((option) => ({
          value: option.value,
          label: option.label,
          testId: testId ? `${testId}-${option.value}` : undefined,
        }))}
      />
      {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
    </div>
  );
}
