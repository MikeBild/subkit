import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { useActorDirectory } from "@/app/actor-directory";
import {
  Button,
  type CockpitColumn,
  CollapsibleSection,
  type Fact,
  FactList,
  RecordSheet,
  StatusBadge,
} from "@/components/cockpit/patterns";
import { RecordTable } from "@/components/cockpit/record-table";
import { MISSING, tableColumns } from "@/components/cockpit/table-columns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { useInfiniteList } from "@/lib/use-infinite-list";
import {
  restoredFrom,
  VERSION_BADGE_STATES,
  VERSION_STATE_KEYS,
  type WorkflowVersion,
  type WorkflowVersionAccess,
  type WorkflowVersionIds,
  workflowVersionAuthor,
  workflowVersionSheetCopy,
  workflowVersionState,
  workflowVersionView,
} from "@/lib/workflow-versions";
import { fetchCurrentVersionDag } from "@/pages/apps-model";

const VERSION_PAGE = 20;

function useWorkflowVersionList(workflowId: string, enabled = true) {
  return useInfiniteList<WorkflowVersion>(
    `/v1/workflows/${encodeURIComponent(workflowId)}/history`,
    {},
    {
      queryKey: ["workflow", workflowId, "versions"],
      limit: VERSION_PAGE,
      enabled: enabled && workflowId !== "",
    },
  );
}

export function useCurrentVersionDag(
  workflowId: string,
  currentVersionId: string | null | undefined,
  currentVersion: number | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ["workflow", workflowId, "current-definition", currentVersionId ?? null],
    enabled: enabled && workflowId !== "" && Boolean(currentVersionId),
    queryFn: () =>
      fetchCurrentVersionDag(
        (limit, offset) =>
          apiRequest<{ items: WorkflowVersion[]; total: number }>(
            `/v1/workflows/${encodeURIComponent(workflowId)}/history?limit=${limit}&offset=${offset}`,
          ),
        currentVersionId,
        currentVersion,
      ),
  });
}

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

const SERVICE_PACKAGE_NOTE_PREFIX = "subkit-service-package-workflow/v1:";

export function servicePackageVersion(note: string): string | null {
  try {
    const encoded = note.slice(SERVICE_PACKAGE_NOTE_PREFIX.length);
    const padded = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (c) =>
      c.charCodeAt(0),
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const version =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).package_version
        : null;
    return typeof version === "string" && version.length > 0 && version.length <= 40
      ? version
      : null;
  } catch {
    return null;
  }
}

function versionNote(note: string | null, t: Translate): string {
  if (note?.startsWith(SERVICE_PACKAGE_NOTE_PREFIX)) {
    const packageVersion = servicePackageVersion(note);
    return packageVersion
      ? t("workflowVersions.servicePackageVersion", { version: packageVersion })
      : t("workflowVersions.servicePackage");
  }
  const from = restoredFrom(note);
  if (from !== null) return t("workflowVersions.restoredFrom", { version: `v${from}` });
  return note?.trim() || MISSING;
}

function VersionBadge({ version, ids }: { version: WorkflowVersion; ids: WorkflowVersionIds }) {
  const { t } = useI18n();
  const state = workflowVersionState(version, ids);
  return <StatusBadge state={VERSION_BADGE_STATES[state]} label={t(VERSION_STATE_KEYS[state])} />;
}

