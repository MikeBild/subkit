import { ArrowRight, CircleAlert, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { absolute } from "@/app/links";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";

export interface CauseFixAction {
  label: string;
  /** A router-relative address from a `links.ts` builder. */
  href?: string;
  onClick?: () => void;
}

/**
 * Error → cause → fix, in one block.
 *
 * The family rule is "kein Rot ohne Weg zur Ursache" (§1). A red dot that says
 * "failed" and nothing else sends the reader hunting; this block says what the
 * state is, why, what the connector suggested, since when, and offers the ONE
 * next step — plus a few quieter ways further (the audit trail, the run list).
 *
 * `cause` is the cockpit's own sentence. `guidance` is text a connector author
 * or the engine wrote, and is marked as such.
 */
export function CauseFix({
  status,
  cause,
  guidance,
  since,
  remedy,
  remedyVariant = "default",
  more,
  actions,
  testId = "cause-fix",
}: {
  status: { tone: "critical" | "warning"; label: string };
  cause: ReactNode;
  guidance?: string | null;
  since?: string | null;
  remedy?: CauseFixAction | null;
  /**
   * How the remedy weighs on its surface. Filled where it is the surface's one
   * primary act (a run's sheet); `outline` on a page that already has one.
   */
  remedyVariant?: "default" | "outline";
  more?: readonly { label: string; href: string }[];
  /** Further acts beside the remedy (a rerun) — each brings its own confirmation. */
  actions?: ReactNode;
  testId?: string;
}) {
  const { t } = useI18n();
  const Icon = status.tone === "critical" ? CircleAlert : TriangleAlert;
  return (
    <section
      className={cn(
        "grid gap-2 rounded-lg border p-3",
        status.tone === "critical"
          ? "border-destructive/40 bg-destructive/5"
          : "border-amber-500/40 bg-amber-500/5",
      )}
      data-testid={testId}
      data-tone={status.tone}
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <Icon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0",
            status.tone === "critical"
              ? "text-red-700 dark:text-red-400"
              : "text-amber-700 dark:text-amber-400",
          )}
        />
        <span data-testid={`${testId}-status`}>{status.label}</span>
        {since ? <span className="font-normal text-muted-foreground">· {since}</span> : null}
      </p>
      <p className="text-sm break-words" data-testid={`${testId}-cause`}>
        {cause}
      </p>
      {guidance ? (
        <p className="text-xs break-words text-muted-foreground" data-testid={`${testId}-guidance`}>
          {t("common.engineWording", { text: guidance })}
        </p>
      ) : null}
      {remedy || actions || (more && more.length > 0) ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
          {remedy?.href ? (
            <Button asChild size="sm" variant={remedyVariant}>
              <a href={absolute(remedy.href)} data-testid={`${testId}-remedy`}>
                {remedy.label}
                <ArrowRight data-icon="inline-end" />
              </a>
            </Button>
          ) : remedy?.onClick ? (
            <Button
              size="sm"
              variant={remedyVariant}
              onClick={remedy.onClick}
              data-testid={`${testId}-remedy`}
            >
              {remedy.label}
            </Button>
          ) : null}
          {actions}
          {more?.map((link, index) => (
            <a
              key={link.href}
              href={absolute(link.href)}
              className="text-sm underline underline-offset-4"
              data-testid={`${testId}-more-${index}`}
            >
              {link.label}
            </a>
          ))}
        </div>
      ) : null}
    </section>
  );
}
