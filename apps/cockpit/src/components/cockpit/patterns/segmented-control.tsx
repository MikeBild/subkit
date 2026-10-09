import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export interface SegmentedOption {
  value: string;
  label: string;
  testId?: string;
}

export function SegmentedControl({
  options,
  value,
  onValueChange,
  label,
  testId,
}: {
  options: readonly SegmentedOption[];
  value: string;
  onValueChange(value: string): void;
  label: string;
  testId?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange(next);
      }}
      aria-label={label}
      data-slot="segmented-control"
      data-testid={testId}
      className="max-w-full gap-0.5 overflow-x-auto rounded-md bg-muted p-[3px] [scrollbar-width:none]"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          data-testid={option.testId}
          className="h-[26px] shrink-0 rounded-sm border-0 bg-transparent px-2.5 shadow-none text-[13px] font-medium text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
