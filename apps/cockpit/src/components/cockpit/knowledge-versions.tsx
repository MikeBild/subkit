import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { useActorDirectory } from "@/app/actor-directory";
import { useLiveQueryOptions } from "@/app/live-events";
import { FocusedDiff } from "@/components/cockpit/diff-card";
import {
  Button,
  type CockpitColumn,
  CollapsibleSection,
  DataState,
  DataTable,
  type Fact,
  FactList,
  FilePreview,
  RecordSheet,
  RowName,
  Section,
  StatusBadge,
} from "@/components/cockpit/patterns";
import { MISSING, tableColumns } from "@/components/cockpit/table-columns";
import { useI18n } from "@/lib/i18n-context";
import {
  authorName,
  type KnowledgeVersion,
  type KnowledgeVersionDetail,
  previousVersion,
  restoreHint,
  versionChange,
  versionText,
  versionWhy,
} from "@/pages/knowledge-versions-model";

type History = { items: KnowledgeVersion[]; total: number };

function sourcePath(sourceId: string): string {
  return `/v1/knowledge-sources/${encodeURIComponent(sourceId)}`;
}

function versionBadge(version: KnowledgeVersion, t: ReturnType<typeof useI18n>["t"]) {
  return (
    <StatusBadge
      state={version.current ? "active" : "superseded"}
      label={t(version.current ? "knowledge.versions.current" : "knowledge.versions.earlier")}
    />
  );
}

export function KnowledgeVersions({
  sourceId,
  sourceName,
  canWrite,
}: {
  sourceId: string;
  sourceName: string;
  canWrite: boolean;
}) {
  const { t, dateTime } = useI18n();
  const live = useLiveQueryOptions();
  const directory = useActorDirectory(true);
  const history = useQuery({
    queryKey: ["knowledge-source", sourceId, "history"],
    queryFn: () => apiRequest<History>(`${sourcePath(sourceId)}/history?limit=200`),
    ...live,
  });
  const [selected, setSelected] = useState<number | null>(null);
  const columns = useMemo<CockpitColumn<KnowledgeVersion>[]>(() => {
    const column = tableColumns<KnowledgeVersion>({ t, dateTime });
    return [
      column.custom(
        "version",
        (row) => row.version,
        t("knowledge.versions.column.version"),
        (row) => <RowName>{`v${row.version}`}</RowName>,
        { width: "w-[15%]", ownsRowLink: true },
      ),
      column.custom(
        "why",
        (row) => row.note ?? "",
        t("knowledge.versions.column.why"),
        (row) => versionWhy(row.note, directory, t) ?? MISSING,
        { width: "w-[35%]" },
      ),
      column.custom(
        "state",
        (row) => (row.current ? 1 : 0),
        t("knowledge.versions.column.state"),
        (row) => versionBadge(row, t),
        { width: "w-[15%]" },
      ),
      column.custom(
        "saved",
        (row) => row.created_at,
        t("knowledge.versions.column.saved"),
        (row) => `${authorName(row.author, directory, t)} · ${dateTime(row.created_at)}`,
        { width: "w-[35%]" },
      ),
    ];
  }, [t, dateTime, directory]);

  const items = history.data?.items ?? [];
  if (!history.error && items.length === 0) return null;
  const latest = items[0]?.version ?? 0;
  const open = items.find((item) => item.version === selected) ?? null;

  return (
    <>
      <CollapsibleSection
        label={t("knowledge.versions.title")}
        count={history.data?.total ?? items.length}
        testId="knowledge-versions"
      >
        {history.error ? (
          <DataState
            state="error"
            line={t("knowledge.versions.loadFailed")}
            onRetry={() => void history.refetch()}
            testId="knowledge-versions-failed"
          />
        ) : (
          <DataTable
            columns={columns}
            data={items}
            sorting={[]}
            onSortingChange={() => undefined}
            onOpen={(row) => setSelected(row.version)}
            rowLabel={(row) => `v${row.version}`}
            getRowId={(row) => String(row.version)}
            emptyState={{
              zero: { title: "" },
              filtered: { title: "", description: "", resetLabel: "", onReset: () => undefined },
            }}
            hasActiveFilters={false}
            columnsLabel={t("catalog.columns")}
            actionsLabel={t("common.actions")}
            collectionId="knowledge-versions"
            collectionTier="embedded"
          />
        )}
      </CollapsibleSection>
      <KnowledgeVersionSheet
        sourceId={sourceId}
        sourceName={sourceName}
        version={open}
        latest={latest}
        canWrite={canWrite}
        directory={directory}
        onClose={() => setSelected(null)}
      />
    </>
  );
}

