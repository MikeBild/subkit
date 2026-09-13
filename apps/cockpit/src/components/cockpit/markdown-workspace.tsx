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
import { Eye, PanelLeft, Save, SquarePen } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/lib/i18n-context";

type MarkdownMode = "write" | "preview" | "split";

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
  const [mode, setMode] = useState<MarkdownMode>(readOnly ? "preview" : "split");
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
      <MessageResponse>{value}</MessageResponse>
    </article>
  );

  return (
    <Tabs
      value={mode}
      onValueChange={(next) => setMode(next as MarkdownMode)}
      className="flex min-h-0 flex-1 flex-col"
      data-testid="markdown-workspace"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-2">
        <TabsList>
          {!readOnly && (
            <TabsTrigger value="write" data-testid="markdown-mode-write">
              <SquarePen data-icon="inline-start" />
              {t("markdown.write")}
            </TabsTrigger>
          )}
          <TabsTrigger value="preview" data-testid="markdown-mode-preview">
            <Eye data-icon="inline-start" />
            {t("markdown.preview")}
          </TabsTrigger>
          {!readOnly && (
            <TabsTrigger value="split" data-testid="markdown-mode-split">
              <PanelLeft data-icon="inline-start" />
              {t("markdown.split")}
            </TabsTrigger>
          )}
        </TabsList>
        {!readOnly && onSave && (
          <Button
            size="sm"
            disabled={!dirty || saving}
            onClick={onSave}
            data-testid="markdown-save"
          >
            {saving ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
            {t("common.saveChanges")}
          </Button>
        )}
      </div>
      {!readOnly && (
        <TabsContent value="write" className="min-h-0 flex-1">
          {editor}
        </TabsContent>
      )}
      <TabsContent value="preview" className="min-h-0 flex-1">
        {preview}
      </TabsContent>
      {!readOnly && (
        <TabsContent value="split" className="min-h-0 flex-1">
          <div className="grid h-full min-h-0 grid-cols-1 divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0">
            {editor}
            {preview}
          </div>
        </TabsContent>
      )}
    </Tabs>
  );
}
