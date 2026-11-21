"use client";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@ui/atoms/collapsible";
import { cn } from "@ui/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n-context";
import { Shimmer } from "./shimmer";

export interface BackgroundToolLine {
  label: string;
  count: number;
  running: boolean;
}

export interface BackgroundToolsProps {
  lines: readonly BackgroundToolLine[];
  testId: string;
  className?: string;
}

export function BackgroundTools({ lines, testId, className }: BackgroundToolsProps) {
  const { tn } = useI18n();
  if (lines.length === 0) return null;

  const anyRunning = lines.some((line) => line.running);
  const total = lines.reduce((sum, line) => sum + line.count, 0);

  if (lines.length === 1 || anyRunning) {
    return (
      <div className={cn("flex flex-col gap-1", className)} data-testid={testId}>
        {lines.map((line, index) => (
          <BackgroundLine
            key={`${line.label}-${index}`}
            line={line}
            testId={`${testId}-item-${index}`}
          />
        ))}
      </div>
    );
  }

  return (
    <Collapsible className={className} data-testid={testId}>
      <CollapsibleTrigger
        className="group/bg flex items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground"
        data-testid={`${testId}-toggle`}
      >
        {tn("tool.background.collapsed", total)}
        <ChevronDownIcon className="size-3 transition-transform group-data-[state=open]/bg:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 flex flex-col gap-1">
        {lines.map((line, index) => (
          <BackgroundLine
            key={`${line.label}-${index}`}
            line={line}
            testId={`${testId}-item-${index}`}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function BackgroundLine({ line, testId }: { line: BackgroundToolLine; testId: string }) {
  const suffix = line.count > 1 ? ` ×${line.count}` : "";
  if (line.running) {
    return (
      <Shimmer as="span" className="text-muted-foreground text-xs" data-testid={testId}>
        {`${line.label}${suffix}`}
      </Shimmer>
    );
  }
  return (
    <span className="text-muted-foreground text-xs" data-testid={testId}>
      {`${line.label}${suffix}`}
    </span>
  );
}
