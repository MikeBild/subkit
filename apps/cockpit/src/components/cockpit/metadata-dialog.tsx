import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { TextField } from "@/components/cockpit/form-field";
import { FormDialog } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { useOptimisticAction } from "@/lib/use-optimistic-action";

type RecordValue = Record<string, unknown>;

export function MetadataDialog({
  id,
  title,
  open,
  onOpenChange,
}: {
  id: string;
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
      title={t("workflowPage.renameTitle")}
      description={t("workflowPage.renameHelp")}
      submit={{
        label: t("common.rename"),
        disabled: !name.trim() || name.trim() === title,
        testId: "detail-metadata-save",
      }}
      onSubmit={() => {
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
