import { type MouseEvent, type ReactNode, useState } from "react";
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
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "@/lib/i18n-context";

/**
 * One act that changes who may do what, asked about once, with its consequence.
 *
 * `consequence` is required on purpose. A confirmation that only repeats the
 * button ("Rolle ändern?") asks the reader to agree to a word; the sentence
 * under the title is what they are agreeing to — what someone can do
 * afterwards, or can no longer do. A dialog without it is a speed bump, not a
 * decision.
 *
 * Two ways to open it. `trigger` wraps the element that asks (a button in a
 * row). A caller whose act starts somewhere a trigger cannot sit — a Select
 * that has already picked the new value — holds `open` itself and passes
 * `onOpenChange`.
 *
 * `onConfirm` may return a promise. The dialog then stays open, both buttons
 * disabled, until it settles: closed on success, still open on failure so the
 * reader sees the refusal next to what they tried. Closing at the click hid a
 * failed change behind a dialog that looked like it had worked.
 */
export function ConfirmAction({
  title,
  consequence,
  confirmLabel,
  tone = "default",
  onConfirm,
  trigger,
  open,
  onOpenChange,
  testId = "confirm-action",
}: {
  title: string;
  consequence: ReactNode;
  confirmLabel: string;
  tone?: "default" | "destructive";
  onConfirm(): unknown;
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  testId?: string;
}) {
  const { t } = useI18n();
  const [ownOpen, setOwnOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const isOpen = open ?? ownOpen;
  const setOpen = (next: boolean) => {
    if (pending && !next) return;
    if (open === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  const confirm = async (event: MouseEvent) => {
    event.preventDefault();
    const result = onConfirm();
    if (!(result instanceof Promise)) {
      setOpen(false);
      return;
    }
    setPending(true);
    try {
      await result;
      setPending(false);
      if (open === undefined) setOwnOpen(false);
      onOpenChange?.(false);
    } catch {
      // Stays open: the caller reports why, and the reader can cancel.
      setPending(false);
    }
  };
  return (
    <AlertDialog open={isOpen} onOpenChange={setOpen}>
      {trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}
      <AlertDialogContent data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid gap-2" data-testid={`${testId}-consequence`}>
              {consequence}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
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
