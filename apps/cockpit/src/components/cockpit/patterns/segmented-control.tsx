import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export interface SegmentedOption {
  value: string;
  label: string;
  testId?: string;
}

/**
 * Two to five mutually exclusive views of the same thing (P17): a time window,
 * a call type, a filter mode, an approval duration. Never a page action.
 */
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
      // A second click on the chosen option would clear it; one is always chosen.
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
