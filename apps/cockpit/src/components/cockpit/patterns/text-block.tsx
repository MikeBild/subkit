import type { ReactNode } from "react";

export function TextBlock({
  label,
  text,
  note,
  truncated = false,
  testId,
}: {
  label: string;
  text: string;
  note?: ReactNode;
  truncated?: boolean;
  testId: string;
}) {
  return (
    <section
      className="grid gap-1.5"
      aria-label={label}
      data-slot="text-block"
      data-truncated={truncated ? "true" : undefined}
      data-testid={testId}
    >
      <p className="text-sm font-medium">{label}</p>
      <pre
        className="max-h-72 overflow-auto rounded-lg border bg-muted/40 px-3 py-2.5 font-sans text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
        data-testid={`${testId}-text`}
      >
        {text}
      </pre>
      {note ? (
        <p className="text-xs text-muted-foreground" data-testid={`${testId}-length`}>
          {note}
        </p>
      ) : null}
    </section>
  );
}
