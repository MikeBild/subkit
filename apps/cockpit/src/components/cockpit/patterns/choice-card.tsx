import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * One way to go, as a full-width card (P14): icon, title, one line. Choosing
 * it proceeds — the dialog that offers two ways has no submit of its own,
 * only "Abbrechen".
 */
export function ChoiceCard({
  icon,
  title,
  line,
  onSelect,
  testId,
}: {
  icon: ReactNode;
  title: string;
  line: string;
  onSelect(): void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex min-h-16 w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      data-slot="choice-card"
      data-testid={testId}
    >
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4"
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-sm text-muted-foreground">{line}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}
