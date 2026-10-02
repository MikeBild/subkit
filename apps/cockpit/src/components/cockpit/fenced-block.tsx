import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { IconButton } from "@/components/cockpit/icon-button";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";

/** What the block holds; carried as `data-language`, never used to colour it. */
export type FencedLanguage = "bash" | "javascript" | "python" | "json" | "sql" | "graphql" | "text";

/**
 * A payload as the reader gets it: a real `<pre>`, byte for byte, with a way
 * to copy it. Whatever stands in here is CONTENT — a request body, a query, a
 * command — so an identifier inside it is shown whole. It is the one place on
 * a page where that is allowed, and the place a call or a configuration
 * belongs for exactly that reason.
 *
 * The block is deliberately plain text: a syntax highlighter would ship every
 * grammar it knows into the bundle to colour a handful of short snippets.
 */
export function FencedBlock({
  label,
  code,
  language = "text",
  testId,
  className,
  actions,
}: {
  /** What the block is, in the header. */
  label: ReactNode;
  code: string;
  language?: FencedLanguage;
  testId: string;
  className?: string;
  /** Further controls in the header, before the copy button. */
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div
      className={cn("min-w-0 overflow-hidden rounded-xl border bg-muted/40", className)}
      data-testid={testId}
      data-language={language}
      // Each block's copy button copies that block.
      data-action-scope="fenced-block"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="min-w-0 truncate text-xs text-muted-foreground">{label}</span>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          <IconButton
            label={t("common.copy")}
            onClick={() =>
              void navigator.clipboard
                .writeText(code)
                .then(() => toast.success(t("connectorDetail.copied")))
            }
            data-testid={`${testId}-copy`}
          >
            <Copy />
          </IconButton>
        </div>
      </div>
      <pre className="max-h-80 overflow-auto p-3 text-xs">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}
