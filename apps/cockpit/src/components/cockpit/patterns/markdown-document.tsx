import { useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./code-block";
import { PREVIEW_COMPONENTS } from "./file-preview";
import { markdownOutline, outlineIndent, showsOutline } from "./markdown-outline";
import { SegmentedControl } from "./segmented-control";

type DocumentView = "rendered" | "source";

const INDENT = ["pl-0", "pl-3", "pl-6"] as const;

export function MarkdownDocument({
  text,
  source,
  testId,
}: {
  text: string;
  source?: string;
  testId?: string;
}) {
  const { t } = useI18n();
  const id = testId ?? "markdown-document";
  const [view, setView] = useState<DocumentView>("rendered");
  const article = useRef<HTMLElement>(null);
  const outline = markdownOutline(text);
  const contents = view === "rendered" && showsOutline(outline);
  const jump = (index: number) =>
    article.current
      ?.querySelectorAll<HTMLElement>("[data-document-level]")
      [index]?.scrollIntoView({ block: "start", behavior: "smooth" });
  return (
    <div
      className="@container flex min-w-0 flex-col gap-3"
      data-slot="markdown-document"
      data-view={view}
      data-testid={testId}
    >
      <div className="flex min-h-8 items-center" data-slot="markdown-document-bar">
        <SegmentedControl
          label={t("markdown.mode")}
          value={view}
          onValueChange={(next) => setView(next === "source" ? "source" : "rendered")}
          testId={`${id}-view`}
          options={[
            {
              value: "rendered",
              label: t("markdown.view.rendered"),
              testId: `${id}-view-rendered`,
            },
            { value: "source", label: t("markdown.view.source"), testId: `${id}-view-source` },
          ]}
        />
      </div>
      {view === "source" ? (
        <CodeBlock code={source ?? text} lang="markdown" testId={`${id}-source`} />
      ) : (
        <div
          className={cn(
            "grid min-w-0 items-start gap-6",
            contents && "@4xl:grid-cols-[minmax(0,1fr)_14rem]",
          )}
        >
          <article
            ref={article}
            data-slot="markdown-document-body"
            data-testid={`${id}-body`}
            className="min-w-0 overflow-x-auto rounded-lg border p-5 text-sm [overflow-wrap:anywhere] [&_[data-document-level]]:scroll-mt-4"
          >
            <Streamdown components={PREVIEW_COMPONENTS}>{text}</Streamdown>
          </article>
          {contents ? (
            <nav
              aria-label={t("markdown.contents")}
              data-slot="markdown-document-contents"
              data-testid={`${id}-contents`}
              className="sticky top-4 hidden max-h-[calc(100dvh-8rem)] min-w-0 overflow-y-auto text-sm @4xl:block"
            >
              <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {t("markdown.contents")}
              </p>
              <ul className="flex flex-col gap-1 border-l">
                {outline.map((entry, index) => (
                  <li
                    key={`${index}:${entry.text}`}
                    className={INDENT[outlineIndent(outline, entry)]}
                  >
                    <button
                      type="button"
                      onClick={() => jump(index)}
                      data-testid={`${id}-contents-${index}`}
                      className="block w-full truncate rounded-sm py-0.5 pl-3 text-left text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {entry.text}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </div>
      )}
    </div>
  );
}
