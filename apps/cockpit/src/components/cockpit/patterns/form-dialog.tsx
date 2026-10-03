import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n-context";

export type DialogSize = "default" | "wide";

/** The two dialog widths (§4): `sm:max-w-lg`, and `sm:max-w-xl` for the approval dialog. */
export function dialogWidthClass(size: DialogSize): string {
  return size === "wide" ? "sm:max-w-xl" : "sm:max-w-lg";
}

/** Create, rename, invite and approve (P14): title · fields · Abbrechen/{Verb}. */
export function FormDialog({
  open,
  onOpenChange,
  title,
  submit,
  onSubmit,
  size = "default",
  testId,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  submit: { label: string; pending?: boolean; disabled?: boolean };
  onSubmit(): void | Promise<void>;
  size?: DialogSize;
  testId: string;
  /** The fields. */
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={dialogWidthClass(size)}
        closeLabel={t("common.close")}
        aria-describedby={undefined}
        data-testid={testId}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle data-testid={`${testId}-title`}>{title}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">{children}</div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={submit.pending}
              onClick={() => onOpenChange(false)}
              data-testid={`${testId}-cancel`}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={submit.pending || submit.disabled}
              data-testid={`${testId}-submit`}
            >
              {submit.label}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
