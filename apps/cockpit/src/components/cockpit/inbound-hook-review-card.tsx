import { Clock3 } from "lucide-react";
import type { InboundHookAutomation } from "@/api/decisions";
import { AutomationGrant } from "@/components/cockpit/automation-grant";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n-context";

export function InboundHookReviewCard({ hook }: { hook: InboundHookAutomation }) {
  const { t, dateTime } = useI18n();
  const concrete = hook.admission_hold?.reason_code === "execution_authority_required";
  return (
    <Card size="sm" data-testid="inbound-hook-admission-held">
      <CardHeader>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">
              <Clock3 data-icon="inline-start" />
              {t("hooks.held.status")}
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
            <p className="text-muted-foreground text-xs" data-testid="inbound-hook-admission-since">
              {t("hooks.held.since", { when: dateTime(hook.admission_hold.observed_at) })}
              {hook.last_refused_at
                ? ` · ${t("hooks.held.lastRefused", { when: dateTime(hook.last_refused_at) })}`
                : ""}
            </p>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground" data-testid="inbound-hook-admission-reason">
          {t(concrete ? "hooks.held.concrete" : "hooks.held.authority")}
        </p>
        <div className="w-fit">
          <AutomationGrant
            workflowId={hook.workflow_id}
            environment={hook.environment}
            testId="inbound-hook-admission-review"
            triggerLabel={t("hooks.held.review")}
          />
        </div>
      </CardContent>
    </Card>
  );
}
