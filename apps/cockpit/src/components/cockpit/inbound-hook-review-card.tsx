import { Link } from "@tanstack/react-router";
import { ArrowRight, Clock3 } from "lucide-react";
import type { InboundHookAutomation } from "@/api/decisions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n-context";

/** A hook whose deliveries the authority gate refuses — the webhook half of
 *  `ScheduleReviewCard`, with the same two reasons and the same way out. */
export function InboundHookReviewCard({ hook }: { hook: InboundHookAutomation }) {
  const { t, dateTime } = useI18n();
  const concrete = hook.admission_hold?.reason_code === "execution_authority_required";
  return (
    <Card size="sm" data-testid="inbound-hook-admission-held">
      <CardHeader>
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">
                <Clock3 data-icon="inline-start" />
                {t("schedules.held.status")}
              </Badge>
              <Badge variant="outline">{hook.environment.toUpperCase()}</Badge>
            </div>
            <CardTitle>
              <h3 className="break-words">{t("hooks.held.title", { slug: hook.slug })}</h3>
            </CardTitle>
            <CardDescription>
              {t(concrete ? "hooks.held.concreteShort" : "hooks.held.authorityShort")}
            </CardDescription>
            {hook.admission_hold?.observed_at && (
              <p
                className="text-muted-foreground text-xs"
                data-testid="inbound-hook-admission-since"
              >
                {t("schedules.held.since", { when: dateTime(hook.admission_hold.observed_at) })}
                {hook.last_refused_at
                  ? ` · ${t("hooks.held.lastRefused", { when: dateTime(hook.last_refused_at) })}`
                  : ""}
              </p>
            )}
          </div>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="shrink-0 self-start sm:self-center"
          >
            <Link
              to="/workflows/$resourceId"
              params={{ resourceId: hook.workflow_id }}
              data-testid="inbound-hook-admission-review"
            >
              {t(concrete ? "schedules.held.reviewRepair" : "schedules.held.reviewGrant")}
              <ArrowRight data-icon="inline-end" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          {t(concrete ? "schedules.held.concrete" : "schedules.held.authority")}
        </p>
      </CardContent>
    </Card>
  );
}
