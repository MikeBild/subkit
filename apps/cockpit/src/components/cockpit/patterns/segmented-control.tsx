import { useLayoutEffect, useRef } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export interface SegmentedOption {
  value: string;
  label: string;
  testId?: string;
}

export interface HorizontalSpan {
  left: number;
  right: number;
}

const REVEAL_MARGIN = 4;

export function revealScrollLeft(
  box: HorizontalSpan & { scrollLeft: number },
  item: HorizontalSpan,
): number {
  if (item.left < box.left)
    return Math.max(0, box.scrollLeft - (box.left - item.left) - REVEAL_MARGIN);
  if (item.right > box.right) return box.scrollLeft + (item.right - box.right) + REVEAL_MARGIN;
  return box.scrollLeft;
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
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = root.current;
    if (!box || box.scrollWidth <= box.clientWidth) return;
    const selected = box.querySelector<HTMLElement>('[data-state="on"]');
    if (!selected) return;
    const outer = box.getBoundingClientRect();
    const inner = selected.getBoundingClientRect();
    box.scrollLeft = revealScrollLeft(
      { left: outer.left, right: outer.right, scrollLeft: box.scrollLeft },
      { left: inner.left, right: inner.right },
    );
  }, [value]);
  return (
    <ToggleGroup
      ref={root}
      type="single"
      variant="outline"
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange(next);
      }}
      aria-label={label}
      data-slot="segmented-control"
      data-testid={testId}
      className="min-w-0 max-w-full flex-nowrap gap-0.5 overflow-x-auto rounded-md bg-muted p-[3px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          data-testid={option.testId}
          className="h-[26px] shrink-0 whitespace-nowrap rounded-sm border-0 bg-transparent px-2.5 shadow-none text-[13px] font-medium text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
