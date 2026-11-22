import { FieldError } from "@ui/molecules/error-notice";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/organisms/dialog";
import { useState } from "react";
import { Button, Input, Label } from "@/components/cockpit/patterns/controls";
import { addressPatchBody } from "@/features/knowledge/api/knowledge-source-request";
import { isSourceUrl, type Rhythm } from "@/features/knowledge/model/add-source-model";
import { refreshRhythm } from "@/features/knowledge/model/knowledge-sources-model";
import { useI18n } from "@/lib/i18n-context";
import type { KnowledgeSource } from "../hooks/use-source";
import { useSaveSourceAddress } from "../hooks/use-source-edits";
import { RhythmChips } from "./rhythm-chips";

export function AddressDialog({
  open,
  onOpenChange,
  src,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  src: KnowledgeSource;
  onSaved: (s: KnowledgeSource) => void;
}) {
  const { t } = useI18n();
  const saved = refreshRhythm(src.refresh_strategy, src.refresh_cron);
  const [url, setUrl] = useState(src.source_uri);
  const [rhythm, setRhythm] = useState<Rhythm | null>(saved === "custom" ? null : saved);
  const save = useSaveSourceAddress(src, (n) => {
    onSaved(n);
    onOpenChange(false);
  });
  const ok = isSourceUrl(url);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("kn.sources.addressSchedule")}</DialogTitle>
          <DialogDescription>{t("kn.sources.hint.url")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok)
              save.mutate(
                addressPatchBody({ url: src.source_uri, rhythm: saved }, { url, rhythm }),
              );
          }}
        >
          <div>
            <Label htmlFor="src-url-edit">{t("kn.sources.address")}</Label>
            <Input
              data-testid="src-url-edit"
              id="src-url-edit"
              className="mt-2 font-mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            {!ok && <FieldError>{t("kn.sources.errUrl")}</FieldError>}
          </div>
          <RhythmChips value={rhythm} onChange={setRhythm} />
          {rhythm === null && src.refresh_cron && (
            <p className="text-sm text-muted-foreground" data-testid="kn-sources-custom-cron">
              {t("kn.sources.customRhythm")} <span className="font-mono">{src.refresh_cron}</span>
            </p>
          )}
          <DialogFooter>
            <Button
              data-testid="common-cancel-2"
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button data-testid="kn-save" type="submit" disabled={!ok || save.isPending}>
              {t("kn.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
