import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { SelectField, TextField } from "@/components/cockpit/form-field";
import { FormDialog, MarkdownEditor } from "@/components/cockpit/patterns";
import { humanizeCategory } from "@/features/workflows/model";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import {
  type CatalogMetadataRecord,
  categoryChoices,
  type MetadataPatch,
  metadataPatch,
  normalizeCategoryInput,
  recordCategory,
  recordDescription,
} from "../model/catalog-metadata-model";

const NEW_CATEGORY = "__new__";

export function workflowEditPatch(
  record: CatalogMetadataRecord | undefined,
  draft: { name: string; description: string; category: string },
): (MetadataPatch & { name?: string }) | null {
  const name = draft.name.trim();
  if (!name) return null;
  const patch: MetadataPatch & { name?: string } = {
    ...(metadataPatch(record, { description: draft.description, category: draft.category }) ?? {}),
  };
  if (name !== (typeof record?.name === "string" ? record.name : "")) patch.name = name;
  return Object.keys(patch).length > 0 ? patch : null;
}

export function MetadataDialog({
  id,
  record,
  open,
  onOpenChange,
}: {
  id: string;
  record: CatalogMetadataRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [choice, setChoice] = useState(recordCategory(record));
  const [fresh, setFresh] = useState("");
  useEffect(() => {
    if (!open) return;
    setName(typeof record.name === "string" ? record.name : "");
    setDescription(recordDescription(record));
    setChoice(recordCategory(record));
    setFresh("");
  }, [open, record]);
  const vocabulary = useQuery({
    queryKey: ["catalog-categories"],
    enabled: open,
    queryFn: () => apiCall("get", "/v1/categories", {}),
  });
  const choices = categoryChoices(
    (vocabulary.data?.categories ?? []).map((entry) => entry.category),
    recordCategory(record),
  );
  const freshCategory = choice === NEW_CATEGORY ? normalizeCategoryInput(fresh) : null;
  const category = choice === NEW_CATEGORY ? (freshCategory ?? "") : choice;
  const patch = category ? workflowEditPatch(record, { name, description, category }) : null;
  const save = useMutation({
    mutationFn: (body: MetadataPatch & { name?: string }) =>
      apiCall("patch", "/v1/workflows/{id}/metadata", { path: { id }, body }),
    onSuccess: async () => {
      toast.success(t("detail.saved"));
      onOpenChange(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["catalog-detail", "workflows", id] }),
        client.invalidateQueries({ queryKey: ["catalog"] }),
        client.invalidateQueries({ queryKey: ["catalog-categories"] }),
      ]);
    },
    onError: (failure) => reportFailure(t("detail.saveFailed"), failure),
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("workflowPage.editTitle")}
      description={t("workflowPage.renameHelp")}
      size="wide"
      submit={{
        label: t("common.save"),
        pending: save.isPending,
        disabled: !patch,
        testId: "detail-metadata-save",
      }}
      onSubmit={() => {
        if (patch) save.mutate(patch);
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
      <MarkdownEditor
        id="detail-metadata-description"
        label={t("catalogMeta.description")}
        value={description}
        onChange={setDescription}
        placeholder={t("catalogMeta.empty")}
        rows={4}
        testId="detail-metadata-description"
      />
      <SelectField
        id="detail-metadata-category"
        label={t("catalogMeta.category")}
        value={choice}
        onChange={setChoice}
        help={t("catalogMeta.categoryHelp")}
        options={[
          ...choices.map((value) => ({
            value,
            label: humanizeCategory(value, t("catalog.categoryOther")),
          })),
          { value: NEW_CATEGORY, label: t("catalogMeta.newCategory") },
        ]}
      />
      {choice === NEW_CATEGORY ? (
        <TextField
          id="detail-metadata-new-category"
          label={t("catalogMeta.newCategoryName")}
          value={fresh}
          onChange={setFresh}
          error={fresh.trim() && !freshCategory ? t("catalogMeta.invalidCategory") : null}
        />
      ) : null}
    </FormDialog>
  );
}
