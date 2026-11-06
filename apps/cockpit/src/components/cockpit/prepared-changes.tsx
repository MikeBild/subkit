import type { components } from "@cli-core/engine-api/openapi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { useLiveQueryOptions } from "@/app/live-events";
import { ListTable } from "@/components/cockpit/list-table";
import { Button, type CockpitColumn, ContextHelp, Section } from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { settingLabel } from "@/pages/settings-model";

type PreparedChange = components["schemas"]["PendingSecretVersion"];

const QUERY_KEY = ["admin", "prepared-changes"] as const;

function preparedChangeTarget(name: string): string {
  return name.replace(/^settings\./, "").replace(/^tenants\.[^.]+\.settings\./, "");
}

export function PreparedChanges({ canDecide }: { canDecide: boolean }) {
  const { t, dateTime } = useI18n();
  const client = useQueryClient();
  const live = useLiveQueryOptions();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => apiCall("get", "/v1/secret-approvals", {}),
    ...live,
  });
  const refresh = () => client.invalidateQueries({ queryKey: QUERY_KEY });
  const approve = useMutation({
    mutationFn: (change: PreparedChange) =>
      apiCall("post", "/v1/secret-approvals/{name}/{version}/approve", {
        path: { name: change.name, version: change.version },
      }),
    onSuccess: async (outcome) => {
      const failed = outcome.bindings.filter((b) => b.outcome === "failed");
      if (failed.length > 0) {
        toast.error(
          t("prepared.approvedButNotBound", {
            paths: failed.map((b) => b.path).join(", "),
          }),
        );
      } else {
        toast.success(
          t("prepared.approved", {
            target: settingLabel(preparedChangeTarget(outcome.name), t).text,
          }),
        );
      }
      await refresh();
      await client.invalidateQueries({ queryKey: ["admin", "settings"] });
    },
    onError: () => toast.error(t("prepared.decisionFailed")),
  });
  const reject = useMutation({
    mutationFn: (change: PreparedChange) =>
      apiCall("post", "/v1/secret-approvals/{name}/{version}/reject", {
        path: { name: change.name, version: change.version },
      }),

    onSuccess: async (_result, change) => {
      toast.success(
        t("prepared.rejected", { target: settingLabel(preparedChangeTarget(change.name), t).text }),
      );
      await refresh();
    },
    onError: () => toast.error(t("prepared.decisionFailed")),
  });

  const columns = useMemo<CockpitColumn<PreparedChange>[]>(() => {
    const column = tableColumns<PreparedChange>({ t, dateTime });
    return [
      column.custom(
        "target",
        (change) => change.name,
        t("prepared.column.setting"),
        (change) => (
          <span className="block truncate font-medium">
            <LabelText label={settingLabel(preparedChangeTarget(change.name), t)} />
          </span>
        ),
        { width: "w-[30%]" },
      ),
      column.custom(
        "prepared",
        (change) => change.pending_since,
        t("prepared.column.prepared"),
        (change) =>
          t("prepared.meta", {
            version: String(change.version),
            by: change.prepared_by || "—",
            since: dateTime(change.pending_since),
          }),
        { width: "w-[40%]" },
      ),
      column.custom(
        "bindings",
        (change) => change.bindings.length,
        t("prepared.column.rebinds"),
        (change) => (
          <span className="block truncate" title={change.bindings.join(", ")}>
            {change.bindings.length > 0
              ? change.bindings.map((path) => settingLabel(path, t).text).join(", ")
              : "—"}
          </span>
        ),
        { width: "w-[30%]" },
      ),
    ];
  }, [t, dateTime]);

  const items = query.data?.items ?? [];
  if (items.length === 0) return null;
  const busy = approve.isPending || reject.isPending;

  return (
    <div data-testid="prepared-changes" data-family-slot="waiting">
      <Section
        label={t("prepared.title")}
        aside={
          <ContextHelp label={t("prepared.title")} testId="prepared-changes-help">
            {canDecide ? t("prepared.description") : t("prepared.readOnly")}
          </ContextHelp>
        }
      >
        <ListTable<PreparedChange>
          id="prepared-change"
          columns={columns}
          rows={items}
          pending={false}
          failed={false}
          resource={t("prepared.title")}
          onRetry={() => void query.refetch()}
          empty=""
          rowActions={
            canDecide
              ? (change, index) => (
                  <span data-action-scope="prepared-change" className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => reject.mutate(change)}
                      data-testid={`prepared-change-reject-${index}`}
                    >
                      {t("prepared.reject")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => approve.mutate(change)}
                      data-testid={`prepared-change-approve-${index}`}
                    >
                      {t("prepared.approve")}
                    </Button>
                  </span>
                )
              : undefined
          }
        />
      </Section>
    </div>
  );
}
