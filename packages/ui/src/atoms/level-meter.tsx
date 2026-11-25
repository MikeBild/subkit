import { cn } from "@ui/lib/utils";

const BARS = [
  { id: "outer-left", weight: 0.45 },
  { id: "left", weight: 0.8 },
  { id: "center", weight: 1 },
  { id: "right", weight: 0.7 },
  { id: "outer-right", weight: 0.5 },
] as const;

export const barHeights = (level: number): readonly number[] => {
  const clamped = Math.min(1, Math.max(0, level));
  return BARS.map(({ weight }) => Math.round(20 + 80 * clamped * weight));
};

export function LevelMeter({ level, className }: { level: number; className?: string }) {
  const heights = barHeights(level);
  return (
    <span aria-hidden className={cn("inline-flex h-4 items-center gap-0.5", className)}>
      {BARS.map((bar, index) => (
        <span
          key={bar.id}
          className="w-0.5 rounded-full bg-current transition-[height] duration-100"
          style={{ height: `${heights[index] ?? 20}%` }}
        />
      ))}
    </span>
  );
}
