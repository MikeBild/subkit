import { AlertTriangle, ArrowRight, CircleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";

export interface AttentionListItem {
  id: string;
  tone: "critical" | "warning";
  /** The cockpit's own sentence. */
  text: string;
  /** Free text the engine wrote, shown on its own line as the engine's wording — never as ours. */
  engineWording: string | null;
  /** A browser address (already absolute), or null when there is nowhere to go. */
  href: string | null;
  actionLabel: string | null;
}

/**
 * Problems first, and nothing when there are none.
 *
 * Not an "all good" card: a healthy installation has nothing to say here, and
 * a block that is always present teaches the reader to skip it. Each line says
 * what is wrong and, where there is one, the one way to the place it is fixed.
 */
export function AttentionList({
  items,
  title,
  testId = "attention-list",
}: {
  items: readonly AttentionListItem[];
  title?: string;
  testId?: string;
}) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <Card data-testid={testId} data-family-slot="attention">
      {title ? (
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">{title}</h2>
          </CardTitle>
        </CardHeader>
      ) : null}
      <CardContent>
        <ul className="grid gap-2">
          {items.map((item, index) => {
            const Icon = item.tone === "critical" ? CircleAlert : AlertTriangle;
            return (
              <li
                key={item.id}
                className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3"
                data-testid={`${testId}-item-${index}`}
                data-tone={item.tone}
              >
                <span className="flex min-w-0 items-start gap-2 text-sm">
                  <Icon
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      item.tone === "critical"
                        ? "text-red-700 dark:text-red-400"
                        : "text-amber-700 dark:text-amber-400",
                    )}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="min-w-0 break-words">{item.text}</span>
                    {item.engineWording ? (
                      <span
                        className="min-w-0 break-words text-xs text-muted-foreground"
                        data-testid={`${testId}-engine-wording-${index}`}
                      >
                        {t("common.engineWording", { text: item.engineWording })}
                      </span>
                    ) : null}
                  </span>
                </span>
                {item.href && item.actionLabel ? (
                  <a
                    href={item.href}
                    className="inline-flex shrink-0 items-center gap-1 text-sm font-medium underline underline-offset-4"
                    data-testid={`${testId}-link-${index}`}
                  >
                    {item.actionLabel}
                    <ArrowRight aria-hidden="true" className="size-3.5" />
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
