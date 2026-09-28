import { type ReactNode, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n-context";

/**
 * An action with real effects, taken only after its consequence was read.
 *
 * `consequence` is REQUIRED on purpose: a confirmation that asks "Are you
 * sure?" confirms nothing, because the reader is never told what they are
 * agreeing to. The dialog says what will happen, in a sentence, and the
 * confirm button names the act (§8.3), never "OK".
 *
 * The confirm button is disabled while the action runs, so a double click
 * cannot start the effect twice.
 */
export function ConfirmAction({
  triggerLabel,
  title,
  consequence,
  confirmLabel,
  onConfirm,
  pending,
  error,
  testId,
  triggerVariant = "outline",
}: {
  triggerLabel: ReactNode;
  title: string;
  /** What happens when the reader confirms — the effect, not a question. */
  consequence: ReactNode;
  confirmLabel: string;
  onConfirm(): Promise<unknown> | undefined;
  pending: boolean;
  /** A failure sentence to show in place, or null. */
  error: string | null;
  testId: string;
  triggerVariant?: "outline" | "default" | "secondary";
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(value) => !pending && setOpen(value)}>
      <Button
        variant={triggerVariant}
        size="sm"
        onClick={() => setOpen(true)}
        data-testid={`${testId}-open`}
      >
        {triggerLabel}
      </Button>
      <DialogContent closeLabel={t("common.close")} data-testid={`${testId}-dialog`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription data-testid={`${testId}-consequence`}>{consequence}</DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive" data-testid={`${testId}-error`}>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => setOpen(false)}
            data-testid={`${testId}-cancel`}
          >
            {t("common.cancel")}
          </Button>
          <Button
            disabled={pending}
            onClick={() => {
              void Promise.resolve(onConfirm()).then(
                () => setOpen(false),
                () => {
                  // The caller's `error` says what went wrong; the dialog stays
                  // open so the sentence is read where the act was taken.
                },
              );
            }}
            data-testid={`${testId}-confirm`}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
