import { cn } from "@ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import { Check, Plug, Hash as Slack, Sparkles, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import {
  type SimpleIcon,
  siAnthropic,
  siGithub,
  siGmail,
  siGoogle,
  siGoogledrive,
  siGooglegemini,
  siGooglesheets,
  siHubspot,
  siJira,
  siNotion,
  siStripe,
} from "simple-icons";
import type { Tone } from "./Pill";

const tileSize = { sm: "size-7", md: "size-8", lg: "size-9" } as const;
const tileIcon = { sm: "size-4", md: "size-4", lg: "size-[18px]" } as const;
export function IconTile({
  icon: I,
  children,
  size = "md",
  variant = "muted",
  tone,
  className,
}: {
  icon?: LucideIcon;
  children?: ReactNode;
  size?: keyof typeof tileSize;
  variant?: "muted" | "outline";
  tone?: Tone | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md",
        tileSize[size],
        variant === "muted" ? "bg-muted text-foreground" : "border bg-background text-foreground",
        tone && toneTile[tone],
        className,
      )}
    >
      {I ? <I className={tileIcon[size]} /> : children}
    </span>
  );
}
const toneTile: Record<Tone, string> = {
  success: "bg-success/10 text-success-ink",
  warning: "bg-warning/10 text-warning-ink",
  danger: "bg-destructive/10 text-destructive-ink",
  info: "bg-accent/10 text-info-ink",
  neutral: "",
};

const BRANDS: [RegExp, SimpleIcon][] = [
  [/gmail/i, siGmail],
  [/drive/i, siGoogledrive],
  [/sheets/i, siGooglesheets],
  [/stripe/i, siStripe],
  [/jira/i, siJira],
  [/github/i, siGithub],
  [/notion/i, siNotion],
  [/hubspot/i, siHubspot],
  [/anthropic|claude/i, siAnthropic],
  [/gemini/i, siGooglegemini],
  [/google/i, siGoogle],
];
function luminance(hex: string) {
  const n = parseInt(hex, 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
export function serviceOf(ref: string) {
  return ref.split(":")[0]?.trim() ?? ref;
}
export function ServiceMark({ name, className }: { name: string; className?: string }) {
  if (/subkit/i.test(name)) return <SubKitMark size="xs" className={className} />;
  if (/slack/i.test(name)) return <Slack className={cn("size-4", className)} aria-hidden />;
  if (/openai|gpt/i.test(name)) return <Sparkles className={cn("size-4", className)} aria-hidden />;
  const brand = BRANDS.find(([r]) => r.test(name))?.[1];
  if (!brand) return <Plug className={cn("size-4 text-muted-foreground", className)} aria-hidden />;
  const color = luminance(brand.hex) < 0.25 ? "currentColor" : `#${brand.hex}`;
  return (
    <svg viewBox="0 0 24 24" className={cn("size-4", className)} aria-hidden>
      <path d={brand.path} fill={color} />
    </svg>
  );
}
export function ServiceTile({
  name,
  size = "md",
  variant = "outline",
  className,
}: {
  name: string;
  size?: keyof typeof tileSize;
  variant?: "muted" | "outline";
  className?: string | undefined;
}) {
  return (
    <IconTile size={size} variant={variant} className={className}>
      <ServiceMark name={name} className={size === "lg" ? "size-[18px]" : "size-4"} />
    </IconTile>
  );
}

const dot: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "bg-muted-foreground",
  neutral: "bg-muted-foreground/60",
};
export function StatusDot({
  tone,
  className,
  pulse,
}: {
  tone: Tone;
  className?: string;
  pulse?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        dot[tone],
        pulse && "animate-pulse",
        className,
      )}
    />
  );
}
const stripDot: Record<Tone, string> = {
  success: "bg-emerald-500",
  info: "bg-blue-500",
  warning: "bg-amber-500",
  danger: "bg-destructive",
  neutral: "bg-muted-foreground/60",
};
export function StatusStrip({
  tone,
  children,
  action,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "mb-6 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm",
        className,
      )}
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", stripDot[tone])} />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
      {action}
    </div>
  );
}

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

export type StepState = "done" | "active" | "pending";
export type StepGraphTier = "sm" | "lg" | "2xl" | "4xl" | "stacked";

export function stepGraphTier(count: number): StepGraphTier {
  if (count <= 3) return "sm";
  if (count === 4) return "lg";
  if (count === 5) return "2xl";
  if (count <= 7) return "4xl";
  return "stacked";
}

type StepGraphParts = Record<"ol" | "li" | "marker" | "before" | "after" | "text", string>;

