import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useI18n } from "@/lib/i18n-context";

/**
 * A confirmation that says what happens next.
 *
 * `consequence` is required on purpose: "Bist du sicher?" asks the reader to
 * know the effect already. A rotation that keeps the old key alive for an
 * hour, a revocation that breaks every script using the key, an application
 * that loses access for everyone who approved it — the dialog states it, in
 * one sentence, before the button that causes it (§5: destructive actions
 * live in the ⋯ menu and are confirmed there).
 */
export function ConfirmAction({
  open,
  onOpenChange,
  title,
  consequence,
  confirmLabel,
  onConfirm,
  pending = false,
  destructive = true,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What changes, for whom, and when — never a bare "are you sure?". */
  consequence: string;
  /** Names the action ("Widerrufen", "Rotieren"), never "OK". */
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  destructive?: boolean;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription data-testid={`${testId}-consequence`}>
            {consequence}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid={`${testId}-cancel`}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={onConfirm}
            data-testid={`${testId}-confirm`}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
