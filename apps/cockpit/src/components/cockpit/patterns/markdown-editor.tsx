import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderText } from "@codemirror/view";
import {
  AtSign,
  Bold,
  Code,
  Heading2,
  Italic,
  Link,
  List,
  ListOrdered,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { PREVIEW_COMPONENTS } from "./file-preview";
import { formatMarkdown, type MarkdownFormat } from "./markdown-format";
import { SegmentedControl } from "./segmented-control";

export type MarkdownEditorMode = "write" | "split" | "preview";

const TOOLS: readonly { format: MarkdownFormat; icon: LucideIcon; key: TranslationKey }[] = [
  { format: "heading", icon: Heading2, key: "markdown.heading" },
  { format: "bold", icon: Bold, key: "markdown.bold" },
  { format: "italic", icon: Italic, key: "markdown.italic" },
  { format: "list", icon: List, key: "markdown.list" },
  { format: "ordered", icon: ListOrdered, key: "markdown.ordered" },
  { format: "link", icon: Link, key: "markdown.link" },
  { format: "code", icon: Code, key: "markdown.code" },
  { format: "reference", icon: AtSign, key: "markdown.reference" },
];

const THEME = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--foreground)", fontSize: "12.5px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    lineHeight: "1.5rem",
  },
  ".cm-content": { padding: "8px 0", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0 12px" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--ring) 28%, transparent)",
  },
});

function applyFormat(view: EditorView, format: MarkdownFormat): boolean {
  const range = view.state.selection.main;
  const edit = formatMarkdown(
    view.state.doc.toString(),
    { from: range.from, to: range.to },
    format,
  );
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: edit.selection.from, head: edit.selection.to },
  });
  view.focus();
  return true;
}

export function MarkdownEditor({
  value,
  onChange,
  label,
  id,
  placeholder,
  rows = 12,
  defaultMode = "write",
  disabled = false,
  invalid = false,
  testId = "markdown-editor",
}: {
  value: string;
  onChange(value: string): void;
  label: string;
  id?: string;
  placeholder?: string;
  rows?: number;
  defaultMode?: MarkdownEditorMode;
  disabled?: boolean;
  invalid?: boolean;
  testId?: string;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<MarkdownEditorMode>(defaultMode);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          history(),
          keymap.of([
            { key: "Mod-b", run: (target) => applyFormat(target, "bold") },
            { key: "Mod-i", run: (target) => applyFormat(target, "italic") },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          markdown(),
          EditorView.lineWrapping,
          placeholderText(placeholder ?? ""),
          EditorState.readOnly.of(disabled),
          EditorView.editable.of(!disabled),
          EditorView.contentAttributes.of({
            "aria-label": label,
            "aria-multiline": "true",
            ...(id ? { id } : {}),
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
          THEME,
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [disabled, id, label, placeholder]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== value)
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  const format = (next: MarkdownFormat) => {
    const editor = view.current;
    if (!editor || disabled) return;
    if (mode === "preview") setMode("write");
    applyFormat(editor, next);
  };

  const writing = mode !== "preview";
  const previewing = mode !== "write";
  return (
    <div
      data-slot="markdown-editor"
      data-mode={mode}
      data-testid={testId}
      aria-invalid={invalid || undefined}
      className={cn(
        "flex min-w-0 flex-col rounded-lg border border-input transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
        invalid && "border-destructive ring-3 ring-destructive/20",
        disabled && "opacity-50",
      )}
    >
      <div
        className="flex flex-wrap items-center gap-0.5 border-b px-1.5 py-1"
        data-slot="markdown-toolbar"
      >
        <div role="toolbar" aria-label={t("markdown.toolbar")} className="flex flex-wrap gap-0.5">
          {TOOLS.map((tool) => (
            <button
              key={tool.format}
              type="button"
              title={t(tool.key)}
              aria-label={t(tool.key)}
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => format(tool.format)}
              data-testid={`${testId}-${tool.format}`}
              className="inline-grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none [&_svg]:size-4"
            >
              <tool.icon aria-hidden="true" />
            </button>
          ))}
        </div>
        <div className="ml-auto flex min-w-0 max-w-full">
          <SegmentedControl
            label={t("markdown.mode")}
            value={mode}
            onValueChange={(next) => setMode(next as MarkdownEditorMode)}
            testId={`${testId}-mode`}
            options={[
              { value: "write", label: t("markdown.write"), testId: `${testId}-write` },
              { value: "split", label: t("markdown.split"), testId: `${testId}-split` },
              { value: "preview", label: t("markdown.preview"), testId: `${testId}-preview` },
            ]}
          />
        </div>
      </div>
      <div className={cn("grid min-w-0", mode === "split" && "lg:grid-cols-2")}>
        <div
          ref={host}
          hidden={!writing}
          data-slot="markdown-source"
          className="min-w-0 overflow-auto"
          style={{ minHeight: `${rows * 1.5 + 1}rem`, maxHeight: "60vh" }}
        />
        {previewing ? (
          <section
            data-slot="markdown-preview"
            data-testid={`${testId}-rendered`}
            aria-label={t("markdown.previewLabel", { label })}
            className={cn(
              "min-w-0 overflow-auto p-4 text-sm",
              mode === "split" && "hidden border-l lg:block",
            )}
            style={{ minHeight: `${rows * 1.5 + 1}rem`, maxHeight: "60vh" }}
          >
            {value.trim() ? (
              <Streamdown components={PREVIEW_COMPONENTS}>{value}</Streamdown>
            ) : (
              <p className="text-muted-foreground">{t("markdown.empty")}</p>
            )}
          </section>
        ) : null}
      </div>
      <div
        className="flex items-center justify-between gap-3 border-t px-3 py-1 text-xs text-muted-foreground"
        data-slot="markdown-footer"
      >
        <span>{t("markdown.hint")}</span>
        <span className="shrink-0 tabular-nums">
          {t("markdown.characters", { count: value.length })}
        </span>
      </div>
    </div>
  );
}
