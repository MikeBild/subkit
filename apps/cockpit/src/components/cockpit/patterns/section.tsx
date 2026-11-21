import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@ui/atoms/collapsible";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useId } from "react";

export const SECTION_LABEL = "text-xs font-medium text-muted-foreground";

export function SectionHeading({
  id,
  className = SECTION_LABEL,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <h2 id={id} className={className} data-slot="section-label">
      {children}
    </h2>
  );
}

export function SectionSubheading({
  className = "text-sm font-medium",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <h3 className={className}>{children}</h3>;
}

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
  const heading = useId();
  return (
    <section
      data-slot="section"
      data-testid={testId}
      aria-labelledby={label ? heading : undefined}
      className="flex flex-col gap-3"
    >
      {label || aside ? (
        <div className="flex items-center gap-2">
          {label ? <SectionHeading id={heading}>{label}</SectionHeading> : null}
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
  open,
  onOpenChange,
  id,
  testId,
  children,
}: {
  label: string;
  count?: number;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  id?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
      id={id}
      data-slot="collapsible-section"
      data-testid={testId}
    >
      <h2 className="text-sm font-medium" data-slot="section-label">
        <CollapsibleTrigger
          className="group/section -ml-2 inline-flex h-8 items-center gap-1.5 rounded-md px-2 transition-colors duration-(--sk-dur-fast) hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid={testId ? `${testId}-toggle` : undefined}
        >
          <ChevronRight
            aria-hidden="true"
            className="size-4 text-muted-foreground transition-transform duration-(--sk-dur-base) ease-(--sk-ease-standard) group-data-[state=open]/section:rotate-90"
          />
          {label}
          {count !== undefined ? (
            <span className="font-normal text-muted-foreground tabular-nums">{count}</span>
          ) : null}
        </CollapsibleTrigger>
      </h2>
      <CollapsibleContent className="sk-collapsible overflow-hidden">
        <div className="pt-2 pl-[22px]">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
