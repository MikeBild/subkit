import { useState } from "react";

export interface ConfirmDialogState {
  open: boolean;
  onOpenChange(open: boolean): void;
}

export interface ConfirmTarget<T> {
  target: T | null;
  ask(next: T): void;
  close(): void;
  dialog(options?: { only?: T; locked?: boolean }): ConfirmDialogState;
}

export function confirmOpen<T>(target: T | null, only?: T): boolean {
  return target !== null && (only === undefined || Object.is(target, only));
}

export function useConfirmTarget<T>(): ConfirmTarget<T> {
  const [target, setTarget] = useState<T | null>(null);
  const close = () => setTarget(null);
  return {
    target,
    ask: (next) => setTarget(() => next),
    close,
    dialog: ({ only, locked = false } = {}) => ({
      open: confirmOpen(target, only),
      onOpenChange: (open) => {
        if (!open && !locked) close();
      },
    }),
  };
}
