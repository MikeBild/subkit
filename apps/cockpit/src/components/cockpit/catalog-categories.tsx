import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { useSession } from "@/app/session";
import { TextField } from "@/components/cockpit/form-field";
import {
  Button,
  DataState,
  FormDialog,
  RecordSheet,
  SegmentedControl,
  SummaryLine,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { humanizeCategory, UNCATEGORIZED } from "@/lib/workflow-category";
import { type CatalogKind, normalizeCategoryInput } from "./catalog-metadata-model";

import { catalogAICount } from "./catalog-origin-model";

interface CategoryUsage {
  category: string;
  total: number;
  counts: Record<CatalogKind, number>;
  llm_counts?: Partial<Record<CatalogKind, number>>;
}

const WRITE_PERMISSIONS = [
  "workflow:write",
  "connector:write",
  "knowledge:write",
  "skill:write",
  "file:write",
];

export function CatalogCategories({ kind }: { kind: CatalogKind }) {
  const { t } = useI18n();
  const { permissions } = useSession();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CategoryUsage | null>(null);
  const [name, setName] = useState("");
  const query = useQuery({
    queryKey: ["catalog-categories"],
    queryFn: () => apiRequest<{ categories: CategoryUsage[] }>("/v1/categories"),
  });
  const canRename = WRITE_PERMISSIONS.every((permission) => permissions.includes(permission));
  const categories = query.data?.categories ?? [];
  const count = categories.filter(
    (category) =>
      category.category !== UNCATEGORIZED &&
      category.category !== "platform" &&
      category.counts[kind] > 0,
  ).length;
  const normalized = normalizeCategoryInput(name);
  const save = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      apiRequest(`/v1/categories/${encodeURIComponent(from)}/rename`, {
        method: "POST",
        body: JSON.stringify({ to }),
      }),
    onSuccess: async () => {
      toast.success(t("catalogCategories.saved"));
      setEditing(null);
      await Promise.all(
        [
          "catalog-categories",
          "catalog",
          "catalog-detail",
          "knowledge-source",
          "skill",
          "file",
        ].map((key) => client.invalidateQueries({ queryKey: [key] })),
      );
    },
    onError: () => toast.error(t("detail.saveFailed")),
  });
  return (
    <>
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0 text-sm"
        onClick={() => setOpen(true)}
        data-testid="catalog-categories-open"
      >
        {query.data
          ? t(count === 1 ? "catalogCategories.summary.one" : "catalogCategories.summary.other", {
              count,
            })
          : t("catalogCategories.title")}
      </Button>
      <RecordSheet
        open={open}
        onOpenChange={setOpen}
        title={t("catalogCategories.title")}
        subtitle={t("catalogCategories.subtitle")}
        testId="catalog-categories-sheet"
      >
        {query.isPending ? (
          <DataState state="loading" />
        ) : query.error ? (
          <DataState
            state="error"
            line={t("detail.loadFailed")}
            onRetry={() => void query.refetch()}
          />
        ) : (
          <ul className="divide-y">
            {categories
              .filter((category) => category.category !== "platform")
              .map((category) => (
                <li
                  key={category.category}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <span className="min-w-0">
                    <span className="block font-medium">
                      {humanizeCategory(category.category, t("catalog.categoryOther"))}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {t("catalogCategories.usage", { count: category.total })}
                    </span>
                  </span>
                  {canRename && category.category !== UNCATEGORIZED ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setName(category.category);
                        setEditing(category);
                      }}
                      data-testid="catalog-category-edit"
                    >
                      {t("catalogCategories.edit")}
                    </Button>
                  ) : null}
                </li>
              ))}
          </ul>
        )}
      </RecordSheet>
      <FormDialog
        open={editing !== null}
        onOpenChange={(value) => {
          if (!value) setEditing(null);
        }}
        title={t("catalogCategories.edit")}
        description={
          editing ? humanizeCategory(editing.category, t("catalog.categoryOther")) : undefined
        }
        submit={{
          label: t("common.save"),
          pending: save.isPending,
          disabled: !normalized || normalized === "platform" || normalized === editing?.category,
        }}
        onSubmit={() => {
          if (editing && normalized && normalized !== "platform" && normalized !== editing.category)
            save.mutate({ from: editing.category, to: normalized });
        }}
        testId="catalog-category-dialog"
      >
        <TextField
          id="catalog-category-name"
          label={t("catalogCategories.name")}
          value={name}
          onChange={setName}
          help={t("catalogCategories.renameHelp")}
          error={
            name.trim() && (!normalized || normalized === "platform")
              ? t("catalogMeta.invalidCategory")
              : null
          }
        />
      </FormDialog>
    </>
  );
}

export function useCatalogOrigin() {
  const [value, setValue] = useState("all");
  return {
    value,
    setValue,
    active: value === "llm",
    descriptionSource: value === "llm" ? "llm" : undefined,
  };
}

export function CatalogOriginSummary({
  kind,
  origin,
  text,
  help,
  testId,
}: {
  kind: CatalogKind;
  origin: ReturnType<typeof useCatalogOrigin>;
  text: ReactNode;
  help?: string;
  testId?: string;
}) {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ["catalog-categories"],
    queryFn: () => apiRequest<{ categories: CategoryUsage[] }>("/v1/categories"),
  });
  const count = query.error ? null : catalogAICount(query.data?.categories, kind);
  return (
    <SummaryLine
      text={
        <>
          {text} · <CatalogCategories kind={kind} />
          {count === null ? null : <> · {t("catalog.aiCount", { count })}</>}
        </>
      }
      help={help}
      testId={testId}
      aside={
        <SegmentedControl
          label={t("catalog.originAI")}
          value={origin.value}
          onValueChange={origin.setValue}
          options={[
            { value: "all", label: t("catalog.originAll") },
            { value: "llm", label: t("catalog.originAI") },
          ]}
          testId="catalog-origin"
        />
      }
    />
  );
}
