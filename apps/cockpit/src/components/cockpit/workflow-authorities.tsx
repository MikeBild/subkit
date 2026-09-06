import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiRequest } from "@/api/client";
import { GrantWorkflowAuthority } from "@/components/cockpit/grant-workflow-authority";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { formatDateTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  AUTHORITY_EFFECT_KEYS,
  AUTHORITY_STATE_KEYS,
  observedAuthorityState,
  type WorkflowAuthority,
  type WorkflowAuthorityList,
} from "@/lib/workflow-authorities";

function AuthorityBoundary({ authority }: { authority: WorkflowAuthority }) {
  const { t, locale } = useI18n();
  return (
    <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-muted-foreground">{t("authority.version")}</dt>
        <dd className="break-all font-mono text-xs">{authority.workflow_version_id}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{t("authority.environment")}</dt>
        <dd>
          {t(
            authority.execution_environment === "prod"
              ? "authority.production"
              : "authority.development",
          )}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{t("authority.window")}</dt>
        <dd>
          <time dateTime={authority.valid_from}>
            {formatDateTime(locale, authority.valid_from)}
          </time>
          {" — "}
          <time dateTime={authority.valid_until}>
            {formatDateTime(locale, authority.valid_until)}
          </time>
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{t("authority.runs")}</dt>
        <dd>
          {t("authority.remaining", {
            remaining: authority.remaining_runs,
            max: authority.max_runs,
          })}
        </dd>
      </div>
      <div className="min-w-0 sm:col-span-2">
        <dt className="text-muted-foreground">{t("authority.effects")}</dt>
        <dd>
          {authority.effect_manifest.effects.length === 0 ? (
            t("authority.noEffects")
          ) : (
            <ul className="flex flex-col gap-2">
              {authority.effect_manifest.effects.map((effect) => (
                <li key={effect.step_id} className="min-w-0 break-words">
                  <span className="font-medium">{effect.step_id}</span>
                  {" · "}
                  {t(AUTHORITY_EFFECT_KEYS[effect.effect])}
                  {" · "}
                  {effect.driver}
                  {" / "}
                  {effect.operation}
                  <div className="break-all text-muted-foreground">
                    {t("authority.connector")}
                    {": "}
                    {effect.connector_id ?? t("authority.directRequest")}
                  </div>
                  <div className="break-all text-muted-foreground">
                    {effect.target ?? t("authority.unboundTarget")}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>
      <div className="min-w-0 sm:col-span-2">
        <dt className="text-muted-foreground">{t("authority.digest")}</dt>
        <dd className="break-all font-mono text-xs">{authority.effect_manifest_digest}</dd>
      </div>
    </dl>
  );
}

function RevokeAuthority({ authority }: { authority: WorkflowAuthority }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const revoke = useMutation({
    mutationFn: () =>
      apiRequest<WorkflowAuthority>(
        `/v1/workflows/${encodeURIComponent(authority.workflow_id)}/execution-authorities/${encodeURIComponent(authority.id)}/revoke`,
        { method: "POST" },
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["workflow-authorities", authority.workflow_id] });
      setOpen(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!revoke.isPending) {
          setOpen(value);
          revoke.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid={`authority-revoke-${authority.id}`}>
          {t("authority.revoke")}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={t("common.close")} className="max-h-[85svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("authority.revokeTitle")}</DialogTitle>
          <DialogDescription>{t("authority.revokeDescription")}</DialogDescription>
        </DialogHeader>
        <p className="break-all font-mono text-xs">{authority.id}</p>
        <AuthorityBoundary authority={authority} />
        {revoke.error && (
          <Alert variant="destructive">
            <AlertTitle>{t("authority.revokeFailed")}</AlertTitle>
            <AlertDescription>{t("authority.retryDescription")}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={revoke.isPending}
            onClick={() => setOpen(false)}
            data-testid="authority-revoke-cancel"
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate()}
            data-testid="authority-revoke-confirm"
          >
            {t(revoke.isPending ? "authority.revoking" : "authority.revoke")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** An observed history, not a run reservation or a grant of caller permissions. */
export function WorkflowAuthorities({
  workflowId,
  versionId,
  canWrite,
}: {
  workflowId: string;
  versionId: string | null;
  canWrite: boolean;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const history = useInfiniteQuery({
    queryKey: ["workflow-authorities", workflowId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      apiRequest<WorkflowAuthorityList>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/execution-authorities?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    getNextPageParam: (page) => page.next_cursor,
    refetchInterval: 30_000,
  });
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section
      data-family-slot="workflow-authorities"
      data-testid="workflow-authorities"
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{t("authority.title")}</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">{t("authority.description")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canWrite && versionId && (
            <GrantWorkflowAuthority
              key={`${workflowId}:${versionId}`}
              workflowId={workflowId}
              versionId={versionId}
            />
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={history.isFetching}
            onClick={() => void history.refetch()}
            data-testid="authority-refresh"
          >
            {t("common.refresh")}
          </Button>
        </div>
      </div>
      {history.isPending && <p role="status">{t("common.loading")}</p>}
      {history.error && (
        <Alert variant="destructive">
          <AlertTitle>{t("authority.loadFailed")}</AlertTitle>
          <AlertDescription>{t("authority.retryDescription")}</AlertDescription>
        </Alert>
      )}
      {!history.isPending && !history.error && items.length === 0 && (
        <p
          className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground"
          data-testid="authority-empty"
        >
          {t("authority.empty")}
        </p>
      )}
      {!history.error &&
        items.map((authority) => {
          const state = observedAuthorityState(authority, now);
          return (
            <Card key={authority.id} data-testid={`authority-${authority.id}`}>
              <CardHeader>
                <CardTitle>
                  <h3 className="break-all font-mono text-xs">{authority.id}</h3>
                </CardTitle>
                <CardDescription className="flex flex-wrap items-center gap-2">
                  <Badge variant={state === "approved" ? "secondary" : "outline"}>
                    {t(AUTHORITY_STATE_KEYS[state])}
                  </Badge>
                  <span>
                    {t(
                      !authority.active_version
                        ? "authority.inactiveVersion"
                        : authority.ready_for_new_run && state === "approved"
                          ? "authority.ready"
                          : "authority.notReady",
                    )}
                  </span>
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <AuthorityBoundary authority={authority} />
                {canWrite && !authority.revoked_at && (
                  <div>
                    <RevokeAuthority authority={authority} />
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      {history.hasNextPage && !history.error && (
        <Button
          variant="outline"
          disabled={history.isFetching}
          onClick={() => void history.fetchNextPage()}
          data-testid="authority-more"
        >
          {t("authority.more")}
        </Button>
      )}
    </section>
  );
}
