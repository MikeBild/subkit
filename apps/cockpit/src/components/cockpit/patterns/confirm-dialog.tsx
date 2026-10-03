import { useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import {
  DIALOG_DESCRIPTION,
  DIALOG_FOOT,
  DIALOG_FRAME,
  DIALOG_HEAD,
  DIALOG_TITLE,
  DialogTitleRow,
  dialogWidthClass,
  FILLED_DESTRUCTIVE,
} from "./dialog-frame";

/**
 * "{Objekt} {verb}?" in German, "{Verb} {object}?" in English. The verb stands
 * capitalised on the button; inside a German sentence it is lower-cased.
 */
export function confirmTitle(
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
  locale: Locale,
  object: string,
  verb: string,
): string {
  const inSentence =
    locale === "de" ? verb.charAt(0).toLocaleLowerCase("de") + verb.slice(1) : verb;
  return t("pattern.confirm.title", { object, verb: inSentence });
}

/**
 * Every irreversible or consequential act (P13): title "{Objekt} {verb}?", one
 * line of consequence, Abbrechen and the verb itself as the button — filled,
 * red where it removes. The frame is FormDialog's: one width, and a sheet
 * from the bottom edge under 640px.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  object,
  verb,
  consequence,
  destructive = false,
  pending = false,
  onConfirm,
  testId,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  object: string;
  /** Capitalised, as it stands on the button: "Widerrufen". */
  verb: string;
  /** One line. */
  consequence: string;
  /** Only where the act cannot be undone. */
  destructive?: boolean;
  pending?: boolean;
  onConfirm(): void | Promise<void>;
  testId: string;
}) {
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const working = pending || busy;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        data-testid={testId}
        className={cn(dialogWidthClass("default"), DIALOG_FRAME)}
      >
        <div className={DIALOG_HEAD} data-slot="dialog-head">
          <DialogTitleRow
            title={
              <AlertDialogTitle className={DIALOG_TITLE} data-testid={`${testId}-title`}>
                {confirmTitle(t, locale, object, verb)}
              </AlertDialogTitle>
            }
            closeLabel={t("common.close")}
            onClose={() => onOpenChange(false)}
            disabled={working}
            testId={testId}
          />
          <AlertDialogDescription
            className={DIALOG_DESCRIPTION}
            data-testid={`${testId}-consequence`}
          >
            {consequence}
          </AlertDialogDescription>
        </div>
        <AlertDialogFooter className={DIALOG_FOOT}>
          <AlertDialogCancel variant="ghost" disabled={working} data-testid={`${testId}-cancel`}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <Button
            variant="default"
            className={destructive ? FILLED_DESTRUCTIVE : undefined}
            disabled={working}
            data-testid={`${testId}-confirm`}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {verb}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
