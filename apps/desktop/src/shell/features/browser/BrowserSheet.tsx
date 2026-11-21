import { Button } from "@ui/atoms/button";
import { Check, CircleAlert, Lock, RotateCw } from "lucide-react";
import { sheetAddress, sheetSubject } from "../../../shared/browser-sheet-model.ts";
import { useI18n, useShell } from "../../adapter/use-shell.tsx";

export function BrowserSheet() {
  const { s, a } = useShell();
  const { t } = useI18n();
  const sh = s.ui.sheet;
  if (!sh) return null;
  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center bg-foreground/20 p-4 pt-16">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("browser.label")}
        className="w-full max-w-[640px] overflow-hidden rounded-dialog border bg-background shadow-window"
      >
        <div className="flex items-center gap-2 border-b bg-secondary px-3 py-2">
          <div className="flex gap-2" aria-hidden>
            <span className="size-2.5 rounded-full bg-tl-red" />
            <span className="size-2.5 rounded-full bg-tl-yellow" />
            <span className="size-2.5 rounded-full bg-tl-green" />
          </div>
          <RotateCw className="ml-2 size-3.5 text-muted-foreground" aria-hidden />
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-2 py-1">
            <Lock
              className={
                sh.secure
                  ? "size-4 shrink-0 text-success-ink"
                  : "size-4 shrink-0 text-muted-foreground"
              }
              aria-hidden
            />
            <span className="truncate font-mono text-xs">{sheetAddress(sh)}</span>
          </div>
        </div>
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">{t("browser.label")}</p>
        <div className="space-y-4 p-6">
          {sh.phase === "succeeded" ? (
            <div role="status" className="flex items-center gap-3 text-sm">
              <Check className="size-4 text-success-ink" aria-hidden />
              <span>{t("browser.succeeded")}</span>
            </div>
          ) : sh.phase === "failed" ? (
            <div role="alert" className="flex items-center gap-3 text-sm text-destructive-ink">
              <CircleAlert className="size-4" aria-hidden />
              <span>{t("browser.failed")}</span>
              {sh.reason && (
                <span className="font-mono text-xs text-muted-foreground">{sh.reason}</span>
              )}
            </div>
          ) : (
            <>
              <h2 className="text-xl font-semibold">
                {t("browser.reauthTitle", { name: sheetSubject(sh) })}
              </h2>
              <p className="text-sm text-muted-foreground">{t("browser.reauthBody")}</p>
              <div className="flex flex-wrap gap-2">
                <Button data-testid="sheet-confirm" onClick={() => a.confirmSheet()}>
                  {t("browser.reauthConfirm")}
                </Button>
                <Button
                  variant="outline"
                  data-testid="sheet-cancel"
                  onClick={() => a.cancelSheet()}
                >
                  {t("browser.cancel")}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
