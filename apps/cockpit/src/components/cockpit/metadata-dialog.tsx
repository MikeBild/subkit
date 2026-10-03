import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { TextField } from "@/components/cockpit/form-field";
import { FormDialog } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { useOptimisticAction } from "@/lib/use-optimistic-action";

type RecordValue = Record<string, unknown>;

/**
 * "Umbenennen" on a workflow's page: the dialog is headed by the record it
 * renames. The new name stands on the page at once and goes back if the
 * engine refuses it.
 */
export function MetadataDialog({
  id,
  title,
  open,
  onOpenChange,
}: {
  id: string;
  /** The record's current name. */
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(title);
  useEffect(() => {
    if (open) setName(title);
  }, [open, title]);
  const rename = useOptimisticAction({
    queryKey: ["catalog-detail", "workflows", id],
    mutationFn: (next: string) =>
      apiRequest<RecordValue>(`/v1/workflows/${encodeURIComponent(id)}/metadata`, {
        method: "PATCH",
        body: JSON.stringify({ name: next }),
      }),
    apply: (current: RecordValue | undefined, next) =>
      current ? { ...current, name: next } : current,
    errorMessage: () => t("detail.saveFailed"),
    onSuccess: () => toast.success(t("detail.saved")),
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={t("detail.editMetadataDescription")}
      submit={{
        label: t("common.saveChanges"),
        disabled: !name.trim() || name.trim() === title,
        testId: "detail-metadata-save",
      }}
      onSubmit={() => {
        // The name changes on the page now; a refusal puts it back.
        rename.mutate(name.trim());
        onOpenChange(false);
      }}
      cancelTestId="detail-metadata-cancel"
      testId="detail-metadata-dialog"
    >
      <TextField
        id="detail-metadata-name"
        label={t("common.name")}
        value={name}
        onChange={setName}
      />
    </FormDialog>
  );
}
