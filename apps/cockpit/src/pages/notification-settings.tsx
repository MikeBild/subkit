import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { absolute, chatNewHref } from "@/app/links";
import { useSession } from "@/app/session";
import { LoadFailed, queryView } from "@/components/failure-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import {
  deliveryState,
  eventPatternLabels,
  platformLabel,
  ruleNameLabel,
  ruleTarget,
  workflowPatternLabel,
} from "@/pages/notifications-model";

type Envelope<T> = { items: T[] };

function LoadingCards({ testId }: { testId: string }) {
  return (
    <div className="grid gap-3" data-testid={testId}>
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-20 w-full" />
      ))}
    </div>
  );
}

interface NotificationRuleItem {
  id: string;
  name: string;
  event_pattern: string;
  workflow_pattern: string;
  severity: string;
  target_workspace_id?: string;
  target_channel_id: string;
  active: boolean;
}

interface NotificationChannelItem {
  id: string;
  platform: string;
  workspace_id?: string;
  channel_id: string;
  default_severity: string;
  rate_limit_per_minute: number;
  circuit_state: string;
  circuit_open_until?: string | null;
  consecutive_failures?: number;
  active: boolean;
}

const SEVERITY_LABEL: Readonly<Record<string, TranslationKey>> = {
  debug: "notifications.severity.debug",
  info: "notifications.severity.info",
  warn: "notifications.severity.warn",
  error: "notifications.severity.error",
  critical: "notifications.severity.critical",
};

/**
 * Which events leave this installation, and through which channel.
 *
 * The delivery state is read as a word rather than through the shared status
 * label: a circuit phase the engine can store must never resolve to
 * "unknown" (§2), and the shared helper is allowed to fall through to it.
 */
