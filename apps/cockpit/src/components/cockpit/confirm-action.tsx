import { type MouseEvent, type ReactNode, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "@/lib/i18n-context";

/**
 * An act with real effects, taken only after its consequence was read.
 *
 * `consequence` is required on purpose. A confirmation that only asks "Are
 * you sure?" — or repeats the button ("Rolle ändern?") — asks the reader to
 * agree to a word; the sentence under the title is what they are agreeing to:
 * what changes, for whom, and when. The confirm button names the act
 * ("Widerrufen", "Rotieren", §8.3), never "OK".
 *
 * Three ways to open it. `triggerLabel` renders the asking button itself
 * (`${testId}-open`); `trigger` wraps an element the caller already has (a
 * button in a row). A caller whose act starts somewhere a trigger cannot sit —
 * a Select that has already picked the new value, a ⋯ menu item — holds `open`
 * itself and passes `onOpenChange`.
 *
 * `onConfirm` may return a promise. The dialog then stays open, both buttons
 * disabled, until it settles: closed on success, still open on failure with
 * the refusal next to what was tried (`error` when the caller words it, a
 * generic sentence otherwise). Closing at the click hid a failed change behind
 * a dialog that looked like it had worked. A plain return closes at once.
 */
export function ConfirmAction({
  title,
  consequence,
  confirmLabel,
  tone = "default",
  onConfirm,
  pending: externalPending = false,
  error,
  trigger,
  triggerLabel,
  triggerVariant = "outline",
  open,
  onOpenChange,
  testId = "confirm-action",
}: {
  title: string;
  /** What happens when the reader confirms — the effect, not a question. */
  consequence: ReactNode;
  confirmLabel: string;
  tone?: "default" | "destructive";
  onConfirm(): unknown;
  /** A pending state the caller tracks itself; OR-ed with the dialog's own. */
  pending?: boolean;
  /** The caller's wording of a failure, shown after a confirm was refused. */
  error?: string | null;
  trigger?: ReactNode;
  triggerLabel?: ReactNode;
  triggerVariant?: "outline" | "default" | "secondary";
  open?: boolean;
  onOpenChange?(open: boolean): void;
  testId?: string;
}) {
  const { t } = useI18n();
  const [ownOpen, setOwnOpen] = useState(false);
  const [ownPending, setOwnPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = ownPending || externalPending;
  const isOpen = open ?? ownOpen;
  const setOpen = (next: boolean) => {
    if (pending && !next) return;
    // A refusal belongs to the attempt it answered, not to the next opening.
    setFailed(false);
    if (open === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  const confirm = async (event: MouseEvent) => {
    event.preventDefault();
    if (pending) return;
    setFailed(false);
    const result = onConfirm();
    if (!(result instanceof Promise)) {
      setOpen(false);
      return;
    }
    setOwnPending(true);
    try {
      await result;
      setOwnPending(false);
      if (open === undefined) setOwnOpen(false);
      onOpenChange?.(false);
    } catch {
      // Stays open: the refusal is read where the act was taken.
      setOwnPending(false);
      setFailed(true);
    }
  };
  const asking =
    trigger ??
    (triggerLabel !== undefined ? (
      <Button variant={triggerVariant} size="sm" data-testid={`${testId}-open`}>
        {triggerLabel}
      </Button>
    ) : null);
  return (
    <AlertDialog open={isOpen} onOpenChange={setOpen}>
      {asking ? <AlertDialogTrigger asChild>{asking}</AlertDialogTrigger> : null}
      <AlertDialogContent data-testid={testId} aria-busy={pending || undefined}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid gap-2" data-testid={`${testId}-consequence`}>
              {consequence}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failed ? (
          <Alert variant="destructive" data-testid={`${testId}-error`}>
            <AlertDescription>{error || t("common.actionFailed")}</AlertDescription>
          </Alert>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} data-testid={`${testId}-cancel`}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={tone === "destructive" ? "destructive" : "default"}
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={(event) => void confirm(event)}
            data-testid={`${testId}-confirm`}
          >
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
