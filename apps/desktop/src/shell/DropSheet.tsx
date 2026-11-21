import { IconTile } from "@ui/components/proto/visual";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@ui/components/ui/dialog";
import { FILE_ICON, fileKindOf, fileSize } from "@ui/lib/files";
import { BookOpen, FileText, Inbox, type LucideIcon, MessageSquare } from "lucide-react";
import { choiceBlocker, type DropBlocker, type DropChoice } from "../shared/drop-model.ts";
import type { ShellDict } from "./shell-dict.ts";
import { useI18n, useShell } from "./use-shell.tsx";

const CHOICES: [DropChoice, LucideIcon][] = [
  ["file", FileText],
  ["source", BookOpen],
  ["chat", MessageSquare],
  ["inbox", Inbox],
];

function reason(d: ShellDict["md"]["drop"], blocker: DropBlocker, lang: "de" | "en"): string {
  if (blocker.reason === "tooLarge") return d.reasons.tooLarge(fileSize(blocker.max, lang));
  if (blocker.reason === "tooMany") return d.reasons.tooMany(blocker.max);
  return d.reasons[blocker.reason];
}

export function DropSheet() {
  const { s, a } = useShell();
  const { t, lang } = useI18n();
  const d = t.md.drop;
  const sheet = s.ui.dropSheet;
  const placing = sheet?.phase === "placing";
  return (
    <Dialog
      open={!!sheet}
      onOpenChange={(o) => {
        if (!o) a.closeDrop();
      }}
    >
      <DialogContent className="max-w-[480px]" closeLabel={t.common.close}>
        <DialogHeader>
          <DialogTitle className="font-heading">{d.title}</DialogTitle>
          <DialogDescription>
            {sheet ? `${d.lead(sheet.files.length)} ${d.via[sheet.via]}` : ""}
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-40 space-y-2 overflow-auto">
          {sheet?.files.map((f) => (
            <li key={f.name} className="flex items-center gap-3 rounded-lg border px-3 py-2">
              <IconTile icon={FILE_ICON[fileKindOf(f.name)]} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{f.name}</span>
              <span className="text-xs text-muted-foreground">{fileSize(f.size, lang)}</span>
            </li>
          ))}
        </ul>
        <div className="grid gap-2 sm:grid-cols-2">
          {CHOICES.map(([c, Icon]) => {
            const blocker = sheet ? choiceBlocker(c, sheet.files, s.online) : null;
            return (
              <button
                key={c}
                type="button"
                disabled={blocker !== null || placing}
                aria-busy={placing && sheet?.choice === c}
                onClick={() => a.placeDrop(c)}
                className="flex items-start gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
              >
                <IconTile icon={Icon} size="md" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{d.choices[c][0]}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {blocker ? reason(d, blocker, lang) : d.choices[c][1]}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {sheet?.phase === "failed" && (
          <p role="alert" className="text-sm text-destructive-ink">
            {d.failed}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
