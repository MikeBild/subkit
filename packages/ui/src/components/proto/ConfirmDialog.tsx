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
} from "@ui/components/ui/alert-dialog";
import { useI18n } from "@ui/lib/ui-context";
import type { ReactNode } from "react";

export function ConfirmDialog({
  trigger,
  open,
  onOpenChange,
  title,
  body,
  action,
  onConfirm,
}: {
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  title: string;
  body: ReactNode;
  action: string;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <AlertDialog
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t.common.cancel}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onConfirm}
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
