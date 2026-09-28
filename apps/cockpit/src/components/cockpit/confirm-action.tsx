import type { ReactNode } from "react";
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
  onConfirm(): void;
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  testId?: string;
}) {
  const { t } = useI18n();
  return (
    <AlertDialog
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
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
          <AlertDialogCancel data-testid={`${testId}-cancel`}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={tone === "destructive" ? "destructive" : "default"}
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
