import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { SelectField, TextAreaField, TextField } from "@/components/cockpit/form-field";
import {
  type ActionMenuItem,
  Chip,
  type FilterSelect,
  FormDialog,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { useSearchParamState } from "@/lib/use-search-param-state";
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
  label,
}: {
  kind: CatalogKind;
  id: string;
  record: CatalogMetadataRecord | undefined;
  queryKey: readonly unknown[];
  onEdit(): void;
  label?: string;
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
    {
      label: label ?? t("catalogMeta.dialogTitle"),
      onSelect: onEdit,
      testId: "catalog-metadata-edit",
    },
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

export function CatalogCategoryChip({
  category,
  testId = "catalog-category-chip",
}: {
  category: string | null | undefined;
  testId?: string;
}) {
  const { t } = useI18n();
  if (!category || category === UNCATEGORIZED) return null;
  return (
    <Chip data-slot="category-chip" testId={testId}>
      {humanizeCategory(category, t("catalog.categoryOther"))}
    </Chip>
  );
}

export function CatalogPurpose({
  record,
  fallback,
}: {
  record: CatalogMetadataRecord | undefined;
  fallback?: string;
}) {
  const { t } = useI18n();
  const description = recordDescription(record).trim();
  return (
    <span data-testid="catalog-purpose">
      <span data-testid="catalog-metadata-description">
        {description || fallback || t("catalogMeta.empty")}
      </span>
      {writtenByAssistant(record) ? (
        <span
          className="ml-1.5 inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground"
          data-testid="catalog-metadata-by-assistant"
        >
          <Bot aria-hidden="true" className="size-3" />
          {t("catalogMeta.byAssistant")}
        </span>
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
  nameKey,
  title,
}: {
  kind: CatalogKind;
  id: string;
  record: CatalogMetadataRecord | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queryKey: readonly unknown[];
  nameKey?: "name" | "filename" | "title";
  title?: string;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const rawName = nameKey ? record?.[nameKey] : undefined;
  const currentName = typeof rawName === "string" ? rawName : "";
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [choice, setChoice] = useState(UNCATEGORIZED);
  const [fresh, setFresh] = useState("");
  useEffect(() => {
    if (!open) return;
    setName(currentName);
    setDescription(recordDescription(record));
    setChoice(recordCategory(record));
    setFresh("");
  }, [open, record, currentName]);
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
  const renamed = nameKey && name.trim() && name.trim() !== currentName ? name.trim() : null;
  const metadata = category ? metadataPatch(record, { description, category }) : null;
  const patch =
    nameKey && !name.trim()
      ? null
      : renamed && nameKey
        ? { ...(metadata ?? {}), [nameKey]: renamed }
        : metadata;
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
      title={title ?? t("catalogMeta.dialogTitle")}
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
      {nameKey ? (
        <TextField
          id="catalog-metadata-name-input"
          label={t("common.name")}
          value={name}
          onChange={setName}
        />
      ) : null}
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
  icon,
}: {
  name: string;
  record: CatalogMetadataRecord | undefined;
  icon?: ReactNode;
}) {
  const text = <CatalogNameText name={name} record={record} />;
  if (!icon) return text;
  return (
    <span className="flex min-w-0 items-start gap-3">
      <span className="mt-0.5 flex shrink-0" data-slot="catalog-name-icon">
        {icon}
      </span>
      {text}
    </span>
  );
}

function CatalogNameText({
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
          <Chip className="py-0 leading-4">
            {humanizeCategory(category, t("catalog.categoryOther"))}
          </Chip>
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
  const [value, setValue] = useSearchParamState("category", "all");
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
