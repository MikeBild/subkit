import type { ReactNode } from "react";
import { ContextHelp } from "./context-help";

export interface Fact {
  label: ReactNode;
  value: ReactNode;
  help?: ReactNode;
  testId?: string;
}

/** Every set of key/value facts (P9): a two-column list, the label muted. */
export function FactList({ items, testId }: { items: readonly Fact[]; testId?: string }) {
  return (
    <dl
      data-slot="fact-list"
      data-testid={testId}
      className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-6 gap-y-2 text-sm"
    >
      {items.map((item, index) => (
        <div key={item.testId ?? index} className="contents" data-testid={item.testId}>
          <dt className="flex items-center gap-1 text-muted-foreground">
            {item.label}
            {item.help ? (
              <ContextHelp
                label={typeof item.label === "string" ? item.label : `${index}`}
                testId={`${item.testId ?? `${testId ?? "fact"}-${index}`}-help`}
              >
                {item.help}
              </ContextHelp>
            ) : null}
          </dt>
          <dd className="min-w-0 break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
