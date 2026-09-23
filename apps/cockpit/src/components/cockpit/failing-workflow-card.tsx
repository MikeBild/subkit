import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { FailingWorkflow } from "@/lib/failing-workflows";
import { useI18n } from "@/lib/i18n-context";

/**
 * A workflow that was approved, runs on time, and fails every time.
 *
 * The card says the three things that decide what to do: which step, how often,
 * and what the engine made of the error. The link leads to those runs alone —
 * the number that came closest to this before pointed at eleven thousand rows.
 */
export function FailingWorkflowCard({ failing }: { failing: FailingWorkflow }) {
  const { t, dateTime } = useI18n();
  return (
    <Card size="sm" data-testid="decision-failing-workflow">
      <CardHeader>
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="destructive">
                <AlertTriangle data-icon="inline-start" />
                {t("decisions.failing.status")}
              </Badge>
              <Badge variant="outline">
                {t("decisions.failing.count", { count: String(failing.count) })}
              </Badge>
            </div>
            <CardTitle>
              <h3 className="break-words">
                {failing.workflow_name ?? t("decisions.failing.unnamed")}
              </h3>
            </CardTitle>
            <CardDescription>
              {failing.step_key
                ? t("decisions.failing.atStep", { step: failing.step_key })
                : t("decisions.failing.description")}
            </CardDescription>
            <p className="text-muted-foreground text-xs" data-testid="decision-failing-since">
              {t("decisions.failing.lastSeen", { when: dateTime(failing.last_seen) })}
            </p>
          </div>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="shrink-0 self-start sm:self-center"
          >
            {/* A relative link, not a router route: the runs page reads the
                filter from the query string, which is what makes this land on
                these runs instead of on all of them. */}
            <Link to={failing.runs_href} data-testid="decision-failing-runs">
              {t("decisions.failing.openRuns")}
              <ArrowRight data-icon="inline-end" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm">{failing.cause}</p>
        {failing.guidance && (
          <p className="mt-2 text-sm text-muted-foreground" data-testid="decision-failing-guidance">
            {failing.guidance}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
