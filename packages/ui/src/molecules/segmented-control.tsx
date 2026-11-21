import { useEdgeFade } from "@ui/hooks/use-edge-fade";
import { cn } from "@ui/lib/utils";
import { ToggleGroup, ToggleGroupItem } from "@ui/molecules/toggle-group";
import { useLayoutEffect, useRef } from "react";

export interface SegmentedOption {
  value: string;
  label: string;
  testId?: string;
}

interface HorizontalSpan {
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
  disabled = false,
  wrap = false,
}: {
  options: readonly SegmentedOption[];
  value: string;
  onValueChange(value: string): void;
  label: string;
  testId?: string;
  disabled?: boolean;
  wrap?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const edgeFade = useEdgeFade(root);
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
      disabled={disabled}
      aria-disabled={disabled || undefined}
      onValueChange={(next) => {
        if (next && !disabled) onValueChange(next);
      }}
      aria-label={label}
      data-slot={wrap ? "segmented-choices" : "segmented-control"}
      data-testid={testId}
      style={wrap ? undefined : edgeFade}
      className={
        wrap
          ? "grid w-full min-w-0 grid-cols-2 items-stretch gap-0.5 rounded-control bg-muted p-1 sm:grid-cols-3"
          : "h-10 min-w-0 max-w-full flex-nowrap gap-0.5 pointer-coarse:h-11 overflow-x-auto rounded-control bg-muted p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      }
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          data-testid={option.testId}
          className={cn(
            "rounded-sm border-0 bg-transparent px-3 shadow-none text-sm font-medium text-muted-foreground hover:bg-transparent hover:text-foreground disabled:cursor-not-allowed",
            wrap
              ? "h-auto min-h-8 w-full min-w-0 shrink py-1 text-center leading-4 whitespace-normal [overflow-wrap:anywhere] pointer-coarse:min-h-[38px]"
              : "h-8 shrink-0 whitespace-nowrap pointer-coarse:h-9",
          )}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
