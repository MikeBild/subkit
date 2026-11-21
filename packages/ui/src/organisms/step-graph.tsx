import { cn } from "@ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import { Check } from "lucide-react";
import type { ReactNode } from "react";

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
