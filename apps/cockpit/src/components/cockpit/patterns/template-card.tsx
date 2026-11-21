import { cn } from "@ui/lib/utils";
import type { ReactNode } from "react";
import { absolute } from "@/app/links";
import { IconTile } from "./icon-tile";

const CARD =
  "flex min-w-0 flex-col gap-2 rounded-lg border bg-background p-4 text-left transition-colors hover:border-foreground/20 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

const ROW = "flex-row items-start gap-3";

export interface TemplateCardProps {
  title: string;
  line: string;
  icons?: readonly ReactNode[];
  lead?: ReactNode;
  tag?: string;
  meta?: readonly ReactNode[];
  href?: string;
  onSelect?(): void;
  testId: string;
}

function Body({ title, line, icons, lead, tag, meta }: TemplateCardProps) {
  if (lead)
    return (
      <>
        {lead}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium" data-slot="template-card-title">
            {title}
          </span>
          <span className="text-xs text-muted-foreground">{line}</span>
        </span>
      </>
    );
  return (
    <>
      {icons?.length || tag ? (
        <span className="flex items-center gap-1.5" data-slot="template-card-icons">
          {icons?.map((icon, index) => (
            <IconTile key={index} size="sm" outline>
              {icon}
            </IconTile>
          ))}
          {tag ? (
            <span
              className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              data-slot="template-card-tag"
            >
              {tag}
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="text-sm font-medium" data-slot="template-card-title">
        {title}
      </span>
      <span className="text-xs text-muted-foreground">{line}</span>
      {meta?.length ? (
        <span
          className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground [&_svg]:size-3.5"
          data-slot="template-card-meta"
        >
          {meta.map((entry, index) => (
            <span key={index} className="inline-flex items-center gap-1">
              {entry}
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
}

export function TemplateCard(props: TemplateCardProps) {
  if (props.href)
    return (
      <a
        href={absolute(props.href)}
        className={cn(CARD, props.lead && ROW)}
        data-slot="template-card"
        data-testid={props.testId}
        onClick={(event) => {
          if (!props.onSelect || event.metaKey || event.ctrlKey || event.button !== 0) return;
          event.preventDefault();
          props.onSelect();
        }}
      >
        <Body {...props} />
      </a>
    );
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={cn(CARD, props.lead && ROW)}
      data-slot="template-card"
      data-testid={props.testId}
    >
      <Body {...props} />
    </button>
  );
}

export function TemplateGrid({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div
      className={cn("grid gap-3 sm:grid-cols-2", wide ? "lg:grid-cols-4" : "lg:grid-cols-3")}
      data-slot="template-grid"
    >
      {children}
    </div>
  );
}
