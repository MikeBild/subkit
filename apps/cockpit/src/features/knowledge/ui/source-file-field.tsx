import { formatBytes } from "@shared/file-kinds.ts";
import { IconTile } from "@ui/atoms/icon-tile";
import { DropZone } from "@ui/molecules/drop-zone";
import { FieldError } from "@ui/molecules/error-notice";
import { File } from "lucide-react";
import { Button } from "@/components/cockpit/patterns/controls";
import { SOURCE_ACCEPT } from "@/features/knowledge/model/add-source-model";
import { useI18n } from "@/lib/i18n-context";
import type { PickedFile } from "../hooks/use-source-file";
import { FilePreview } from "./file-preview";

export function SourceFileField({
  file,
  error,
  tried,
  onPick,
  onClear,
}: {
  file: PickedFile | null;
  error: string;
  tried: boolean;
  onPick: (files: FileList | readonly File[]) => void;
  onClear: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <>
      {!file ? (
        <DropZone
          title={t("kn.sources.dropFile")}
          hint={`${t("kn.sources.orPick")} · ${SOURCE_ACCEPT.join(" ")}`}
          accept={SOURCE_ACCEPT.join(",")}
          onFiles={onPick}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3 rounded-lg border p-3">
            <IconTile icon={File} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{file.file.name}</p>
              <p className="text-xs text-muted-foreground">{formatBytes(file.file.size, locale)}</p>
            </div>
            <Button
              data-testid="kn-sources-other"
              type="button"
              size="sm"
              variant="ghost"
              onClick={onClear}
            >
              {t("kn.sources.other")}
            </Button>
          </div>
          <div className="rounded-lg border p-4">
            <FilePreview name={file.file.name} text={file.text} />
          </div>
        </div>
      )}
      {error && <FieldError>{error}</FieldError>}
      {tried && !file && !error && <FieldError>{t("kn.sources.dropFile")}</FieldError>}
    </>
  );
}
