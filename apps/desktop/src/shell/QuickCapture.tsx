import { SubKitMark } from "@ui/components/proto/visual";
import { Button } from "@ui/components/ui/button";
import { Inbox, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { canSend } from "../shared/quick-capture-model.ts";
import { useI18n, useShell } from "./use-shell.tsx";

export function QuickCapture() {
  const { s, a } = useShell();
  const { t } = useI18n();
  const q = t.md.quick;
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (s.ui.quick) {
      setText("");
      requestAnimationFrame(() => ref.current?.focus());
    }
  }, [s.ui.quick]);
  if (!s.ui.quick) return null;
  const close = () => a.setUi({ quick: false });
  const ready = canSend(text, s.capture.phase, s.online);
  const send = () => {
    if (ready) a.quickNote(text);
  };
  return (
    <div className="fixed inset-x-0 top-24 z-50 flex justify-center px-4">
      <section
        role="dialog"
        aria-modal="false"
        aria-label={q.title}
        className="w-full max-w-[560px] rounded-xl border bg-background shadow-window"
      >
        <header className="flex h-10 items-center gap-2 border-b px-4">
          <SubKitMark size="xs" />
          <h2 className="font-heading text-sm font-semibold">{q.title}</h2>
          <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">{q.hint}</span>
          <Button
            size="icon"
            variant="ghost"
            className="-mr-2 ml-auto size-8"
            aria-label={t.common.close}
            onClick={close}
          >
            <X className="size-4" aria-hidden />
          </Button>
        </header>
        <div className="p-4">
          <label htmlFor="quick-note" className="sr-only">
            {q.label}
          </label>
          <textarea
            id="quick-note"
            ref={ref}
            rows={3}
            value={text}
            placeholder={q.ph}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
            className="block w-full resize-none bg-transparent text-base leading-6 outline-none placeholder:text-muted-foreground"
          />
        </div>
        <footer className="flex items-center justify-between gap-4 border-t px-4 py-2">
          {s.capture.phase === "failed" ? (
            <span role="alert" className="text-xs text-destructive-ink">
              {q.failed}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{s.online ? q.keys : q.offline}</span>
          )}
          <Button
            size="sm"
            disabled={!ready}
            aria-busy={s.capture.phase === "sending"}
            onClick={send}
          >
            <Inbox className="size-4" aria-hidden />
            {q.send}
          </Button>
        </footer>
      </section>
    </div>
  );
}
