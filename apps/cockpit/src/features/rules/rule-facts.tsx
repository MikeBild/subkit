import { cn } from "@ui/lib/utils";
import { CalendarClock, FileText, Gauge, type LucideIcon, Mail, Plug, Route } from "lucide-react";
import type { ApprovalRule } from "@/api/approval-rules";
import { Chip } from "@/components/cockpit/patterns";
import { type RuleFact, ruleFacts } from "@/features/rules/model/rules";
import { useI18n } from "@/lib/i18n-context";

const FACT_ICON: Readonly<Record<RuleFact["id"], LucideIcon>> = {
  connector: Plug,
  operation: Route,
  recipients: Mail,
  content: FileText,
  validity: CalendarClock,
  today: Gauge,
};

export function RuleFacts({
  rule,
  testId,
}: {
  rule: Pick<
    ApprovalRule,
    | "connector"
    | "operation"
    | "target"
    | "recipients"
    | "content_class"
    | "state"
    | "expired"
    | "expires_at"
    | "daily_limit"
    | "uses_today"
  >;
  testId: string;
}) {
  const { t, dateTime } = useI18n();
  return (
    <ul className="flex flex-wrap gap-1.5" data-testid={`${testId}-facts`}>
      {ruleFacts(rule as ApprovalRule, t, dateTime).map((fact) => {
        const Icon = FACT_ICON[fact.id];
        return (
          <li key={fact.id}>
            <Chip
              size="md"
              title={`${fact.label}: ${fact.value}`}
              className={cn(
                "min-w-0 [overflow-wrap:anywhere]",
                fact.id === "validity" && rule.state === "active" && rule.expired
                  ? "border-amber-500/50 text-amber-800 dark:text-amber-300"
                  : null,
              )}
              testId={`${testId}-${fact.id}`}
            >
              <Icon aria-hidden="true" className="text-muted-foreground" />
              <span className="sr-only">{fact.label}: </span>
              <span>{fact.short}</span>
            </Chip>
          </li>
        );
      })}
    </ul>
  );
}
