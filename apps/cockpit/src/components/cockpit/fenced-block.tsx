import type { ReactNode } from "react";
import type { BundledLanguage } from "shiki";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";

/** How a block is highlighted; `text` is shown without highlighting. */
export type FencedLanguage = "bash" | "javascript" | "python" | "json" | "sql" | "graphql" | "text";

/**
 * A payload as the reader gets it: a real `<pre>`, byte for byte, with a way
 * to copy it. Whatever stands in here is CONTENT — a request body, a query, a
 * command — so an identifier inside it is shown whole. It is the one place on
 * a page where that is allowed, and the place a call or a configuration
 * belongs for exactly that reason.
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
    <CodeBlock
      code={code}
      // The highlighter treats an unknown grammar as plain text.
      language={language as BundledLanguage}
      className={cn("min-w-0 [&_pre]:max-h-80 [&_pre]:overflow-auto [&_pre]:text-xs", className)}
      data-testid={testId}
    >
      <CodeBlockHeader>
        <CodeBlockTitle className="min-w-0 truncate">{label}</CodeBlockTitle>
        <CodeBlockActions>
          {actions}
          <CodeBlockCopyButton label={t("common.copy")} data-testid={`${testId}-copy`} />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
}
