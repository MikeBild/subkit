import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export const SECTION_LABEL = "text-xs font-medium text-muted-foreground";

export function Section({
  label,
  aside,
  testId,
  children,
}: {
  label?: string;
  aside?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section data-slot="section" data-testid={testId} className="flex flex-col gap-3">
      {label || aside ? (
        <div className="flex items-center gap-2">
          {label ? (
            <h2 className={SECTION_LABEL} data-slot="section-label">
              {label}
            </h2>
          ) : null}
          {aside ? <span className="ml-auto flex items-center gap-2">{aside}</span> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function CollapsibleSection({
  label,
  count,
  defaultOpen = false,
  testId,
  children,
}: {
  label: string;
  count?: number;
  defaultOpen?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} data-slot="collapsible-section" data-testid={testId}>
      <h2 className={SECTION_LABEL} data-slot="section-label">
        <CollapsibleTrigger
          className="group/section inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid={testId ? `${testId}-toggle` : undefined}
        >
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 transition-transform duration-(--sk-dur-base) ease-(--sk-ease-standard) group-data-[state=open]/section:rotate-90"
          />
          {label}
          {count !== undefined ? <span className="tabular-nums">({count})</span> : null}
        </CollapsibleTrigger>
      </h2>
      <CollapsibleContent className="sk-collapsible overflow-hidden">
        <div className="pt-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
