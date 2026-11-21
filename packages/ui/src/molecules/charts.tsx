import { cn } from "@ui/lib/utils";

export function Sparkline({
  data,
  className,
  label,
}: {
  data: number[];
  className?: string;
  label?: string;
}) {
  const w = 120,
    h = 32,
    max = Math.max(...data),
    min = Math.min(...data),
    span = max - min || 1;
  const pts = data.map(
    (v, i) => [(i / (data.length - 1)) * w, h - 4 - ((v - min) / span) * (h - 8)] as const,
  );
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn("h-8 w-full text-accent", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="currentColor" opacity={0.12} />
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function ProgressRing({
  value,
  total,
  size = 64,
  label,
}: {
  value: number;
  total: number;
  size?: number;
  label: string;
}) {
  const r = (size - 8) / 2,
    c = 2 * Math.PI * r,
    p = total ? value / total : 0;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      role="img"
      aria-label={label}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={6}
          className="stroke-muted"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={6}
          strokeLinecap="round"
          className="stroke-accent"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - p)}
        />
      </svg>
      <span className="absolute font-mono text-xs font-semibold">{Math.round(p * 100)} %</span>
    </span>
  );
}

export function MiniBars({
  data,
  label,
  className,
}: {
  data: number[];
  label: string;
  className?: string;
}) {
  const max = Math.max(...data, 1);
  return (
    <div role="img" aria-label={label} className={cn("flex h-10 items-end gap-1", className)}>
      {data.map((v, i) => (
        <span
          key={i}
          className={cn("flex-1 rounded-sm", i === data.length - 1 ? "bg-accent" : "bg-accent/40")}
          style={{ height: `${Math.max(8, (v / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}
