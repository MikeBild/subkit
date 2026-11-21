import { Input } from "@ui/atoms/input";
import { applyFormat, type Edit, type Fmt, insertText, refToken } from "@ui/lib/markdown";
import { matches } from "@ui/lib/search";
import { useI18n } from "@ui/lib/ui-context";
import { cn } from "@ui/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/molecules/popover";
import {
  AtSign,
  Bold,
  Code,
  Heading2,
  Italic,
  Link2,
  List,
  ListOrdered,
  type LucideIcon,
} from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { MarkdownDocument } from "./markdown-document";

type Mode = "write" | "split" | "preview";
const TOOLS: [Fmt, LucideIcon][] = [
  ["heading", Heading2],
  ["bold", Bold],
  ["italic", Italic],
  ["list", List],
  ["olist", ListOrdered],
  ["link", Link2],
  ["code", Code],
];
export interface MarkdownRefGroup {
  prefix: string;
  label: string;
  icon: LucideIcon;
  names: readonly string[];
}

export interface MarkdownRefs {
  groups: readonly MarkdownRefGroup[];
  search: string;
  hint: string;
}

export function MarkdownEditor({
  id,
  value,
  onChange,
  invalid,
  minHeight = 240,
  refs,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  minHeight?: number;
  refs?: MarkdownRefs | undefined;
}) {
  const { t } = useI18n();
  const e = t.md.editor;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<Mode>("split");
  const [pick, setPick] = useState(false);
  const [q, setQ] = useState("");
  const groups = (refs?.groups ?? []).map((group) => ({
    ...group,
    names: group.names.filter((name) => matches(q, name)),
  }));
  const found = groups.some((group) => group.names.length > 0);

  const commit = (ed: Edit) => {
    onChange(ed.value);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.setSelectionRange(ed.start, ed.end);
      }
    });
  };
  const sel = () => {
    const el = ref.current;
    return el
      ? ([el.selectionStart, el.selectionEnd] as const)
      : ([value.length, value.length] as const);
  };
  const fmt = (f: Fmt) => {
    if (mode === "preview") setMode("split");
    const [a, b] = sel();
    commit(applyFormat(value, a, b, f, e.linkText));
  };
  const insertRef = (prefix: string, name: string) => {
    const [a, b] = sel();
    commit(insertText(value, a, b, refToken(prefix, name.replace(/\s+/g, "-"))));
    setPick(false);
    setQ("");
  };
  const onKey = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(ev.metaKey || ev.ctrlKey)) {
      if (ev.key === "@" && !ev.altKey) {
        requestAnimationFrame(() => setPick(true));
      }
      return;
    }
    const k = ev.key.toLowerCase();
    if (k === "b" || k === "i") {
      ev.preventDefault();
      fmt(k === "b" ? "bold" : "italic");
    }
  };

  const editor = (
    <textarea
      id={id}
      ref={ref}
      value={value}
      onChange={(x) => onChange(x.target.value)}
      onKeyDown={onKey}
      placeholder={e.placeholder}
      aria-label={e.label}
      aria-invalid={invalid || undefined}
      spellCheck
      style={{ minHeight }}
      className="block h-full w-full resize-y bg-transparent p-4 font-mono text-xs leading-5 outline-none placeholder:text-muted-foreground"
    />
  );
  const preview = (
    <div className="h-full overflow-auto p-4" style={{ minHeight }} aria-label={e.modes.preview}>
      {value.trim() ? (
        <MarkdownDocument text={value} toolbar={false} toc={false} />
      ) : (
        <p className="text-sm text-muted-foreground">{e.empty}</p>
      )}
    </div>
  );

  return (
    <div
      className={cn(
        "@container overflow-hidden rounded-lg border bg-background focus-within:ring-2 focus-within:ring-ring/40",
        invalid && "border-destructive",
      )}
    >
      <div className="flex flex-wrap items-center gap-2 border-b px-2 py-1">
        <div role="toolbar" aria-label={e.toolbar} className="flex flex-wrap items-center gap-1">
          {TOOLS.map(([f, Icon]) => (
            <button
              key={f}
              type="button"
              title={f === "bold" ? `${e.bold} (⌘B)` : f === "italic" ? `${e.italic} (⌘I)` : e[f]}
              aria-label={e[f]}
              onClick={() => fmt(f)}
              className="inline-flex size-8 items-center justify-center rounded-control text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Icon className="size-4" aria-hidden />
            </button>
          ))}
          <Popover
            open={pick}
            onOpenChange={(o) => {
              setPick(o);
              if (!o) setQ("");
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-2 rounded-control px-2 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <AtSign className="size-4" aria-hidden />
                {e.ref.replace(/^@\s*/, "")}
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 p-2">
              <Input
                autoFocus
                value={q}
                onChange={(x) => setQ(x.target.value)}
                placeholder={refs?.search}
                aria-label={refs?.search}
                className="h-8"
              />
              <div className="mt-2 max-h-64 overflow-auto">
                {groups.map((group) => {
                  if (!group.names.length) return null;
                  const Icon = group.icon;
                  return (
                    <div key={group.prefix} className="py-1">
                      <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                        {group.label}
                      </p>
                      {group.names.map((name) => (
                        <button
                          key={name}
                          type="button"
                          data-slot="button"
                          onClick={() => insertRef(group.prefix, name)}
                          className="flex w-full items-center gap-2 rounded-control px-2 py-2 text-left text-sm hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none"
                        >
                          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="min-w-0 flex-1 truncate">{name}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            @{group.prefix}
                          </span>
                        </button>
                      ))}
                    </div>
                  );
                })}
                {!found && <p className="px-2 py-4 text-sm text-muted-foreground">{e.refNone}</p>}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{e.view}</span>
          <div
            role="group"
            aria-label={e.view}
            className="inline-flex h-8 rounded-control border p-0.5"
          >
            {(["write", "split", "preview"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  "rounded-[6px] px-2 font-medium",
                  mode === m
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {e.modes[m]}
              </button>
            ))}
          </div>
        </div>
      </div>
      {mode === "write" ? (
        editor
      ) : mode === "preview" ? (
        preview
      ) : (
        <div className="grid @2xl:grid-cols-2 [&>*+*]:border-t @2xl:[&>*+*]:border-l @2xl:[&>*+*]:border-t-0">
          {editor}
          {preview}
        </div>
      )}
      <div className="flex items-center justify-between gap-4 border-t px-4 py-2 text-xs text-muted-foreground">
        <span>{refs?.hint ?? e.footer}</span>
        <span className="shrink-0 tabular-nums">{e.chars(value.length)}</span>
      </div>
    </div>
  );
}
