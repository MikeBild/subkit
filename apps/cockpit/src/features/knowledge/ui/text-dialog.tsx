import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/organisms/dialog";
import { dialogWidthClass } from "@ui/organisms/dialog-frame";
import { MarkdownEditor } from "@ui/organisms/markdown-editor";
import { useState } from "react";
import { Button, Input, Label } from "@/components/cockpit/patterns/controls";
import { contentSaveBody } from "@/features/knowledge/api/knowledge-source-request";
import { useI18n } from "@/lib/i18n-context";
import { type KnowledgeSource, useSourceContent } from "../hooks/use-source";
import { useSaveSourceText } from "../hooks/use-source-edits";
import { useMarkdownRefs } from "../queries";
import { ListSkeleton } from "../shell";

export function TextDialog({
  open,
  onOpenChange,
  src,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  src: KnowledgeSource;
}) {
  const { t } = useI18n();
  const refs = useMarkdownRefs();
  const content = useSourceContent(src.id, open);
  const doc =
    content.data?.editable && content.data.documents.length === 1
      ? content.data.documents[0]
      : undefined;
  const [body, setBody] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const value = body ?? doc?.content ?? "";
  const close = () => {
    setBody(null);
    setNote("");
    onOpenChange(false);
  };
  const save = useSaveSourceText(src, close);
  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent className={dialogWidthClass("document")}>
        <DialogHeader>
          <DialogTitle>{t("kn.sources.editText")}</DialogTitle>
          <DialogDescription>{src.name}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(
              doc && content.data
                ? contentSaveBody({
                    version: content.data.version,
                    path: doc.path,
                    content: value,
                    note,
                  })
                : null,
            );
          }}
        >
          {doc ? (
            <MarkdownEditor id="src-body" value={value} onChange={setBody} refs={refs} />
          ) : (
            <ListSkeleton />
          )}
          <div>
            <Label htmlFor="src-note">{t("kn.sources.why")}</Label>
            <Input
              data-testid="src-note"
              id="src-note"
              className="mt-2"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button data-testid="common-cancel-3" type="button" variant="ghost" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button data-testid="kn-save-2" type="submit" disabled={!doc || save.isPending}>
              {t("kn.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
