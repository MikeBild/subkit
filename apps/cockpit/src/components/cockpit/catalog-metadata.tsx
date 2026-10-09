import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { SelectField, TextAreaField, TextField } from "@/components/cockpit/form-field";
import {
  type ActionMenuItem,
  Button,
  type FilterSelect,
  FormDialog,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { humanizeCategory, UNCATEGORIZED } from "@/lib/workflow-category";
import {
  type CatalogKind,
  type CatalogMetadataRecord,
  categoryChoices,
  metadataEndpoint,
  metadataPatch,
  normalizeCategoryInput,
  recordCategory,
  recordDescription,
  writtenByAssistant,
} from "./catalog-metadata-model";

const NEW_CATEGORY = "__new__";
const KIND_LABELS = {
  workflow: "inbox.resource.workflow",
  connector: "inbox.resource.connector",
  knowledge_source: "inbox.resource.knowledgeSource",
  skill: "inbox.resource.skill",
  file: "inbox.resource.file",
} as const;

export function useCatalogMetadataActions({
  kind,
  id,
  record,
  queryKey,
  onEdit,
}: {
  kind: CatalogKind;
  id: string;
  record: CatalogMetadataRecord | undefined;
  queryKey: readonly unknown[];
  onEdit(): void;
}): ActionMenuItem[] {
  const { t } = useI18n();
  const client = useQueryClient();
  const accept = useMutation({
    mutationFn: (description: string) =>
      apiRequest(metadataEndpoint(kind, id), {
        method: "PATCH",
        body: JSON.stringify({ description, accept_description: true }),
      }),
    onSuccess: async () => {
      toast.success(t("catalogMeta.saved"));
      await Promise.all([
        client.invalidateQueries({ queryKey: [...queryKey] }),
        client.invalidateQueries({ queryKey: ["catalog"] }),
        client.invalidateQueries({ queryKey: ["catalog-categories"] }),
      ]);
    },
    onError: () => toast.error(t("detail.saveFailed")),
  });
  return [
    { label: t("catalogMeta.dialogTitle"), onSelect: onEdit, testId: "catalog-metadata-edit" },
    ...(writtenByAssistant(record)
      ? [
          {
            label: t("catalogMeta.accept"),
            onSelect: () => accept.mutate(recordDescription(record)),
            disabled: accept.isPending,
            testId: "catalog-metadata-accept",
          },
        ]
      : []),
  ];
}

export function CatalogMetadataSummary({
  record,
  onEdit,
}: {
  record: CatalogMetadataRecord | undefined;
  onEdit?: () => void;
}) {
  const { t } = useI18n();
  const description = recordDescription(record).trim();
  const category = recordCategory(record);
  return (
    <span
      className="inline-flex flex-wrap items-center gap-x-2 gap-y-1"
      data-testid="catalog-metadata"
    >
      {category !== UNCATEGORIZED ? (
        <span
          className="rounded-full border px-2 py-0.5 text-xs font-medium text-foreground"
          data-testid="catalog-metadata-chip"
        >
          {humanizeCategory(category, t("catalog.categoryOther"))}
        </span>
      ) : null}
      <span data-testid="catalog-metadata-description">
        {description || t("catalogMeta.empty")}
      </span>
      {writtenByAssistant(record) ? (
        <span
          className="inline-flex items-center gap-1 text-xs"
          data-testid="catalog-metadata-by-assistant"
        >
          <Sparkles aria-hidden="true" className="size-3" />
          {t("catalogMeta.byAssistant")}
        </span>
      ) : null}
      {onEdit ? (
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={onEdit}
          data-testid="catalog-metadata-edit"
        >
          {t("catalogMeta.edit")}
        </Button>
      ) : null}
    </span>
  );
}

export function CatalogMetadataDialog({
  kind,
  id,
  record,
  open,
  onOpenChange,
  queryKey,
}: {
  kind: CatalogKind;
  id: string;
  record: CatalogMetadataRecord | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queryKey: readonly unknown[];
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [description, setDescription] = useState("");
  const [choice, setChoice] = useState(UNCATEGORIZED);
  const [fresh, setFresh] = useState("");
  useEffect(() => {
    if (!open) return;
    setDescription(recordDescription(record));
    setChoice(recordCategory(record));
    setFresh("");
  }, [open, record]);
  const vocabulary = useQuery({
    queryKey: ["catalog-categories"],
    enabled: open,
    queryFn: () => apiRequest<{ categories?: { category: string }[] }>("/v1/categories"),
  });
  const choices = categoryChoices(
    (vocabulary.data?.categories ?? []).map((entry) => entry.category),
    recordCategory(record),
  );
  const freshCategory = choice === NEW_CATEGORY ? normalizeCategoryInput(fresh) : null;
  const category = choice === NEW_CATEGORY ? (freshCategory ?? "") : choice;
  const patch = category ? metadataPatch(record, { description, category }) : null;
  const save = useMutation({
    mutationFn: (body: Record<string, string>) =>
      apiRequest(metadataEndpoint(kind, id), { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: async () => {
      toast.success(t("catalogMeta.saved"));
      onOpenChange(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: [...queryKey] }),
        client.invalidateQueries({ queryKey: ["catalog"] }),
        client.invalidateQueries({ queryKey: ["catalog-categories"] }),
      ]);
    },
    onError: () => toast.error(t("detail.saveFailed")),
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("catalogMeta.dialogTitle")}
      description={[
        t(KIND_LABELS[kind]),
        typeof record?.name === "string"
          ? record.name
          : typeof record?.filename === "string"
            ? record.filename
            : typeof record?.title === "string"
              ? record.title
              : typeof record?.display_name === "string"
                ? record.display_name
                : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      submit={{
        label: t("common.save"),
        pending: save.isPending,
        disabled: !patch,
        testId: "catalog-metadata-save",
      }}
      onSubmit={() => {
        if (patch) save.mutate(patch);
      }}
      cancelTestId="catalog-metadata-cancel"
      testId="catalog-metadata-dialog"
    >
      {writtenByAssistant(record) ? (
        <p className="text-sm text-muted-foreground" data-testid="catalog-metadata-assistant-hint">
          {t("catalogMeta.assistantHint")}
        </p>
      ) : null}
      <TextAreaField
        id="catalog-metadata-description-input"
        label={t("catalogMeta.description")}
        value={description}
        onChange={setDescription}
        rows={5}
        help={t("catalogMeta.descriptionHelp")}
        placeholder={t("catalogMeta.empty")}
      />
      <SelectField
        id="catalog-metadata-category-input"
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
          id="catalog-metadata-new-category"
          label={t("catalogMeta.newCategoryName")}
          value={fresh}
          onChange={setFresh}
          error={fresh.trim() && !freshCategory ? t("catalogMeta.invalidCategory") : null}
        />
      ) : null}
    </FormDialog>
  );
}

export function CatalogNameCell({
  name,
  record,
}: {
  name: string;
  record: CatalogMetadataRecord | undefined;
}) {
  const { t } = useI18n();
  const category = recordCategory(record);
  const description = recordDescription(record).trim();
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate font-medium">{name}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {category !== UNCATEGORIZED ? (
          <span className="shrink-0 rounded-full border px-1.5 leading-4">
            {humanizeCategory(category, t("catalog.categoryOther"))}
          </span>
        ) : null}
        <span className="truncate">{description || t("catalogMeta.empty")}</span>
      </span>
    </span>
  );
}

export function useCategoryFilter(kind: CatalogKind): {
  category: string | undefined;
  select: FilterSelect | null;
} {
  const { t } = useI18n();
  const [value, setValue] = useState("all");
  const vocabulary = useQuery({
    queryKey: ["catalog-categories"],
    queryFn: () =>
      apiRequest<{ categories?: { category: string; counts?: Record<string, number> }[] }>(
        "/v1/categories",
      ),
  });
  const options = (vocabulary.data?.categories ?? [])
    .map((entry) => ({ category: entry.category, count: entry.counts?.[kind] ?? 0 }))
    .filter((entry) => entry.count > 0);
  if (options.length === 0) return { category: undefined, select: null };
  return {
    category: value === "all" ? undefined : value,
    select: {
      value,
      onChange: setValue,
      label: t("catalog.block"),
      testId: "catalog-category-filter",
      options: [
        { value: "all", label: t("catalog.allCategories") },
        ...options.map((entry) => ({
          value: entry.category,
          label: `${humanizeCategory(entry.category, t("catalog.categoryOther"))} (${entry.count})`,
        })),
      ],
    },
  };
}
