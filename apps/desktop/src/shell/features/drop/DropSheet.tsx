import type { DropChoice } from "@shared/drop-choice.ts";
import { fileKindOf, formatBytes } from "@shared/file-kinds.ts";
import { IconTile } from "@ui/atoms/icon-tile";
import { FILE_ICON } from "@ui/lib/files";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@ui/organisms/dialog";
import { BookOpen, FileText, Inbox, type LucideIcon, MessageSquare } from "lucide-react";
import { choiceBlocker, type DropBlocker } from "../../../shared/drop-model.ts";
import { useI18n, useShell } from "../../adapter/use-shell.tsx";
import { dropLead, type Translate } from "../../lib/text.ts";

const CHOICES: [DropChoice, LucideIcon][] = [
  ["file", FileText],
  ["source", BookOpen],
  ["chat", MessageSquare],
  ["inbox", Inbox],
];

function reason(t: Translate, blocker: DropBlocker, lang: "de" | "en"): string {
  if (blocker.reason === "tooLarge")
    return t("drop.reason.tooLarge", { max: formatBytes(blocker.max, lang) });
  if (blocker.reason === "tooMany") return t("drop.reason.tooMany", { max: blocker.max });
  return t(`drop.reason.${blocker.reason}`);
}

export function DropSheet() {
  const { s, a } = useShell();
  const { t, lang } = useI18n();
  const sheet = s.ui.dropSheet;
  const placing = sheet?.phase === "placing";
  return (
    <Dialog
      open={!!sheet}
      onOpenChange={(o) => {
        if (!o) a.closeDrop();
      }}
    >
      <DialogContent className="max-w-[480px]" closeLabel={t("common.close")}>
        <DialogHeader>
          <DialogTitle className="font-heading">{t("drop.title")}</DialogTitle>
          <DialogDescription>
            {sheet ? `${dropLead(t, sheet.files.length)} ${t(`drop.via.${sheet.via}`)}` : ""}
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-40 space-y-2 overflow-auto">
          {sheet?.files.map((f) => (
            <li key={f.name} className="flex items-center gap-3 rounded-lg border px-3 py-2">
              <IconTile icon={FILE_ICON[fileKindOf(f.name)]} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{f.name}</span>
              <span className="text-xs text-muted-foreground">{formatBytes(f.size, lang)}</span>
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
                data-testid={`drop-choice-${c}`}
                disabled={blocker !== null || placing}
                aria-busy={placing && sheet?.choice === c}
                onClick={() => a.placeDrop(c)}
                className="flex items-start gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
              >
                <IconTile icon={Icon} size="md" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{t(`drop.choice.${c}`)}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {blocker ? reason(t, blocker, lang) : t(`drop.choice.${c}.hint`)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {sheet?.phase === "failed" && (
          <p role="alert" className="text-sm text-destructive-ink">
            {t("drop.failed")}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
