import { ChevronLeft, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/cockpit/icon-button";

export type DialogSize = "default" | "wide";

export function dialogWidthClass(size: DialogSize): string {
  return size === "wide" ? "sm:max-w-xl" : "sm:max-w-lg";
}

export const DIALOG_FRAME =
  "flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden bg-background p-0 max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-h-[calc(100dvh-1.5rem)] max-sm:w-full max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)]";

export const REVIEW_DIALOG_FRAME =
  "flex max-h-[calc(100dvh-24px)] w-[calc(100%-24px)] max-w-[720px] flex-col gap-0 overflow-hidden border border-border bg-background p-0 md:max-h-[calc(100dvh-48px)] sm:max-w-[720px] ring-0";

export const DIALOG_HEAD =
  "grid flex-none gap-1 px-6 pt-5 pb-4 max-sm:px-4 max-sm:pt-4 max-sm:pb-3";
export const DIALOG_TITLE =
  "min-w-0 text-lg leading-7 font-semibold tracking-tight [overflow-wrap:anywhere]";
export const DIALOG_DESCRIPTION = "text-sm text-muted-foreground";
export const DIALOG_BODY =
  "grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-4 overflow-auto overflow-x-hidden px-6 pb-6 max-sm:px-4 max-sm:pb-5 [&_[data-slot=segmented-control]]:flex [&_[data-slot=segmented-control]]:w-full [&_[data-slot=segmented-control]>*]:flex-1";
export const DIALOG_ERROR = "flex-none px-6 pb-4 text-sm text-destructive max-sm:px-4 max-sm:pb-3";
export const DIALOG_FOOT =
  "m-0 flex flex-none flex-row flex-wrap justify-end gap-2 rounded-none border-t bg-transparent px-6 py-4 max-sm:px-4 max-sm:py-3 sm:flex-row sm:justify-end";

export const FILLED_DESTRUCTIVE =
  "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/40";

export function DialogBack({
  label,
  onClick,
  disabled,
  testId,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="-ml-1 mb-1 flex min-h-8 w-fit items-center gap-0.5 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      data-slot="dialog-back"
      data-testid={testId}
    >
      <ChevronLeft className="size-4" aria-hidden="true" />
      {label}
    </button>
  );
}

export function DialogTitleRow({
  title,
  closeLabel,
  onClose,
  disabled,
  testId,
}: {
  title: ReactNode;
  closeLabel: string;
  onClose(): void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3">
      {title}
      <IconButton
        type="button"
        label={closeLabel}
        className="-mt-0.5 -mr-2 flex-none"
        onClick={onClose}
        disabled={disabled}
        data-testid={`${testId}-close`}
      >
        <XIcon />
      </IconButton>
    </div>
  );
}
