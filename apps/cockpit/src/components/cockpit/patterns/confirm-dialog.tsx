import { useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

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
 * line of consequence, Abbrechen and the verb itself as the button.
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
      <AlertDialogContent data-testid={testId} className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle data-testid={`${testId}-title`}>
            {confirmTitle(t, locale, object, verb)}
          </AlertDialogTitle>
          <AlertDialogDescription>{consequence}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="ghost" disabled={working} data-testid={`${testId}-cancel`}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <Button
            variant={destructive ? "destructive" : "default"}
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