export function WorkflowVersions({
  workflowId,
  workflowName,
  ids,
  access,
  onRestored,
}: {
  workflowId: string;
  workflowName: string;
  ids: WorkflowVersionIds;
  access: WorkflowVersionAccess;
  onRestored: () => void;
}) {
  const { t, dateTime } = useI18n();
  const directory = useActorDirectory(true);
  const [open, setOpen] = useState<WorkflowVersion | null>(null);
  const list = useWorkflowVersionList(workflowId);
  const columns = useMemo<CockpitColumn<WorkflowVersion>[]>(() => {
    const column = tableColumns<WorkflowVersion>({ t, dateTime });
    return [
      column.custom(
        "version",
        (version) => version.version,
        t("workflowVersions.column.version"),
        (version) => `v${version.version}`,
        { width: "w-[14%]" },
      ),
      column.custom(
        "note",
        (version) => version.note,
        t("workflowVersions.column.change"),
        (version) => versionNote(version.note, t),
        { width: "w-[44%]" },
      ),
      column.custom(
        "saved",
        (version) => version.created_at,
        t("workflowVersions.column.saved"),
        (version) =>
          `${workflowVersionAuthor(version.author, directory, t)} · ${dateTime(version.created_at)}`,
        { width: "w-[24%]" },
      ),
      column.custom(
        "state",
        (version) => version.id,
        t("resource.field.status"),
        (version) => <VersionBadge version={version} ids={ids} />,
        { width: "w-[18%]" },
      ),
    ];
  }, [t, dateTime, ids, directory]);
  const failed = Boolean(list.query.error || list.query.failureReason) && list.items.length === 0;
  return (
    <CollapsibleSection
      label={t("workflowVersions.title")}
      count={list.total}
      testId="workflow-versions"
    >
      <RecordTable
        columns={columns}
        data={list.items}
        collectionId="workflow-versions"
        emptyLine={t("workflowVersions.empty")}
        pending={list.query.isPending && !failed}
        error={
          failed
            ? { line: t("workflowVersions.loadFailed"), onRetry: () => void list.query.refetch() }
            : null
        }
        infinite={list.infinite}
        total={list.total}
        getRowId={(version) => version.id}
        onOpen={(version) => setOpen(version)}
        rowLabel={(version) => `v${version.version}`}
      />
      {open ? (
        <WorkflowVersionSheet
          version={open}
          history={list.items}
          ids={ids}
          workflowId={workflowId}
          workflowName={workflowName}
          access={access}
          onClose={() => setOpen(null)}
          onRestored={onRestored}
        />
      ) : null}
    </CollapsibleSection>
  );
}

function WorkflowVersionSheet({
  version,
  history,
  ids,
  workflowId,
  workflowName,
  access,
  onClose,
  onRestored,
}: {
  version: WorkflowVersion;
  history: readonly WorkflowVersion[];
  ids: WorkflowVersionIds;
  workflowId: string;
  workflowName: string;
  access: WorkflowVersionAccess;
  onClose: () => void;
  onRestored: () => void;
}) {
  const { t, dateTime } = useI18n();
  const directory = useActorDirectory(true);
  const client = useQueryClient();
  const view = workflowVersionView(version, history, ids);
  const label = `v${version.version}`;
  const next = view.nextVersion === null ? MISSING : `v${view.nextVersion}`;
  const restore = useMutation({
    mutationFn: () =>
      apiRequest<{ current_version?: number | null }>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/restore/${version.version}`,
        { method: "POST" },
      ),
    onSuccess: async (result) => {
      toast.success(
        t("workflowVersions.restored", {
          from: label,
          next: typeof result?.current_version === "number" ? `v${result.current_version}` : next,
        }),
      );
      onClose();
      onRestored();
      await Promise.all([
        client.invalidateQueries({ queryKey: ["workflow", workflowId, "versions"] }),
        client.invalidateQueries({ queryKey: ["catalog-detail", "workflows", workflowId] }),
        client.invalidateQueries({ queryKey: ["attention"] }),
      ]);
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiError && error.status === 422
          ? t("workflowVersions.notRestorable")
          : t("common.actionFailed"),
      ),
  });
  const copy = workflowVersionSheetCopy(view, access);
  const facts: Fact[] = [
    { label: t("workflowVersions.fact.version"), value: label },
    {
      label: t("workflowVersions.fact.saved"),
      value: `${workflowVersionAuthor(version.author, directory, t)} · ${dateTime(version.created_at)}`,
    },
    { label: t("workflowVersions.fact.note"), value: versionNote(version.note, t) },
  ];
  return (
    <RecordSheet
      open
      onOpenChange={(isOpen) => !isOpen && !restore.isPending && onClose()}
      title={`${workflowName} · ${label}`}
      titleTestId="workflow-version-title"
      badge={<VersionBadge version={version} ids={ids} />}
      action={
        copy.restore ? (
          <Button
            pending={restore.isPending}
            onClick={() => restore.mutate()}
            data-testid="workflow-version-restore"
          >
            {t("workflowVersions.restore")}
          </Button>
        ) : undefined
      }
      testId="workflow-version-sheet"
      closeTestId="workflow-version-sheet-close"
    >
      <FactList items={facts} testId="workflow-version-facts" />
      <p className="text-sm text-muted-foreground" data-testid="workflow-version-hint">
        {t(copy.hint, copy.values)}
      </p>
    </RecordSheet>
  );
}