const STEP_GRAPH_ROW: Record<StepGraphTier, StepGraphParts> = {
  sm: {
    ol: "@sm:flex-row @sm:items-start",
    li: "@sm:min-w-0 @sm:flex-1 @sm:flex-col @sm:items-center @sm:gap-0 @sm:text-center",
    marker: "@sm:w-full @sm:flex-row",
    before: "@sm:block",
    after: "@sm:h-px @sm:min-h-0 @sm:w-auto",
    text: "@sm:items-center @sm:pb-0 @sm:pt-2",
  },
  lg: {
    ol: "@lg:flex-row @lg:items-start",
    li: "@lg:min-w-0 @lg:flex-1 @lg:flex-col @lg:items-center @lg:gap-0 @lg:text-center",
    marker: "@lg:w-full @lg:flex-row",
    before: "@lg:block",
    after: "@lg:h-px @lg:min-h-0 @lg:w-auto",
    text: "@lg:items-center @lg:pb-0 @lg:pt-2",
  },
  "2xl": {
    ol: "@2xl:flex-row @2xl:items-start",
    li: "@2xl:min-w-0 @2xl:flex-1 @2xl:flex-col @2xl:items-center @2xl:gap-0 @2xl:text-center",
    marker: "@2xl:w-full @2xl:flex-row",
    before: "@2xl:block",
    after: "@2xl:h-px @2xl:min-h-0 @2xl:w-auto",
    text: "@2xl:items-center @2xl:pb-0 @2xl:pt-2",
  },
  "4xl": {
    ol: "@4xl:flex-row @4xl:items-start",
    li: "@4xl:min-w-0 @4xl:flex-1 @4xl:flex-col @4xl:items-center @4xl:gap-0 @4xl:text-center",
    marker: "@4xl:w-full @4xl:flex-row",
    before: "@4xl:block",
    after: "@4xl:h-px @4xl:min-h-0 @4xl:w-auto",
    text: "@4xl:items-center @4xl:pb-0 @4xl:pt-2",
  },
  stacked: { ol: "", li: "", marker: "", before: "", after: "", text: "" },
};

