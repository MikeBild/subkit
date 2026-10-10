import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { useSession } from "@/app/session";
import { TextAreaField, TextField } from "@/components/cockpit/form-field";
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
import {
  type CategoryUsage,
  categoryAliases,
  categoryEditPayload,
  categoryMatches,
} from "./catalog-categories-model";
import { type CatalogKind, normalizeCategoryInput } from "./catalog-metadata-model";
import { catalogAICount } from "./catalog-origin-model";

type CatalogCategoryKind = CatalogKind | "intake";

const WRITE_PERMISSIONS = [
  "workflow:write",
  "connector:write",
  "knowledge:write",
  "skill:write",
  "file:write",
];

export function CatalogCategories({ kind }: { kind: CatalogCategoryKind }) {
  const { t } = useI18n();
  const { permissions } = useSession();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CategoryUsage | null>(null);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [aliases, setAliases] = useState("");
  const [search, setSearch] = useState("");
  const [targets, setTargets] = useState<CategoryUsage[]>([]);
  const [conflict, setConflict] = useState(false);
  const query = useQuery({
    queryKey: ["catalog-categories"],
    queryFn: () => apiRequest<{ categories: CategoryUsage[] }>("/v1/categories"),
  });
  const canRename =
    WRITE_PERMISSIONS.every((permission) => permissions.includes(permission)) &&
    (kind !== "intake" || permissions.includes("intake:write"));
  const categories = query.data?.categories ?? [];
  const count = categories.filter(
    (category) =>
      category.category !== UNCATEGORIZED &&
      category.category !== "platform" &&
      (category.counts[kind] ?? 0) > 0,
  ).length;
  const normalized = normalizeCategoryInput(name);
  const purposeInvalid = purpose.trim().length > 2000;
  const aliasValues = categoryAliases(aliases);
  const aliasesInvalid = aliasValues.length > 32 || aliasValues.some((alias) => alias.length > 80);
  const target = targets.find(
    (category) => category.category === normalized && category.category !== editing?.category,
  );
  const beginEdit = (category: CategoryUsage, available = categories) => {
    setName(category.category);
    setPurpose(category.purpose ?? "");
    setAliases((category.aliases ?? []).join(", "));
    setTargets(available);
    setConflict(false);
    setEditing(category);
  };
  const save = useMutation({
    mutationFn: ({ from, body }: { from: string; body: ReturnType<typeof categoryEditPayload> }) =>
      apiRequest<{ purpose_generation: "pending" | "not_requested" }>(
        `/v1/categories/${encodeURIComponent(from)}/rename`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),
    onSuccess: async (result) => {
      toast.success(
        t(
          result.purpose_generation === "pending"
            ? "catalogCategories.generationPending"
            : "catalogCategories.saved",
        ),
      );
      setEditing(null);
      await Promise.all(
        [
          "catalog-categories",
          "catalog",
          "catalog-detail",
          "knowledge-source",
          "skill",
          "file",
          "intake",
        ].map((key) => client.invalidateQueries({ queryKey: [key] })),
      );
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
        toast.error(t("catalogCategories.conflict"));
      } else toast.error(t("detail.saveFailed"));
    },
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
          <div className="flex min-w-0 flex-col gap-3">
            <TextField
              id="catalog-categories-search"
              label={t("catalogCategories.search")}
              value={search}
              onChange={setSearch}
            />
            <ul className="divide-y">
              {categories
                .filter(
                  (category) =>
                    category.category !== "platform" && categoryMatches(category, search),
                )
                .map((category) => (
                  <li
                    key={category.category}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium">
                        {humanizeCategory(category.category, t("catalog.categoryOther"))}
                      </span>
                      {category.purpose ? (
                        <span className="block text-sm text-muted-foreground [overflow-wrap:anywhere]">
                          {category.purpose}
                        </span>
                      ) : null}
                      {(category.aliases ?? []).length > 0 ? (
                        <span className="block text-sm text-muted-foreground [overflow-wrap:anywhere]">
                          {t("catalogCategories.aliases")}: {category.aliases?.join(", ")}
                        </span>
                      ) : null}
                      <span className="text-sm text-muted-foreground">
                        {t("catalogCategories.usage", { count: category.total })}
                      </span>
                    </span>
                    {canRename && category.category !== UNCATEGORIZED ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => beginEdit(category)}
                        data-testid="catalog-category-edit"
                      >
                        {t("catalogCategories.edit")}
                      </Button>
                    ) : null}
                  </li>
                ))}
            </ul>
            {!categories.some(
              (category) => category.category !== "platform" && categoryMatches(category, search),
            ) ? (
              <p className="text-sm text-muted-foreground">{t("catalogCategories.noMatches")}</p>
            ) : null}
          </div>
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
          disabled:
            !normalized ||
            normalized === "platform" ||
            normalized === UNCATEGORIZED ||
            conflict ||
            purposeInvalid ||
            aliasesInvalid,
        }}
        onSubmit={() => {
          if (
            editing &&
            normalized &&
            normalized !== "platform" &&
            normalized !== UNCATEGORIZED &&
            !conflict &&
            !purposeInvalid &&
            !aliasesInvalid
          )
            save.mutate({
              from: editing.category,
              body: categoryEditPayload(editing, target, normalized, purpose, aliases),
            });
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
            name.trim() &&
            (!normalized || normalized === "platform" || normalized === UNCATEGORIZED)
              ? t("catalogMeta.invalidCategory")
              : null
          }
        />
        <TextAreaField
          id="catalog-category-purpose"
          label={t("catalogCategories.purpose")}
          value={purpose}
          onChange={setPurpose}
          rows={3}
          help={target ? undefined : t("catalogCategories.purposeHelp")}
          error={purposeInvalid ? t("catalogCategories.purposeLimit") : null}
        />
        {!target ? (
          <p className="text-sm text-muted-foreground" data-testid="catalog-category-origin">
            {t(
              !purpose.trim()
                ? "catalogCategories.blankPurpose"
                : editing?.purpose_source === "llm" && purpose === editing.purpose
                  ? "catalogCategories.originAI"
                  : editing?.purpose_source === "human" && purpose === editing.purpose
                    ? "catalogCategories.originHuman"
                    : "catalogCategories.originDraft",
            )}
          </p>
        ) : null}
        <TextField
          id="catalog-category-aliases"
          label={t("catalogCategories.aliases")}
          value={aliases}
          onChange={setAliases}
          help={t("catalogCategories.aliasesHelp")}
          error={aliasesInvalid ? t("catalogCategories.aliasesLimit") : null}
        />
        {target ? (
          <p className="text-sm [overflow-wrap:anywhere]" data-testid="catalog-category-merge">
            {t("catalogCategories.merge", {
              name: humanizeCategory(target.category, t("catalog.categoryOther")),
              count: editing?.total ?? 0,
            })}{" "}
            {target.purpose
              ? t("catalogCategories.mergePurpose", { purpose: target.purpose })
              : t("catalogCategories.mergeNoPurpose")}
          </p>
        ) : null}
        {conflict ? (
          <div role="alert" className="flex flex-col gap-2 text-sm">
            <p>{t("catalogCategories.conflict")}</p>
            <Button
              variant="outline"
              data-testid="catalog-category-conflict-reload"
              onClick={async () => {
                const refreshed = await query.refetch();
                if (refreshed.error) {
                  toast.error(t("detail.saveFailed"));
                  return;
                }
                const latest = refreshed.data?.categories.find(
                  (category) => category.category === editing?.category,
                );
                if (latest) beginEdit(latest, refreshed.data?.categories ?? []);
                else setEditing(null);
              }}
            >
              {t("catalogCategories.reload")}
            </Button>
          </div>
        ) : null}
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
            { value: "all", label: t("catalog.originAll"), testId: "catalog-origin-all" },
            { value: "llm", label: t("catalog.originAI"), testId: "catalog-origin-llm" },
          ]}
          testId="catalog-origin"
        />
      }
    />
  );
}
