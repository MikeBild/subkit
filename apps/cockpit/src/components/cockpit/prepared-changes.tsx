import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { useLiveQueryOptions } from "@/app/live-events";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n-context";

/** A secret version somebody prepared and nobody has approved yet. */
export interface PreparedChange {
  name: string;
  version: number;
  reference: string;
  prepared_by: string;
  pending_since: string;
  bindings: string[];
}

interface ApprovalOutcome {
  name: string;
  version: number;
  bindings: Array<{ path: string; outcome: "rebound" | "failed"; detail: string | null }>;
}

const QUERY_KEY = ["admin", "prepared-changes"] as const;

/** The settings path a secret name stands for, without the `settings.` stem the vault adds. */
export function preparedChangeTarget(name: string): string {
  return name.replace(/^settings\./, "").replace(/^tenants\.[^.]+\.settings\./, "");
}

/**
 * "Vorbereitete Änderungen": what waits for a person on this installation.
 * Two buttons, no field — the value is already stored and is never shown.
 */
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

  const items = query.data?.items ?? [];
  if (items.length === 0) return null;
  const busy = approve.isPending || reject.isPending;

  return (
    <section className="mb-6" data-testid="prepared-changes" data-family-slot="waiting">
      <h2 className="text-base font-semibold">{t("prepared.title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("prepared.description")}</p>
      <div className="mt-3 grid gap-2">
        {items.map((change, index) => (
          <Card key={change.reference} size="sm" data-testid={`prepared-change-${index}`}>
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{preparedChangeTarget(change.name)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("prepared.meta", {
                    version: String(change.version),
                    by: change.prepared_by || "—",
                    since: dateTime(change.pending_since),
                  })}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {change.bindings.length > 0
                    ? t("prepared.rebinds", { paths: change.bindings.join(", ") })
                    : t("prepared.rebindsNothing")}
                </p>
              </div>
              {canDecide && (
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => reject.mutate(change)}
                    data-testid={`prepared-change-reject-${index}`}
                  >
                    {t("prepared.reject")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => approve.mutate(change)}
                    data-testid={`prepared-change-approve-${index}`}
                  >
                    {t("prepared.approve")}
                  </Button>
                </div>
              )}
              {!canDecide && <Badge variant="outline">{t("prepared.readOnly")}</Badge>}
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
