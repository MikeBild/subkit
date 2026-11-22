import { ChevronRight } from "lucide-react";
import type { SourceSection } from "@/features/knowledge/model/knowledge-sources-model";

export function SourceSections({
  sections,
  onOpen,
}: {
  sections: SourceSection[];
  onOpen: (key: string) => void;
}) {
  return (
    <ol className="divide-y rounded-xl border">
      {sections.map((x, i) => (
        <li key={x.key}>
          <button
            data-testid="kn-sources-section"
            type="button"
            onClick={() => onOpen(x.key)}
            className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-muted/40"
          >
            <span className="w-6 font-mono text-xs text-muted-foreground">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="flex-1 font-medium">{x.title}</span>
            <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
          </button>
        </li>
      ))}
    </ol>
  );
}
