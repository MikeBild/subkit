import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { FormDialog } from "@/components/cockpit/patterns/form-dialog";

export function WorkspaceConfirmation({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel,
  pending,
  disabled,
  destructive = true,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  pending: boolean;
  disabled?: boolean;
  destructive?: boolean;
  onConfirm(): void;
  children?: ReactNode;
}) {
  return (
    <FormDialog
      open={open}
      onOpenChange={(value) => {
        if (!pending) onOpenChange(value);
      }}
      title={title}
      description={description}
      testId="workspace-confirmation"
      cancelTestId="workspace-confirm-cancel"
      submit={{
        label: (
          <>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {pending ? pendingLabel : confirmLabel}
          </>
        ),
        testId: "workspace-confirm-submit",
        pending,
        disabled,
        destructive,
      }}
      onSubmit={() => {
        if (!pending && !disabled) onConfirm();
      }}
    >
      {children}
    </FormDialog>
  );
}
