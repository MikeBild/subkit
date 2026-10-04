import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { useLiveQueryOptions } from "@/app/live-events";
import { ListTable } from "@/components/cockpit/list-table";
import { Button, type CockpitColumn, ContextHelp, Section } from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import { useI18n } from "@/lib/i18n-context";

export type PreparedChange = {
  name: string;
  version: number;
  reference: string;
  prepared_by: string;
  pending_since: string;
  bindings: string[];
};

interface ApprovalOutcome {
  name: string;
  version: number;
  bindings: Array<{ path: string; outcome: "rebound" | "failed"; detail: string | null }>;
}

const QUERY_KEY = ["admin", "prepared-changes"] as const;

export function preparedChangeTarget(name: string): string {
  return name.replace(/^settings\./, "").replace(/^tenants\.[^.]+\.settings\./, "");
}

export function PreparedChanges({ canDecide }: { canDecide: boolean }) {
  const { t, dateTime } = useI18n();
  const client = useQueryClient();
  const live = useLiveQueryOptions();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => apiRequest<{ items: PreparedChange[] }>("/v1/secret-approvals"),
    ...live,
  });
  const refresh = () => client.invalidateQueries({ queryKey: QUERY_KEY });
  const approve = useMutation({
    mutationFn: (change: PreparedChange) =>
      apiRequest<ApprovalOutcome>(
        `/v1/secret-approvals/${encodeURIComponent(change.name)}/${change.version}/approve`,
        { method: "POST" },
      ),
    onSuccess: async (outcome) => {
      const failed = outcome.bindings.filter((b) => b.outcome === "failed");
      if (failed.length > 0) {
        toast.error(
          t("prepared.approvedButNotBound", {
            paths: failed.map((b) => b.path).join(", "),
          }),
        );
      } else {
        toast.success(t("prepared.approved", { target: preparedChangeTarget(outcome.name) }));
      }
      await refresh();
      await client.invalidateQueries({ queryKey: ["admin", "settings"] });
    },
    onError: () => toast.error(t("prepared.decisionFailed")),
  });
  const reject = useMutation({
    mutationFn: (change: PreparedChange) =>
      apiRequest(
        `/v1/secret-approvals/${encodeURIComponent(change.name)}/${change.version}/reject`,
        { method: "POST" },
      ),
    onSuccess: async (_result, change) => {
      toast.success(t("prepared.rejected", { target: preparedChangeTarget(change.name) }));
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
          <span className="block truncate font-medium">{preparedChangeTarget(change.name)}</span>
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
            {change.bindings.length > 0 ? change.bindings.join(", ") : "—"}
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
