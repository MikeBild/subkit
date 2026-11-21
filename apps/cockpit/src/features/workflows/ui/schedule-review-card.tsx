import { Link } from "@tanstack/react-router";
import { Badge } from "@ui/atoms/badge";
import { Button } from "@ui/atoms/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ui/molecules/card";
import { ArrowRight, Clock3 } from "lucide-react";
import type { HeldSchedule } from "@/api/decisions";
import { useI18n } from "@/lib/i18n-context";

export function ScheduleReviewCard({ schedule }: { schedule: HeldSchedule }) {
  const { t, dateTime } = useI18n();
  const concrete = schedule.admission_hold?.reason_code === "execution_authority_required";
  const prepared = Boolean(schedule.prepared_version_id);
  return (
    <Card size="sm" data-testid="schedule-admission-held">
      <CardHeader>
        <div className="flex min-w-0 flex-col items-start gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">
                <Clock3 data-icon="inline-start" />
                {t("schedules.held.status")}
              </Badge>
              <Badge variant="outline">{schedule.execution_mode.toUpperCase()}</Badge>
            </div>
            <CardTitle>
              <h3 className="break-words">
                {schedule.workflow_name ?? schedule.workflow_slug ?? t("schedules.held.title")}
              </h3>
            </CardTitle>
            <CardDescription>
              {t(
                prepared
                  ? "schedules.held.preparedShort"
                  : concrete
                    ? "schedules.held.concreteShort"
                    : "schedules.held.authorityShort",
              )}
            </CardDescription>
            {schedule.admission_hold?.observed_at && (
              <p className="text-muted-foreground text-xs" data-testid="schedule-admission-since">
                {t("schedules.held.since", {
                  when: dateTime(schedule.admission_hold.observed_at),
                })}
              </p>
            )}
          </div>
          <Button asChild variant="outline" size="sm" className="w-fit">
            <Link
              to="/workflows/$resourceId"
              params={{ resourceId: schedule.workflow_id }}
              data-testid="schedule-admission-review"
            >
              {t(
                prepared
                  ? "schedules.held.reviewPrepared"
                  : concrete
                    ? "schedules.held.reviewRepair"
                    : "schedules.held.reviewGrant",
              )}
              <ArrowRight data-icon="inline-end" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <details data-testid="schedule-admission-details">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            {t("schedules.held.details")}
          </summary>
          <div className="mt-2 flex flex-col gap-2 text-sm text-muted-foreground">
            <p>{t(concrete ? "schedules.held.concrete" : "schedules.held.authority")}</p>
            {prepared && <p>{t("schedules.held.prepared")}</p>}
            <p className="break-words">
              {t("schedules.held.schedule")}: <code>{schedule.cron}</code> · {schedule.timezone}
            </p>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