function KnowledgeVersionSheet({
  sourceId,
  sourceName,
  version,
  latest,
  canWrite,
  directory,
  onClose,
}: {
  sourceId: string;
  sourceName: string;
  version: KnowledgeVersion | null;
  latest: number;
  canWrite: boolean;
  directory: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const { t, dateTime } = useI18n();
  const client = useQueryClient();
  const number = version?.version ?? 0;
  const prior = previousVersion(number);
  const detail = useQuery({
    queryKey: ["knowledge-source", sourceId, "history", number],
    queryFn: () => apiRequest<KnowledgeVersionDetail>(`${sourcePath(sourceId)}/history/${number}`),
    enabled: version !== null,
  });
  const previous = useQuery({
    queryKey: ["knowledge-source", sourceId, "history", prior],
    queryFn: () => apiRequest<KnowledgeVersionDetail>(`${sourcePath(sourceId)}/history/${prior}`),
    enabled: version !== null && prior !== null,
  });
  const restore = useMutation({
    mutationFn: () =>
      apiRequest<{ version: number }>(`${sourcePath(sourceId)}/restore/${number}`, {
        method: "POST",
      }),
    onSuccess: (result) => {
      toast.success(t("knowledge.versions.restored", { from: number, to: result.version }));
      void client.invalidateQueries({ queryKey: ["knowledge-source", sourceId] });
      void client.invalidateQueries({ queryKey: ["catalog"] });
      onClose();
    },
    onError: () => toast.error(t("common.actionFailed")),
  });

  const why = version ? versionWhy(version.note, directory, t) : null;
  const facts: Fact[] = version
    ? [
        { label: t("knowledge.versions.savedBy"), value: authorName(version.author, directory, t) },
        ...(why ? [{ label: t("knowledge.versions.why"), value: why }] : []),
        { label: t("knowledge.versions.at"), value: dateTime(version.created_at) },
      ]
    : [];
  const loading = detail.isPending || (prior !== null && previous.isPending);
  const failed = Boolean(detail.error || previous.error);
  const rows =
    detail.data && (prior === null || previous.data)
      ? versionChange(previous.data?.documents ?? [], detail.data.documents)
      : [];

  return (
    <RecordSheet
      open={version !== null}
      onOpenChange={(open) => !open && onClose()}
      title={version ? `${sourceName} · v${version.version}` : ""}
      badge={version ? versionBadge(version, t) : undefined}
      action={
        version && canWrite && !version.current ? (
          <Button
            pending={restore.isPending}
            onClick={() => restore.mutate()}
            data-testid="knowledge-version-restore"
          >
            {t("knowledge.versions.restore")}
          </Button>
        ) : undefined
      }
      testId="knowledge-version-sheet"
      closeTestId="knowledge-version-close"
    >
      {version ? (
        <div className="flex flex-col gap-6">
          <FactList items={facts} testId="knowledge-version-facts" />
          {loading ? (
            <DataState state="loading" />
          ) : failed || !detail.data ? (
            <DataState
              state="error"
              line={t("knowledge.versions.loadFailed")}
              onRetry={() => {
                void detail.refetch();
                if (prior !== null) void previous.refetch();
              }}
              testId="knowledge-version-failed"
            />
          ) : prior === null ? (
            <Section label={t("knowledge.versions.content")} testId="knowledge-version-content">
              <FilePreview
                name=""
                mimeType="text/markdown"
                text={versionText(detail.data.documents)}
              />
            </Section>
          ) : (
            <Section
              label={t("knowledge.versions.changeSince", { version: prior })}
              testId="knowledge-version-change"
            >
              {rows.length > 0 ? (
                <FocusedDiff rows={rows} testId="knowledge-version-diff" />
              ) : (
                <p className="text-sm text-muted-foreground">{t("knowledge.versions.unchanged")}</p>
              )}
            </Section>
          )}
          <p className="text-sm text-muted-foreground" data-testid="knowledge-version-hint">
            {restoreHint(version, latest, t)}
          </p>
        </div>
      ) : null}
    </RecordSheet>
  );
}
