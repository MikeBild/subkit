import { Button } from "@ui/atoms/button";
import { headings, markdownLink, slug, stripTitleHeading } from "@ui/lib/markdown";
import { useI18n } from "@ui/lib/ui-context";
import { cn } from "@ui/lib/utils";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

for (const [n, l] of Object.entries({
  bash,
  javascript,
  typescript,
  json,
  yaml,
  python,
  sql,
  xml,
  markdown,
}))
  if (!hljs.getLanguage(n)) hljs.registerLanguage(n, l);
const ALIAS: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  js: "javascript",
  ts: "typescript",
  yml: "yaml",
  py: "python",
  html: "xml",
  md: "markdown",
};

function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-label={label}
      className={cn("h-8 gap-2 px-2 text-xs", className)}
      onClick={() => {
        void navigator.clipboard?.writeText(text).catch(() => undefined);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {done ? t.md.copied : t.md.copy}
    </Button>
  );
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const { t } = useI18n();
  const l = lang ? (ALIAS[lang] ?? lang) : undefined;
  const html = useMemo(() => {
    try {
      return l && hljs.getLanguage(l)
        ? hljs.highlight(code, { language: l }).value
        : hljs.highlightAuto(code, ["json", "bash", "typescript", "yaml", "sql"]).value;
    } catch {
      return null;
    }
  }, [code, l]);
  return (
    <div className="md-code not-prose">
      <div className="flex h-10 items-center justify-between border-b px-4">
        <span className="font-mono text-xs text-muted-foreground">{lang || "text"}</span>
        <CopyButton text={code} label={t.md.copyCode} className="-mr-2" />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-xs leading-5">
        {html ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </div>
  );
}

const text = (n: ReactNode): string =>
  typeof n === "string" || typeof n === "number"
    ? String(n)
    : Array.isArray(n)
      ? n.map(text).join("")
      : n && typeof n === "object" && "props" in n
        ? text((n as { props: { children?: ReactNode } }).props.children)
        : "";

export function MarkdownDocument({
  text: src,
  className,
  toolbar = true,
  toc = true,
  compact = false,
  underTitle,
}: {
  text: string;
  className?: string;
  toolbar?: boolean;
  toc?: boolean;
  compact?: boolean;
  underTitle?: string;
}) {
  const { t } = useI18n();
  const uid = useId().replace(/:/g, "");
  const [raw, setRaw] = useState(false);
  const shown = useMemo(
    () => (underTitle ? stripTitleHeading(src, underTitle) : src),
    [src, underTitle],
  );
  const hs = useMemo(() => headings(shown), [shown]);
  const showToc = toc && !compact && hs.length >= 3;
  const components = ((): Components => {
    const counts = new Map<string, number>();
    const h =
      (lvl: number) =>
      ({ children }: { children?: ReactNode }) => {
        const base = slug(text(children));
        const n = counts.get(base) ?? 0;
        counts.set(base, n + 1);
        const Tag = `h${Math.min(6, lvl + 1)}` as "h2";
        return (
          <Tag id={`${uid}-${n ? `${base}-${n}` : base}`} data-level={lvl}>
            {children}
          </Tag>
        );
      };
    return {
      h1: h(1),
      h2: h(2),
      h3: h(3),
      h4: h(4),
      h5: h(5),
      h6: h(6),
      pre: ({ children }) => {
        const c = Array.isArray(children) ? children[0] : children;
        const props = (
          c && typeof c === "object" && "props" in c
            ? (c as { props: { className?: string; children?: ReactNode } }).props
            : {}
        ) as { className?: string; children?: ReactNode };
        const lang = /language-(\w+)/.exec(props.className ?? "")?.[1];
        return (
          <CodeBlock code={text(props.children).replace(/\n$/, "")} {...(lang ? { lang } : {})} />
        );
      },
      a: ({ href, children }) => {
        const link = markdownLink(href);
        if (link.kind === "external")
          return (
            <a href={link.href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              if (link.kind === "fragment")
                document
                  .getElementById(`${uid}-${link.id}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          >
            {children}
          </a>
        );
      },
      table: ({ children }) => (
        <div className="md-table">
          <table>{children}</table>
        </div>
      ),
    };
  })();
  const body = (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {shown}
    </Markdown>
  );

  return (
    <div className={cn("@container", className)}>
      {toolbar && !compact && (
        <div className="mb-4 flex items-center justify-between gap-2">
          <div
            role="group"
            aria-label={t.md.viewLabel}
            className="inline-flex h-8 rounded-control border p-0.5"
          >
            {([false, true] as const).map((r) => (
              <button
                key={String(r)}
                type="button"
                aria-pressed={raw === r}
                onClick={() => setRaw(r)}
                className={cn(
                  "rounded-[6px] px-3 text-xs font-medium transition-colors",
                  raw === r
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {r ? t.md.source : t.md.rendered}
              </button>
            ))}
          </div>
          {raw && <CopyButton text={src} label={t.md.copySource} />}
        </div>
      )}
      {raw && !compact ? (
        <pre
          className="max-h-[560px] overflow-auto rounded-lg bg-muted p-4 font-mono text-xs leading-5 whitespace-pre-wrap"
          aria-label={t.md.source}
        >
          {src}
        </pre>
      ) : (
        <div
          className={cn(
            showToc && "@[40rem]:grid @[40rem]:grid-cols-[minmax(0,1fr)_160px] @[40rem]:gap-8",
          )}
        >
          <div className={cn("md-doc", compact && "md-compact")}>{body}</div>
          {showToc && (
            <nav aria-label={t.md.toc} className="hidden @[40rem]:block">
              <div className="sticky top-0 border-l pl-4">
                <p className="mb-2 text-xs font-medium text-muted-foreground">{t.md.toc}</p>
                <ul className="text-sm">
                  {hs.map((x) => (
                    <li
                      key={x.id}
                      style={{
                        paddingLeft: `${Math.max(0, x.level - (hs[0]?.level ?? 1)) * 12}px`,
                      }}
                    >
                      <button
                        type="button"
                        data-slot="button"
                        className="py-1 text-left leading-5 text-muted-foreground hover:text-foreground focus-visible:text-foreground"
                        onClick={() =>
                          document
                            .getElementById(`${uid}-${x.id}`)
                            ?.scrollIntoView({ behavior: "smooth", block: "start" })
                        }
                      >
                        {x.text}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </nav>
          )}
        </div>
      )}
    </div>
  );
}
