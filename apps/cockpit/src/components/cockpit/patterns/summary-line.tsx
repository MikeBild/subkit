import type { ReactNode } from "react";
import { ContextHelp } from "./context-help";

/**
 * The first element of every tab (P5): one muted sentence, its (?) and, on the
 * right, the control that chooses what the tab shows (a SegmentedControl).
 */
export function SummaryLine({
  text,
  help,
  aside,
  testId,
}: {
  text: ReactNode;
  help?: ReactNode;
  aside?: ReactNode;
  testId?: string;
}) {
  const id = testId ?? "summary-line";
  return (
    <div
      data-slot="summary-line"
      data-testid={testId}
      className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
    >
      <span className="min-w-0" data-slot="summary-line-text">
        {text}
      </span>
      {help ? (
        <ContextHelp label={typeof text === "string" ? text : id} testId={`${id}-help`}>
          {help}
        </ContextHelp>
      ) : null}
      {aside ? <span className="ml-auto flex items-center gap-2">{aside}</span> : null}
    </div>
  );
}
