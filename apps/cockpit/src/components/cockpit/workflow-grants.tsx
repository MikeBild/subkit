import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { apiRequest } from "@/api/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  authorityHeadline,
  authorityVersionLabel,
  observedAuthorityState,
  type WorkflowAuthority,
} from "@/lib/workflow-authorities";
import { shortIdentifier } from "@/pages/audit-model";

/**
 * An identifier where a reader looks: shortened, whole in the `title`. Never
 * the raw 36 characters.
 */
function ShortId({ value }: { value: string }) {
  const shown = shortIdentifier(value);
  return <span title={shown === value ? undefined : value}>{shown}</span>;
}

/** What an approval permits — the part a reader decides by. */
function GrantEffects({ authority }: { authority: WorkflowAuthority }) {
  const { t } = useI18n();
  if (authority.effect_manifest.effects.length === 0)
    return <p className="text-sm text-muted-foreground">{t("authority.noEffects")}</p>;
  return (
    <ul className="flex flex-col gap-2 text-sm">
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
            {effect.connector_id ? (
              <ShortId value={effect.connector_id} />
            ) : (
              t("authority.directRequest")
            )}
          </div>
          <div className="break-all text-muted-foreground">
            {effect.target ?? t("authority.unboundTarget")}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The exact boundary, for the reader who has to quote or compare it: the
 * version, the window to the minute and the manifest's checksum. Evidence, not
 * reading matter — it stays behind "Details".
 */
function GrantTechnicalDetails({
  authority,
  versions,
  testId,
}: {
  authority: WorkflowAuthority;
  versions: ReadonlyMap<string, number>;
  testId: string;
}) {
  const { t, locale } = useI18n();
  const version = authorityVersionLabel(authority.workflow_version_id, versions);
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="-ml-2 w-fit" data-testid={`${testId}-details`}>
          <ChevronRight data-icon="inline-start" />
          {t("common.details")}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="mt-2 grid min-w-0 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{t("authority.version")}</dt>
            <dd data-testid="authority-version" title={version.full ?? undefined}>
              {version.text}
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
          <div className="sm:col-span-2">
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
          <div className="min-w-0 sm:col-span-2">
            <dt className="text-muted-foreground">{t("authority.digest")}</dt>
            {/* A hash is evidence: its head identifies it, the whole stays on
                the title for anyone comparing it. */}
            <dd className="font-mono text-xs" title={authority.effect_manifest_digest}>
              {`${authority.effect_manifest_digest.slice(0, 12)}…`}
            </dd>
          </div>
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

function RevokeGrant({ authority, testId }: { authority: WorkflowAuthority; testId: string }) {
  const { t, locale } = useI18n();
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
      await client.invalidateQueries({
        queryKey: ["workflow-automation-status", authority.workflow_id],
      });
      await client.invalidateQueries({ queryKey: ["workflow-invocation", authority.workflow_id] });
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
        <Button variant="outline" size="sm" data-testid={`${testId}-revoke`}>
          {t("authority.revoke")}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={t("common.close")} className="max-h-[85svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("authority.revokeTitle")}</DialogTitle>
          <DialogDescription>{t("authority.revokeDescription")}</DialogDescription>
        </DialogHeader>
        {/* The exact approval this revokes, named by what it permits; its id
            stays on the title for anyone who needs to quote it. */}
        <p
          className="text-sm font-medium"
          title={authority.id}
          data-testid="authority-revoke-target"
        >
          {authorityHeadline(authority, t, locale)}
        </p>
        <GrantEffects authority={authority} />
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

/**
 * One approval: headed by what a reader decides by, then what it permits; the
 * exact boundary one disclosure deeper. Positional test ids — an approval's
 * id never becomes a selector.
 */
export function GrantCard({
  authority,
  versions,
  now,
  canWrite,
  testId,
}: {
  authority: WorkflowAuthority;
  versions: ReadonlyMap<string, number>;
  now: number;
  canWrite: boolean;
  testId: string;
}) {
  const { t, locale } = useI18n();
  const state = observedAuthorityState(authority, now);
  return (
    <div className="grid min-w-0 gap-3 rounded-lg border p-3" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        {/* The id is on the title, for quoting, and nowhere on the page. */}
        <h3 className="text-sm font-semibold" title={authority.id} data-testid="authority-headline">
          {authorityHeadline(authority, t, locale)}
        </h3>
        <Badge variant={state === "approved" && authority.active_version ? "secondary" : "outline"}>
          {t(AUTHORITY_STATE_KEYS[state])}
        </Badge>
      </div>
      {/* An approval can be valid and still cover nothing that runs. */}
      {authority.active_version ? null : (
        <p className="text-sm text-muted-foreground" data-testid={`${testId}-inactive-version`}>
          {t("authority.inactiveVersion")}
        </p>
      )}
      <GrantEffects authority={authority} />
      <div className="flex flex-wrap items-center gap-2">
        <GrantTechnicalDetails authority={authority} versions={versions} testId={testId} />
        {canWrite && !authority.revoked_at ? (
          <RevokeGrant authority={authority} testId={testId} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Approvals that no longer admit a run — expired, revoked, used up or for a
 * version that is not running — folded. History is evidence; it does not
 * compete with the one current state above it.
 */
export function FormerGrants({
  items,
  versions,
  now,
  canWrite,
  hasMore,
  loadingMore,
  onMore,
}: {
  items: readonly WorkflowAuthority[];
  versions: ReadonlyMap<string, number>;
  now: number;
  canWrite: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
}) {
  const { t } = useI18n();
  if (items.length === 0 && !hasMore) return null;
  return (
    <Collapsible data-testid="workflow-former-grants">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 w-fit"
          data-testid="workflow-former-grants-toggle"
        >
          <ChevronRight data-icon="inline-start" />
          {t("automation.formerGrants")}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 grid gap-3">
          {items.map((authority, index) => (
            <GrantCard
              key={authority.id}
              authority={authority}
              versions={versions}
              now={now}
              canWrite={canWrite}
              testId={`authority-history-${index}`}
            />
          ))}
          {hasMore && (
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              disabled={loadingMore}
              onClick={onMore}
              data-testid="authority-more"
            >
              {t("authority.more")}
            </Button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