/** The notification rules and channels — the Benachrichtigungen tab of Einstellungen. */
export function NotificationSettings() {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canWrite = session.permissions.includes("notification:write");
  const resume = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/v1/notifications/channels/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ active: true }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["admin", "notification-channels"] });
      toast.success(t("notifications.resumed"));
    },
    onError: (error) =>
      toast.error(
        t("notifications.resumeFailed", {
          reason: error instanceof ApiError ? error.message : t("resource.loadFailedDescription"),
        }),
      ),
  });
  const now = Date.now();
  const rules = useQuery({
    queryKey: ["admin", "notification-rules"],
    queryFn: () => apiRequest<Envelope<NotificationRuleItem>>("/v1/notifications/rules"),
  });
  const channels = useQuery({
    queryKey: ["admin", "notification-channels"],
    queryFn: () => apiRequest<Envelope<NotificationChannelItem>>("/v1/notifications/channels"),
  });
  const ruleItems = rules.data?.items ?? [];
  const channelItems = channels.data?.items ?? [];
  const rulesView = queryView(rules, (data) => data.items.length === 0);
  const channelsView = queryView(channels, (data) => data.items.length === 0);
  const word = (map: Readonly<Record<string, TranslationKey>>, value: string, fallback: string) => {
    const key = map[value];
    return key ? t(key) : fallback;
  };

  return (
    <div data-testid="admin-notifications" className="flex flex-col gap-6">
      {rulesView === "loading" || channelsView === "loading" ? (
        <LoadingCards testId="notifications-loading" />
      ) : rulesView === "error" || channelsView === "error" ? (
        // Either half missing makes the other misleading: rules without the
        // channels they deliver to cannot say where anything goes.
        <LoadFailed
          title={t("resource.loadFailed", { resource: t("resource.notifications.title") })}
          onRetry={() => {
            void rules.refetch();
            void channels.refetch();
          }}
          testId="notifications-load-failed"
        />
      ) : ruleItems.length === 0 && channelItems.length === 0 ? (
        // Never used, not measured zero: the next step belongs in the empty
        // state, not in a manual somewhere else (§4).
        <Empty className="min-h-52 border" data-testid="notifications-empty">
          <EmptyHeader>
            <EmptyTitle>{t("notifications.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("notifications.emptyDescription")}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild variant="outline">
              <a
                href={absolute(chatNewHref({ prompt: t("notifications.setupPrompt") }))}
                data-testid="notifications-empty-setup"
              >
                {t("notifications.emptySetup")}
              </a>
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid gap-4">
          <Card data-testid="notifications-rules">
            <CardHeader>
              <CardTitle>{t("notifications.rules")}</CardTitle>
              <CardDescription>{t("notifications.rulesDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              {ruleItems.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="notifications-rules-none">
                  {t("notifications.noRules")}
                </p>
              ) : (
                ruleItems.map((rule, index) => {
                  const target = ruleTarget(rule, channelItems);
                  return (
                    <div
                      key={rule.id}
                      className="rounded-lg border p-3"
                      data-testid={`notifications-rule-${index}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="min-w-0 font-medium break-words">{ruleNameLabel(rule, t)}</p>
                        <Badge variant={rule.active ? "secondary" : "outline"}>
                          {t(rule.active ? "notifications.active" : "notifications.paused")}
                        </Badge>
                        <Badge variant="outline">
                          {word(SEVERITY_LABEL, rule.severity, rule.severity)}
                        </Badge>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground wrap-anywhere">
                        {eventPatternLabels(rule.event_pattern, t).map((label, part) => (
                          <Fragment key={`${part}-${label.text}`}>
                            {part > 0 ? ", " : null}
                            <LabelText label={label} />
                          </Fragment>
                        ))}{" "}
                        · <LabelText label={workflowPatternLabel(rule.workflow_pattern, t)} />
                      </p>
                      <p
                        className="mt-1 text-sm text-muted-foreground break-words"
                        data-testid={`notifications-rule-${index}-target`}
                      >
                        {target.kind === "inbox"
                          ? t("notifications.target.inbox")
                          : target.kind === "channel"
                            ? t("notifications.target.channel", {
                                channel: platformLabel(target.channel.platform, t).text,
                              })
                            : t("notifications.target.pending")}
                      </p>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card data-testid="notifications-channels">
            <CardHeader>
              <CardTitle>{t("notifications.channels")}</CardTitle>
              <CardDescription>{t("notifications.channelsDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              {channelItems.length === 0 ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="notifications-channels-none"
                >
                  {t("notifications.noChannels")}
                </p>
              ) : (
                channelItems.map((channel, index) => {
                  const delivery = deliveryState(channel, now);
                  return (
                    <div
                      key={channel.id}
                      className="rounded-lg border p-3"
                      data-testid={`notifications-channel-${index}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="min-w-0 font-medium break-words">
                          <LabelText label={platformLabel(channel.platform, t)} />
                        </p>
                        <Badge variant={channel.active ? "secondary" : "outline"}>
                          {t(channel.active ? "notifications.active" : "notifications.paused")}
                        </Badge>
                        {/* Only a running cool-down is red: that is the one phase
                          in which events are skipped. Anything this build has
                          no word for is the engine's own, neutral. */}
                        <Badge
                          variant={delivery.kind === "suspended" ? "destructive" : "outline"}
                          data-testid={`notifications-channel-${index}-delivery`}
                        >
                          {delivery.kind === "machine" ? (
                            <LabelText label={{ text: delivery.value, machine: true }} />
                          ) : (
                            t(
                              delivery.kind === "delivering"
                                ? "notifications.circuit.closed"
                                : delivery.kind === "retrying"
                                  ? "notifications.circuit.halfOpen"
                                  : "notifications.circuit.open",
                            )
                          )}
                        </Badge>
                      </div>
                      {delivery.kind === "suspended" ? (
                        <p
                          className="mt-1 text-sm break-words"
                          data-testid={`notifications-channel-${index}-cause`}
                        >
                          {t("notifications.suspendedCause", {
                            count: String(delivery.failures),
                          })}{" "}
                          {delivery.until
                            ? t("notifications.suspendedUntil", { time: dateTime(delivery.until) })
                            : t("notifications.suspendedRetry")}
                        </p>
                      ) : null}
                      {!channel.active ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <p className="text-sm text-muted-foreground">
                            {t("notifications.pausedCause")}
                          </p>
                          {canWrite ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={resume.isPending}
                              onClick={() => resume.mutate(channel.id)}
                              data-testid={`notifications-channel-${index}-resume`}
                            >
                              {t("notifications.resume")}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                      <p className="mt-1 text-sm text-muted-foreground break-words">
                        {t("notifications.channelLimit", {
                          severity: word(
                            SEVERITY_LABEL,
                            channel.default_severity,
                            channel.default_severity,
                          ),
                          limit: String(channel.rate_limit_per_minute),
                        })}
                      </p>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