export function StepGraph({
  steps,
  label,
}: {
  steps: { label: string; icon?: LucideIcon; state: StepState; sub?: ReactNode }[];
  label: string;
}) {
  const row = STEP_GRAPH_ROW[stepGraphTier(steps.length)];
  return (
    <div className="@container" data-slot="step-graph">
      <ol aria-label={label} className={cn("flex flex-col", row.ol)}>
        {steps.map((st, i) => {
          const I = st.state === "done" ? Check : st.icon;
          const last = i === steps.length - 1;
          return (
            <li key={i} className={cn("flex min-w-0 gap-3 text-left", row.li)}>
              <div className={cn("flex shrink-0 flex-col items-center", row.marker)}>
                <span
                  className={cn(
                    "hidden h-px flex-1",
                    row.before,
                    i === 0
                      ? "bg-transparent"
                      : steps[i - 1]?.state === "done"
                        ? "bg-accent"
                        : "bg-border",
                  )}
                />
                <span
                  aria-current={st.state === "active" ? "step" : undefined}
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-full border-2",
                    st.state === "done"
                      ? "border-accent bg-accent text-accent-foreground"
                      : st.state === "active"
                        ? "border-accent bg-background text-info-ink ring-4 ring-accent/20"
                        : "border-border bg-background text-muted-foreground",
                  )}
                >
                  {I ? (
                    <I className="size-4" aria-hidden />
                  ) : (
                    <span className="font-mono text-xs">{i + 1}</span>
                  )}
                </span>
                <span
                  className={cn(
                    "min-h-3 w-px flex-1",
                    row.after,
                    last ? "bg-transparent" : st.state === "done" ? "bg-accent" : "bg-border",
                  )}
                />
              </div>
              <div className={cn("flex min-w-0 flex-col pb-3 pt-2", row.text)}>
                <span
                  className={cn(
                    "px-2 text-xs font-medium [overflow-wrap:anywhere]",
                    st.state === "pending" && "text-muted-foreground",
                  )}
                >
                  {st.label}
                </span>
                {st.sub && <span className="mt-1 flex flex-wrap gap-1 px-2">{st.sub}</span>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function dayKey(iso: string) {
  return iso.slice(0, 10);
}
export function dayLabel(iso: string, lang: "de" | "en") {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return lang === "de" ? "Heute" : "Today";
  if (same(d, y)) return lang === "de" ? "Gestern" : "Yesterday";
  return new Intl.DateTimeFormat(lang === "de" ? "de-DE" : "en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(d);
}
export interface TimelineItem {
  id: string;
  at: string;
  tone: Tone;
  icon?: LucideIcon | undefined;
  content: ReactNode;
  highlight?: boolean | undefined;
  ref?: ((el: HTMLLIElement | null) => void) | undefined;
}
export function Timeline({
  items,
  lang,
  time,
}: {
  items: TimelineItem[];
  lang: "de" | "en";
  time: (iso: string) => string;
}) {
  const groups: { key: string; label: string; items: TimelineItem[] }[] = [];
  for (const it of items) {
    const k = dayKey(new Date(it.at).toISOString());
    const g = groups.find((x) => x.key === k);
    if (g) g.items.push(it);
    else groups.push({ key: k, label: dayLabel(it.at, lang), items: [it] });
  }
  return (
    <div className="mt-6 space-y-6">
      {groups.map((g) => (
        <section key={g.key}>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {g.label}
          </h3>
          <ol className="relative space-y-3 before:absolute before:bottom-4 before:left-4 before:top-4 before:w-px before:bg-border">
            {g.items.map((it) => (
              <li
                key={it.id}
                ref={it.ref}
                tabIndex={it.highlight ? -1 : undefined}
                className="relative flex gap-4"
              >
                <span className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border bg-background">
                  {it.icon ? (
                    <it.icon className="size-4 text-muted-foreground" aria-hidden />
                  ) : null}
                  <StatusDot
                    tone={it.tone}
                    className={cn(
                      "absolute -right-1 -top-1 ring-2 ring-background",
                      !it.icon && "static ring-0",
                    )}
                  />
                </span>
                <div
                  className={cn(
                    "min-w-0 flex-1 rounded-xl border bg-card p-4",
                    it.highlight && "border-accent ring-2 ring-accent/40",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">{it.content}</div>
                    <time
                      className="shrink-0 font-mono text-xs text-muted-foreground"
                      dateTime={it.at}
                    >
                      {time(it.at)}
                    </time>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  text,
  action,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  text?: string;
  action?: ReactNode;
  testId?: string | undefined;
}) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col items-center rounded-xl border border-dashed px-6 py-12 text-center"
    >
      <span className="flex size-16 items-center justify-center rounded-full bg-muted/60">
        <IconTile icon={icon} size="lg" variant="outline" />
      </span>
      <p className="mt-4 font-semibold">{title}</p>
      {text && <p className="mt-1 text-sm text-muted-foreground">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ConnectionGraphic({
  from,
  via,
  to,
  tone,
  state,
  className,
}: {
  from: ReactNode;
  via: LucideIcon;
  to: ReactNode;
  tone: Tone;
  state: string;
  className?: string;
}) {
  const V = via;
  const line =
    tone === "danger"
      ? "border-destructive/60 border-dashed"
      : tone === "warning"
        ? "border-warning/70 border-dashed"
        : tone === "success"
          ? "border-success/70"
          : "border-border border-dashed";
  return (
    <div className={cn("rounded-xl border bg-muted/30 p-4", className)}>
      <div className="flex items-center">
        {from}
        <span className={cn("mx-2 flex-1 border-t-2", line)} />
        <IconTile icon={V} size="sm" variant="outline" />
        <span className={cn("mx-2 flex-1 border-t-2", line)} />
        {to}
      </div>
      <p className="mt-3 flex items-center gap-2 text-xs">
        <StatusDot tone={tone} pulse={tone === "info"} />
        {state}
      </p>
    </div>
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

export function ServiceChips({
  refs,
  className,
  envs,
}: {
  refs: string[];
  className?: string;
  envs?: Record<string, string> | undefined;
}) {
  const names = [...new Set(refs.map(serviceOf))];
  if (!names.length) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-2", className)}>
      {names.map((n) => (
        <span
          key={n}
          className="inline-flex h-6 items-center gap-2 rounded-full border bg-background pl-1 pr-2 text-xs"
        >
          <ServiceMark name={n} className="size-4" />
          {n}
          {envs?.[n] && <span className="text-muted-foreground">· {envs[n]}</span>}
        </span>
      ))}
    </span>
  );
}

export function EnvChip({
  env,
  label,
  className,
}: {
  env: "test" | "prod";
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-2 rounded-full border px-2 text-xs font-medium",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          env === "prod" ? "bg-emerald-500" : "bg-muted-foreground/60",
        )}
      />
      {label}
    </span>
  );
}

const markSize = {
  xs: "size-5 rounded-[5px]",
  sm: "size-7 rounded-md",
  md: "size-8 rounded-lg",
  lg: "size-12 rounded-xl",
} as const;
const markGlyph = { xs: "size-3.5", sm: "size-[18px]", md: "size-5", lg: "size-8" } as const;
export function SubKitMark({
  size = "md",
  className,
}: {
  size?: keyof typeof markSize;
  className?: string | undefined;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center bg-foreground text-background",
        markSize[size],
        className,
      )}
    >
      <Workflow strokeWidth={2.2} className={markGlyph[size]} />
    </span>
  );
}
