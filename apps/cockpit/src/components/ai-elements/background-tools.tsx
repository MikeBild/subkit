"use client";

import { ChevronDownIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { Shimmer } from "./shimmer";

// Reads that changed nothing, on one line each.
//
// An agent answering "which workflows fail most" may list workflows, read four
// of them and search the knowledge base before it says a word. Rendering six
// collapsible cards for that buries the one call that mattered under five that
// did not. These get a line; a run, a write or a question still gets a card.

export interface BackgroundToolLine {
  /** Already-translated label — present tense while running, past when done. */
  label: string;
  /** How many consecutive identical calls this line stands for. */
  count: number;
  running: boolean;
}

export interface BackgroundToolsProps {
  lines: readonly BackgroundToolLine[];
  testId: string;
  className?: string;
}

export function BackgroundTools({ lines, testId, className }: BackgroundToolsProps) {
  const { t } = useI18n();
  if (lines.length === 0) return null;

  const anyRunning = lines.some((line) => line.running);
  const total = lines.reduce((sum, line) => sum + line.count, 0);

  // A single line says what it is. Several only collapse once they are all
  // finished — collapsing work still in flight would hide the thing a person
  // is currently waiting on.
  if (lines.length === 1 || anyRunning) {
    return (
      <div className={cn("mb-2 flex flex-col gap-1", className)} data-testid={testId}>
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
    <Collapsible className={cn("mb-2", className)} data-testid={testId}>
      <CollapsibleTrigger
        className="group/bg flex items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground"
        data-testid={`${testId}-toggle`}
      >
        {t("tool.background.collapsed", { count: String(total) })}
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
