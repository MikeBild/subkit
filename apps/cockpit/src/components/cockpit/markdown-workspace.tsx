import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";

import { type ComponentProps, useEffect, useRef, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button, SegmentedControl, Spinner } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";

type MarkdownMode = "write" | "preview" | "split";

const DOCUMENT_HEADING_CLASS: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
  1: "mt-6 mb-2 text-xl font-semibold",
  2: "mt-6 mb-2 text-lg font-semibold",
  3: "mt-4 mb-2 text-base font-semibold",
  4: "mt-4 mb-1 text-sm font-semibold",
  5: "mt-3 mb-1 text-sm font-medium",
  6: "mt-3 mb-1 text-sm font-medium text-muted-foreground",
};

function documentHeading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  return ({ children }: ComponentProps<"h1">) => (
    // biome-ignore lint/a11y/useSemanticElements: a heading of the document, not of the page — the page's heading elements are its own (one h1, its section labels).
    <p role="heading" aria-level={Math.min(level + 1, 6)} className={DOCUMENT_HEADING_CLASS[level]}>
      {children}
    </p>
  );
}

/**
 * A document's headings, one level below the page's. The page's one h1 is the
 * record's name; a document's own "# Titel" is content inside that page, so
 * it is announced as a heading of the document — not as a second page title.
 */
const DOCUMENT_COMPONENTS = {
  h1: documentHeading(1),
  h2: documentHeading(2),
  h3: documentHeading(3),
  h4: documentHeading(4),
  h5: documentHeading(5),
  h6: documentHeading(6),
};

const cockpitEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    fontSize: "14px",
  },
  ".cm-content": {
    caretColor: "var(--foreground)",
    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
    lineHeight: "1.65",
    padding: "16px",
  },
  ".cm-gutters": {
    backgroundColor: "var(--muted)",
    borderRight: "1px solid var(--border)",
    color: "var(--muted-foreground)",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "color-mix(in oklch, var(--muted), transparent 35%)",
  },
  ".cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklch, var(--primary), transparent 75%)",
  },
});

function MarkdownEditor({
  value,
  onChange,
  onSave,
  readOnly,
  label,
}: {
  value: string;
  onChange(value: string): void;
  onSave?(): void;
  readOnly: boolean;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          markdown(),
          cockpitEditorTheme,
          EditorState.readOnly.of(readOnly),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [label, readOnly]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return (
    <div ref={host} className="h-full min-h-72 overflow-hidden" data-testid="markdown-editor" />
  );
}

/**
 * A markdown document to write and read: the mode as a segmented control
 * (write · preview · side by side), and the one save, which is the page's
 * filled action while there is something to save.
 */
export function MarkdownWorkspace({
  value,
  onChange,
  onSave,
  saving = false,
  readOnly = false,
  dirty = false,
  label = "Markdown",
}: {
  value: string;
  onChange(value: string): void;
  onSave?(): void;
  saving?: boolean;
  readOnly?: boolean;
  dirty?: boolean;
  label?: string;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<MarkdownMode>("preview");
  const editor = (
    <MarkdownEditor
      value={value}
      onChange={onChange}
      onSave={onSave}
      readOnly={readOnly}
      label={label}
    />
  );
  const preview = (
    <article
      className="h-full min-h-72 overflow-auto p-5"
      aria-label={t("markdown.previewLabel", { label })}
      data-testid="markdown-preview"
    >
      <MessageResponse components={DOCUMENT_COMPONENTS}>{value}</MessageResponse>
    </article>
  );
  const shown: MarkdownMode = readOnly ? "preview" : mode;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="markdown-workspace">
      {readOnly ? null : (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-2">
          <SegmentedControl
            label={label}
            testId="markdown-mode"
            value={mode}
            onValueChange={(next) => {
              if (next === "write" || next === "preview" || next === "split") setMode(next);
            }}
            options={[
              { value: "write", label: t("markdown.write"), testId: "markdown-mode-write" },
              { value: "preview", label: t("markdown.preview"), testId: "markdown-mode-preview" },
              { value: "split", label: t("markdown.split"), testId: "markdown-mode-split" },
            ]}
          />
          {/* Saving is offered while there is something to save, not as a disabled promise. */}
          {onSave && (dirty || saving) ? (
            <Button disabled={saving} onClick={onSave} data-testid="markdown-save">
              {saving ? <Spinner data-icon="inline-start" /> : null}
              {t("common.saveChanges")}
            </Button>
          ) : null}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {shown === "write" ? editor : null}
        {shown === "preview" ? preview : null}
        {shown === "split" ? (
          <div className="grid h-full min-h-0 grid-cols-1 divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0">
            {editor}
            {preview}
          </div>
        ) : null}
      </div>
    </div>
  );
}
