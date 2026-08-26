import type { ErrorComponentProps } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n-context";

/**
 * What a reader meets when a page fails to render.
 *
 * The router shipped its own default and nobody replaced it, so a single
 * unguarded property access on the knowledge page put "Something went wrong! /
 * Show Error" on screen — unstyled, English, and with the whole cockpit gone:
 * no sidebar, no product name, no way anywhere. §4 asks a failure to keep a way
 * out, and §5 asks it to be in the reader's language; that default answered
 * neither.
 *
 * The stack stays, one disclosure deep. A person reporting the fault needs
 * something to quote, and hiding it would trade an unreadable screen for an
 * unreportable one.
 */
export function ErrorScreen({ error, reset }: ErrorComponentProps) {
  const { t } = useI18n();
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return (
    <main className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-6">
      <Alert variant="destructive" className="max-w-2xl" data-testid="error-screen">
        <AlertTitle>{t("error.title")}</AlertTitle>
        <AlertDescription>{t("error.description")}</AlertDescription>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={reset} data-testid="error-retry">
            {t("session.retry")}
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href="/cockpit" data-testid="error-home">
              {t("error.backToOverview")}
            </a>
          </Button>
        </div>
        <details className="mt-4 text-xs" data-testid="error-detail">
          <summary className="cursor-pointer select-none">{t("error.detail")}</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words font-mono">{detail}</pre>
        </details>
      </Alert>
    </main>
  );
}
