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
      size="sm"
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange(next);
      }}
      aria-label={label}
      data-slot="segmented-control"
      data-testid={testId}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} data-testid={option.testId}>
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
